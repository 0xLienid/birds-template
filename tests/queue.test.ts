import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Queue } from "../src/lib/queue.js";
import { closeAll } from "../src/lib/db.js";

let queue: Queue;

beforeEach(() => {
  const dbPath = mkdtempSync(join(tmpdir(), "queue-test-"));
  queue = new Queue(dbPath);
});

afterAll(() => {
  closeAll();
});

describe("Queue", () => {
  describe("submitJob", () => {
    it("creates a new job", () => {
      const { job, isDuplicate } = queue.submitJob({ name: "Brown Pelican" });

      expect(isDuplicate).toBe(false);
      expect(job.id).toBe("brown-pelican");
      expect(job.name).toBe("Brown Pelican");
      expect(job.status).toBe("queued");
      expect(job.retryCount).toBe(0);
      expect(job.body).toEqual({});
    });

    it("returns duplicate for existing job", () => {
      queue.submitJob({ name: "Brown Pelican" });
      const { job, isDuplicate } = queue.submitJob({ name: "Brown Pelican" });

      expect(isDuplicate).toBe(true);
      expect(job.id).toBe("brown-pelican");
    });

    it("requeues a failed job", () => {
      queue.submitJob({ name: "Brown Pelican" });
      queue.failJob("brown-pelican");

      const { job, isDuplicate } = queue.submitJob({ name: "Brown Pelican" });
      expect(isDuplicate).toBe(false);
      expect(job.status).toBe("queued");
      expect(job.retryCount).toBe(0);
    });
  });

  describe("claimJob", () => {
    it("claims the next available job", () => {
      queue.submitJob({ name: "Brown Pelican" });

      const job = queue.claimJob();
      expect(job).toBeDefined();
      expect(job!.id).toBe("brown-pelican");
      expect(job!.status).toBe("processing");
    });

    it("returns undefined when queue is empty", () => {
      const job = queue.claimJob();
      expect(job).toBeUndefined();
    });

    it("does not claim a job with future timestamp", () => {
      queue.submitJob({ name: "Brown Pelican" });

      queue.claimJob();
      queue.retryJob("brown-pelican", Date.now() + 60000);

      const job = queue.claimJob();
      expect(job).toBeUndefined();
    });

    it("does not allow double-claiming", () => {
      queue.submitJob({ name: "Brown Pelican" });

      const first = queue.claimJob();
      const second = queue.claimJob();

      expect(first).toBeDefined();
      expect(second).toBeUndefined();
    });
  });

  describe("queueIndex ordering", () => {
    it("claims jobs in submission order", () => {
      queue.submitJob({ name: "Brown Pelican" });
      queue.submitJob({ name: "Bald Eagle" });
      queue.submitJob({ name: "Snowy Owl" });

      expect(queue.claimJob()!.id).toBe("brown-pelican");
      expect(queue.claimJob()!.id).toBe("bald-eagle");
      expect(queue.claimJob()!.id).toBe("snowy-owl");
      expect(queue.claimJob()).toBeUndefined();
    });

    it("claims a fresh job before a retried job with future availability", () => {
      queue.submitJob({ name: "Brown Pelican" });
      queue.claimJob();
      queue.retryJob("brown-pelican", Date.now() + 60000);

      queue.submitJob({ name: "Bald Eagle" });

      const claimed = queue.claimJob();
      expect(claimed).toBeDefined();
      expect(claimed!.id).toBe("bald-eagle");

      expect(queue.claimJob()).toBeUndefined();
    });

    it("claims the retried job once its availability time arrives", () => {
      queue.submitJob({ name: "Brown Pelican" });
      queue.claimJob();

      queue.retryJob("brown-pelican", Date.now() - 1);

      const claimed = queue.claimJob();
      expect(claimed).toBeDefined();
      expect(claimed!.id).toBe("brown-pelican");
      expect(claimed!.retryCount).toBe(1);
    });

    it("claims a resubmitted failed job immediately", () => {
      queue.submitJob({ name: "Brown Pelican" });
      queue.claimJob();
      queue.failJob("brown-pelican");

      queue.submitJob({ name: "Bald Eagle" });

      queue.submitJob({ name: "Brown Pelican" });

      const first = queue.claimJob();
      const second = queue.claimJob();

      expect(first).toBeDefined();
      expect(first!.id).toBe("bald-eagle");

      expect(second).toBeDefined();
      expect(second!.id).toBe("brown-pelican");

      expect(queue.claimJob()).toBeUndefined();
    });
  });

  describe("completeJob", () => {
    it("marks a job as completed with body", () => {
      queue.submitJob({ name: "Brown Pelican" });
      queue.claimJob();

      const job = queue.completeJob("brown-pelican", { research: "Some text" });
      expect(job).toBeDefined();
      expect(job!.status).toBe("completed");
      expect(job!.body).toEqual({ research: "Some text" });
    });
  });

  describe("retryJob", () => {
    it("requeues a job with incremented retry count", () => {
      queue.submitJob({ name: "Brown Pelican" });
      queue.claimJob();

      const nextAvailable = Date.now() + 5000;
      const job = queue.retryJob("brown-pelican", nextAvailable);

      expect(job).toBeDefined();
      expect(job!.status).toBe("queued");
      expect(job!.retryCount).toBe(1);
      expect(job!.availableForProcessingAt).toBe(nextAvailable);
    });
  });

  describe("failJob", () => {
    it("marks a job as failed", () => {
      queue.submitJob({ name: "Brown Pelican" });
      queue.claimJob();

      const job = queue.failJob("brown-pelican");
      expect(job).toBeDefined();
      expect(job!.status).toBe("failed");
    });
  });
});
