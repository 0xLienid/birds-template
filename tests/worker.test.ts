import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Queue } from "../src/lib/queue.js";
import { Observer } from "../src/observer/observer.js";
import { closeAll } from "../src/lib/db.js";
import { CONFIG } from "../src/lib/config.js";
import { computeBackoff, runWorker } from "../src/worker/worker.js";

let queue: Queue;
let observer: Observer;

beforeEach(() => {
  const queuePath = mkdtempSync(join(tmpdir(), "worker-queue-test-"));
  const observerPath = mkdtempSync(join(tmpdir(), "worker-observer-test-"));
  queue = new Queue(queuePath);
  observer = new Observer(observerPath);
});

afterAll(() => {
  closeAll();
});

describe("worker", () => {
  describe("computeBackoff", () => {
    it("returns a future timestamp", () => {
      const before = Date.now();
      const result = computeBackoff(0);
      expect(result).toBeGreaterThan(before);
    });

    it("increases with retry count", () => {
      vi.spyOn(Math, "random").mockReturnValue(0);

      const backoff0 = computeBackoff(0);
      const backoff1 = computeBackoff(1);
      const backoff2 = computeBackoff(2);

      expect(backoff1 - backoff0).toBeGreaterThan(0);
      expect(backoff2 - backoff1).toBeGreaterThan(0);

      vi.restoreAllMocks();
    });

    it("uses exponential formula: 2^(retryCount+1) * BASE_DELAY + jitter", () => {
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      const now = Date.now();
      const result = computeBackoff(2);

      // 2^(2+1) * 1000 = 8000, jitter = 0.5 * 1000 = 500
      const expectedDelay = 8000 + 500;

      // result = Date.now() + delay, allow small timing tolerance
      expect(result - now).toBeGreaterThanOrEqual(expectedDelay - 10);
      expect(result - now).toBeLessThanOrEqual(expectedDelay + 50);

      vi.restoreAllMocks();
    });
  });

  describe("runWorker", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("claims and processes a job from the queue", async () => {
      queue.submitJob({ name: "Brown Pelican" });

      // Mock fetch to return a successful Wikipedia response
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          query: {
            pages: [{ extract: "The brown pelican is a large bird." }],
          },
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      // Run one poll cycle — runWorker calls poll() once before scheduling setTimeout
      await runWorker("w-test", queue, observer);

      const job = queue.getJob("brown-pelican");
      expect(job).toBeDefined();
      expect(job!.status).toBe("completed");
      expect(job!.body).toEqual({ research: "The brown pelican is a large bird." });

      vi.unstubAllGlobals();
    });

    it("retries a job when processing fails and retryCount < MAX_RETRIES", async () => {
      queue.submitJob({ name: "Brown Pelican" });

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

      await runWorker("w-test", queue, observer);

      const job = queue.getJob("brown-pelican");
      expect(job).toBeDefined();
      expect(job!.status).toBe("queued");
      expect(job!.retryCount).toBe(1);
      expect(job!.availableForProcessingAt).toBeGreaterThan(Date.now());

      vi.unstubAllGlobals();
    });

    it("fails a job when processing fails and retryCount >= MAX_RETRIES", async () => {
      queue.submitJob({ name: "Brown Pelican" });

      for (let i = 0; i < CONFIG.MAX_RETRIES; i++) {
        const claimed = queue.claimJob();
        expect(claimed).toBeDefined();
        queue.retryJob("brown-pelican", Date.now());
      }

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("still broken")));
      vi.spyOn(console, "log").mockImplementation(() => {}); // Suppress the ALERT console.log from observer

      await runWorker("w-test", queue, observer);

      const job = queue.getJob("brown-pelican");
      expect(job).toBeDefined();
      expect(job!.status).toBe("failed");
      expect(job!.retryCount).toBe(CONFIG.MAX_RETRIES);

      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    it("does nothing when queue is empty", async () => {
      // No jobs submitted — runWorker should just return without error
      await runWorker("w-test", queue, observer);

      // Only the worker-start log should exist
      const trace = observer.getTrace("anything");
      expect(trace).toHaveLength(0);
    });

    it("logs job-claimed and job-completed on success", async () => {
      queue.submitJob({ name: "Bald Eagle" });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          query: { pages: [{ extract: "The bald eagle is a bird of prey." }] },
        }),
      }));

      await runWorker("w-test", queue, observer);

      const trace = observer.getTrace("bald-eagle");
      const actions = trace.map(e => e.action);
      expect(actions).toContain("job-claimed");
      expect(actions).toContain("job-completed");

      vi.unstubAllGlobals();
    });

    it("logs job-retry on retriable failure", async () => {
      queue.submitJob({ name: "Bald Eagle" });

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));

      await runWorker("w-test", queue, observer);

      const trace = observer.getTrace("bald-eagle");
      const retryEntry = trace.find(e => e.action === "job-retry");
      expect(retryEntry).toBeDefined();
      expect(retryEntry!.type).toBe("warning");
      expect(retryEntry!.body.workerId).toBe("w-test");
      expect(retryEntry!.body.error).toBe("timeout");

      vi.unstubAllGlobals();
    });
  });
});
