import { type Database } from "lmdb";
import { getDb } from "../lib/db.js";
import { CONFIG } from "../lib/config.js";
import { type ResearchJob, type ResearchJobRequest, toJobId } from "../lib/types.js";

function indexKey(timestamp: number, jobId: string): string {
  return `${String(timestamp).padStart(CONFIG.TIMESTAMP_PAD_LENGTH, "0")}-${jobId}`;
}

export class Queue {
  private jobs: Database<ResearchJob, string>;
  private queueIndex: Database<string, string>;

  constructor(dbPath: string) {
    const root = getDb(dbPath);
    this.jobs = root.openDB<ResearchJob, string>("jobs", { encoding: "msgpack" });
    this.queueIndex = root.openDB<string, string>("queue-index", {
      encoding: "string",
    });
  }

  submitJob(request: ResearchJobRequest): { job: ResearchJob; isDuplicate: boolean } {
    const jobId = toJobId(request.name);
    const now = Date.now();

    const existing = this.jobs.get(jobId);

    if (existing) {
      if (existing.status === "failed") {
        const resetJob: ResearchJob = {
          ...existing,
          createdAt: now,
          availableForProcessingAt: now,
          retryCount: 0,
          status: "queued",
          body: {},
        };
        this.jobs.transactionSync(() => {
          this.jobs.putSync(jobId, resetJob);
          this.queueIndex.putSync(indexKey(now, jobId), jobId);
        });
        return { job: resetJob, isDuplicate: false };
      }
      return { job: existing, isDuplicate: true };
    }

    const job: ResearchJob = {
      id: jobId,
      name: request.name,
      createdAt: now,
      availableForProcessingAt: now,
      retryCount: 0,
      status: "queued",
      body: {},
    };

    this.jobs.transactionSync(() => {
      this.jobs.putSync(jobId, job);
      this.queueIndex.putSync(indexKey(now, jobId), jobId);
    });

    return { job, isDuplicate: false };
  }

  claimJob(): ResearchJob | undefined {
    let claimed: ResearchJob | undefined;

    this.jobs.transactionSync(() => {
      for (const { key, value } of this.queueIndex.getRange({ limit: 1 })) {
        const timestamp = parseInt(key.slice(0, CONFIG.TIMESTAMP_PAD_LENGTH), 10);
        if (timestamp > Date.now()) break;

        const job = this.jobs.get(value);
        if (!job) {
          this.queueIndex.removeSync(key);
          break;
        }

        const updated: ResearchJob = { ...job, status: "processing" };
        this.queueIndex.removeSync(key);
        this.jobs.putSync(job.id, updated);
        claimed = updated;
      }
    });

    return claimed;
  }

  getJob(jobId: string): ResearchJob | undefined {
    return this.jobs.get(jobId);
  }

  completeJob(jobId: string, body: Record<string, unknown>): ResearchJob | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;

    const updated: ResearchJob = { ...job, status: "completed", body };
    this.jobs.putSync(jobId, updated);
    return updated;
  }

  retryJob(jobId: string, nextAvailableAt: number): ResearchJob | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;

    const updated: ResearchJob = {
      ...job,
      status: "queued",
      retryCount: job.retryCount + 1,
      availableForProcessingAt: nextAvailableAt,
    };

    this.jobs.transactionSync(() => {
      this.jobs.putSync(jobId, updated);
      this.queueIndex.putSync(indexKey(nextAvailableAt, jobId), jobId);
    });

    return updated;
  }

  failJob(jobId: string): ResearchJob | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;

    const updated: ResearchJob = { ...job, status: "failed" };
    this.jobs.putSync(jobId, updated);
    return updated;
  }
}
