import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/index.js";
import { Queue } from "../src/lib/queue.js";
import { Observer } from "../src/observer/observer.js";
import { closeAll } from "../src/lib/db.js";
import type { Server } from "node:http";

let server: Server;
let baseUrl: string;
let queue: Queue;
let observer: Observer;

beforeEach(async () => {
  const queuePath = mkdtempSync(join(tmpdir(), "api-queue-test-"));
  const observerPath = mkdtempSync(join(tmpdir(), "api-observer-test-"));

  queue = new Queue(queuePath);
  observer = new Observer(observerPath);
  const app = createApp(queue, observer);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        baseUrl = `http://localhost:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
  closeAll();
});

describe("API", () => {
  describe("POST /bird", () => {
    it("creates a new job and returns 201", async () => {
      const res = await fetch(`${baseUrl}/bird`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Brown Pelican" }),
      });

      expect(res.status).toBe(201);

      const data = await res.json();
      expect(data.id).toBe("brown-pelican");
      expect(data.name).toBe("Brown Pelican");
      expect(data.status).toBe("queued");
      expect(data.createdAt).toBeDefined();
    });

    it("returns 200 for duplicate", async () => {
      await fetch(`${baseUrl}/bird`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Brown Pelican" }),
      });

      const res = await fetch(`${baseUrl}/bird`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Brown Pelican" }),
      });

      expect(res.status).toBe(200);
    });

    it("returns 400 when name is missing", async () => {
      const res = await fetch(`${baseUrl}/bird`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 when name is not a string", async () => {
      const res = await fetch(`${baseUrl}/bird`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: 123 }),
      });
      expect(res.status).toBe(400);
    });

    it("logs job-submitted on new job", async () => {
      await fetch(`${baseUrl}/bird`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Brown Pelican" }),
      });

      const trace = observer.getTrace("brown-pelican");
      const submitted = trace.find(e => e.action === "job-submitted");
      expect(submitted).toBeDefined();
      expect(submitted!.type).toBe("log");
      expect(submitted!.body.jobId).toBe("brown-pelican");
      expect(submitted!.body.name).toBe("Brown Pelican");
    });

    it("logs job-duplicate on duplicate submission", async () => {
      await fetch(`${baseUrl}/bird`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Brown Pelican" }),
      });
      await fetch(`${baseUrl}/bird`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Brown Pelican" }),
      });

      const trace = observer.getTrace("brown-pelican");
      const duplicate = trace.find(e => e.action === "job-duplicate");
      expect(duplicate).toBeDefined();
      expect(duplicate!.type).toBe("log");
      expect(duplicate!.body.jobId).toBe("brown-pelican");
      expect(duplicate!.body.name).toBe("Brown Pelican");
      expect(duplicate!.body.currentStatus).toBe("queued");
    });
  });

  describe("GET /bird", () => {
    it("returns 404 when job does not exist", async () => {
      const res = await fetch(`${baseUrl}/bird?name=Brown+Pelican`);
      expect(res.status).toBe(404);
    });

    it("returns 404 when job is not completed", async () => {
      await fetch(`${baseUrl}/bird`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Brown Pelican" }),
      });

      const res = await fetch(`${baseUrl}/bird?name=Brown+Pelican`);
      expect(res.status).toBe(404);
    });

    it("returns completed job", async () => {
      await fetch(`${baseUrl}/bird`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Brown Pelican" }),
      });

      queue.claimJob();
      queue.completeJob("brown-pelican", { research: "Some research text" });

      const res = await fetch(`${baseUrl}/bird?name=Brown+Pelican`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.id).toBe("brown-pelican");
      expect(data.body.research).toBe("Some research text");
    });

    it("returns 400 when name is missing", async () => {
      const res = await fetch(`${baseUrl}/bird`);
      expect(res.status).toBe(400);
    });
  });

  describe("GET /metrics", () => {
    it("returns metrics with no window parameter", async () => {
      const res = await fetch(`${baseUrl}/metrics`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toHaveProperty("submitted");
      expect(data).toHaveProperty("completed");
      expect(data).toHaveProperty("failed");
      expect(data).toHaveProperty("failureRate");
      expect(data).toHaveProperty("avgProcessingTimeMs");
    });

    it("returns metrics with window parameter", async () => {
      const res = await fetch(`${baseUrl}/metrics?window=1000`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toHaveProperty("submitted");
      expect(data).toHaveProperty("completed");
      expect(data).toHaveProperty("failed");
      expect(data).toHaveProperty("failureRate");
      expect(data).toHaveProperty("avgProcessingTimeMs");
    });
  });
});
