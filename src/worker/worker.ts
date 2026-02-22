import crypto from "node:crypto";
import { Queue } from "../lib/queue.js";
import { Observer } from "../observer/observer.js";
import { ActionType, type ResearchJob } from "../lib/types.js";
import { CONFIG } from "../lib/config.js";

export function generateWorkerId(): string {
  return `w-${crypto.randomBytes(2).toString("hex")}`;
}

export function computeBackoff(retryCount: number): number {
  const delay = Math.pow(2, retryCount + 1) * CONFIG.BASE_DELAY_MS;
  const jitter = Math.random() * CONFIG.BASE_DELAY_MS;
  return Date.now() + delay + jitter;
}

export async function processJob(job: ResearchJob): Promise<Record<string, unknown>> {
  const url = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&redirects=1&titles=${encodeURIComponent(job.name)}&format=json&formatversion=2`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Wikipedia API returned ${response.status}`);
  }
  const data = (await response.json()) as {
    query: { pages: Array<{ extract?: string; missing?: boolean }> };
  };
  const page = data.query.pages[0];
  if (!page || page.missing || !page.extract) {
    throw new Error(`No Wikipedia page found for "${job.name}"`);
  }
  return { research: page.extract };
}

export async function runWorker(workerId: string, queue: Queue, observer: Observer): Promise<void> {
  observer.log(ActionType.WORKER_START, "log", { workerId });

  const poll = async (): Promise<void> => {
    const job = queue.claimJob();

    if (job) {
      observer.log(ActionType.JOB_CLAIMED, "log", {
        jobId: job.id,
        name: job.name,
        workerId,
      });

      try {
        const body = await processJob(job);
        queue.completeJob(job.id, body);
        observer.log(ActionType.JOB_COMPLETED, "log", {
          jobId: job.id,
          name: job.name,
          workerId,
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);

        if (job.retryCount >= CONFIG.MAX_RETRIES) {
          queue.failJob(job.id);
          observer.log(ActionType.JOB_FAILED, "error", {
            jobId: job.id,
            name: job.name,
            workerId,
            retryCount: job.retryCount,
            error,
          });
        } else {
          const nextAvailableAt = computeBackoff(job.retryCount);
          queue.retryJob(job.id, nextAvailableAt);
          observer.log(ActionType.JOB_RETRY, "warning", {
            jobId: job.id,
            name: job.name,
            workerId,
            retryCount: job.retryCount + 1,
            nextAvailableAt,
            error,
          });
        }
      }
    }

    setTimeout(() => void poll(), CONFIG.POLL_INTERVAL_MS);
  };

  await poll();
}

if (process.env.NODE_ENV !== "test") {
  const concurrency = parseInt(process.env.WORKER_CONCURRENCY ?? "1", 10);
  const queue = new Queue(CONFIG.QUEUE_DB_PATH);
  const observer = new Observer(CONFIG.OBSERVER_DB_PATH);

  for (let i = 0; i < concurrency; i++) {
    const workerId = generateWorkerId();
    console.log(`Starting worker ${workerId} (${i + 1}/${concurrency})`);
    void runWorker(workerId, queue, observer);
  }
}
