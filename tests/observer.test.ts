import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Observer } from "../src/observer/observer.js";
import { ActionType } from "../src/lib/types.js";
import { closeAll } from "../src/lib/db.js";

let observer: Observer;

beforeEach(() => {
  const dbPath = mkdtempSync(join(tmpdir(), "observer-test-"));
  observer = new Observer(dbPath);
});

afterAll(() => {
  closeAll();
});

describe("Observer", () => {
  describe("log", () => {
    it("stores a log entry", () => {
      observer.log(ActionType.JOB_SUBMITTED, "log", {
        jobId: "brown-pelican",
        name: "Brown Pelican",
      });

      const trace = observer.getTrace("brown-pelican");
      expect(trace).toHaveLength(1);
      expect(trace[0]!.action).toBe("job-submitted");
      expect(trace[0]!.body.jobId).toBe("brown-pelican");
      expect(trace[0]!.body.name).toBe("Brown Pelican");
    });

    it("stores entries with correct structure", () => {
      observer.log(ActionType.JOB_CLAIMED, "log", {
        jobId: "brown-pelican",
        name: "Brown Pelican",
        workerId: "w-abcd",
      });

      const trace = observer.getTrace("brown-pelican");
      const entry = trace[0]!;
      expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(entry.timestamp).toBeTypeOf("number");
      expect(entry.type).toBe("log");
      expect(entry.action).toBe("job-claimed");
      expect(entry.body).toEqual({
        jobId: "brown-pelican",
        name: "Brown Pelican",
        workerId: "w-abcd",
      });
    });

    it("preserves the log type for warnings", () => {
      observer.log(ActionType.JOB_RETRY, "warning", {
        jobId: "brown-pelican",
        name: "Brown Pelican",
        workerId: "w-abcd",
        retryCount: 1,
        nextAvailableAt: 123456,
        error: "timeout",
      });

      const trace = observer.getTrace("brown-pelican");
      expect(trace[0]!.type).toBe("warning");
      expect(trace[0]!.action).toBe("job-retry");
    });

    it("preserves the log type for errors", () => {
      vi.spyOn(console, "log").mockImplementation(() => {});

      observer.log(ActionType.JOB_FAILED, "error", {
        jobId: "brown-pelican",
        name: "Brown Pelican",
        workerId: "w-abcd",
        retryCount: 3,
        error: "permanent failure",
      });

      const trace = observer.getTrace("brown-pelican");
      expect(trace[0]!.type).toBe("error");
      expect(trace[0]!.action).toBe("job-failed");

      vi.restoreAllMocks();
    });
  });

  describe("getTrace", () => {
    it("returns all entries for a job in order", () => {
      observer.log(ActionType.JOB_SUBMITTED, "log", {
        jobId: "brown-pelican",
        name: "Brown Pelican",
      });
      observer.log(ActionType.JOB_CLAIMED, "log", {
        jobId: "brown-pelican",
        name: "Brown Pelican",
        workerId: "w-1234",
      });
      observer.log(ActionType.JOB_COMPLETED, "log", {
        jobId: "brown-pelican",
        name: "Brown Pelican",
        workerId: "w-1234",
      });

      // Another job — should not appear
      observer.log(ActionType.JOB_SUBMITTED, "log", {
        jobId: "bald-eagle",
        name: "Bald Eagle",
      });

      const trace = observer.getTrace("brown-pelican");
      expect(trace).toHaveLength(3);
      expect(trace[0]!.action).toBe("job-submitted");
      expect(trace[0]!.body.jobId).toBe("brown-pelican");
      expect(trace[0]!.body.name).toBe("Brown Pelican");

      expect(trace[1]!.action).toBe("job-claimed");
      expect(trace[1]!.body.jobId).toBe("brown-pelican");
      expect(trace[1]!.body.name).toBe("Brown Pelican");
      expect(trace[1]!.body.workerId).toBe("w-1234");

      expect(trace[2]!.action).toBe("job-completed");
      expect(trace[2]!.body.jobId).toBe("brown-pelican");
      expect(trace[2]!.body.name).toBe("Brown Pelican");
      expect(trace[2]!.body.workerId).toBe("w-1234");
    });
  });

  describe("getMetrics", () => {
    it("computes counts and failure rate", () => {
      observer.log(ActionType.JOB_SUBMITTED, "log", { jobId: "a", name: "A" });
      observer.log(ActionType.JOB_SUBMITTED, "log", { jobId: "b", name: "B" });
      observer.log(ActionType.JOB_COMPLETED, "log", { jobId: "a", name: "A", workerId: "w" });
      observer.log(ActionType.JOB_FAILED, "error", { jobId: "b", name: "B", workerId: "w", retryCount: 3, error: "fail" });

      const metrics = observer.getMetrics();
      expect(metrics.submitted).toBe(2);
      expect(metrics.completed).toBe(1);
      expect(metrics.failed).toBe(1);
      expect(metrics.failureRate).toBe(0.5);
    });

    it("handles window properly", async () => {
      observer.log(ActionType.JOB_SUBMITTED, "log", { jobId: "a", name: "A" });
      observer.log(ActionType.JOB_SUBMITTED, "log", { jobId: "b", name: "B" });
      observer.log(ActionType.JOB_COMPLETED, "log", { jobId: "a", name: "A", workerId: "w" });
      observer.log(ActionType.JOB_FAILED, "error", { jobId: "b", name: "B", workerId: "w", retryCount: 3, error: "fail" });

      await new Promise(resolve => setTimeout(resolve, 200));

      observer.log(ActionType.JOB_SUBMITTED, "log", { jobId: "c", name: "C" });
      observer.log(ActionType.JOB_COMPLETED, "log", { jobId: "c", name: "C", workerId: "w" });

      const metrics = observer.getMetrics(100);
      expect(metrics.submitted).toBe(1);
      expect(metrics.completed).toBe(1);
      expect(metrics.failed).toBe(0);
      expect(metrics.failureRate).toBe(0);
    })

    it("computes average processing time", () => {
      observer.log(ActionType.JOB_CLAIMED, "log", { jobId: "a", name: "A", workerId: "w" });
      observer.log(ActionType.JOB_COMPLETED, "log", { jobId: "a", name: "A", workerId: "w" });

      const metrics = observer.getMetrics();
      expect(metrics.avgProcessingTimeMs).not.toBeNull();
      expect(metrics.avgProcessingTimeMs!).toBeGreaterThanOrEqual(0);
    });

    it("returns null avgProcessingTimeMs when no completed pairs", () => {
      observer.log(ActionType.JOB_SUBMITTED, "log", { jobId: "a", name: "A" });

      const metrics = observer.getMetrics();
      expect(metrics.avgProcessingTimeMs).toBeNull();
    });
  });

  describe("alerting", () => {
    it("triggers alert when failure rate exceeds threshold", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      // Create a scenario where failure rate > 0.5
      observer.log(ActionType.JOB_COMPLETED, "log", { jobId: "a", name: "A", workerId: "w" });
      observer.log(ActionType.JOB_FAILED, "error", { jobId: "b", name: "B", workerId: "w", retryCount: 3, error: "fail" });
      observer.log(ActionType.JOB_FAILED, "error", { jobId: "c", name: "C", workerId: "w", retryCount: 3, error: "fail" });

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("ALERT:"));
      consoleSpy.mockRestore();
    });
  });
});
