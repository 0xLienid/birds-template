import { getDb } from "../lib/db.js";
import { CONFIG } from "../lib/config.js";
import { ActionType, type LogAction, type LogType } from "../lib/types.js";

export class Observer {
  private db;

  constructor(dbPath: string) {
    this.db = getDb(dbPath);
  }

  log(action: (typeof ActionType)[keyof typeof ActionType], type: LogType, body: Record<string, unknown>): void {
    const entry: LogAction = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type,
      action,
      body,
    };

    const key = `${String(entry.timestamp).padStart(CONFIG.TIMESTAMP_PAD_LENGTH, "0")}-${entry.id}`;
    this.db.putSync(key, entry);

    if (action === ActionType.JOB_FAILED) {
      this.checkFailureRate();
    }
  }

  getTrace(jobId: string): LogAction[] {
    const results: LogAction[] = [];
    for (const { value } of this.db.getRange()) {
      const entry = value as LogAction;
      if (entry.body && (entry.body as Record<string, unknown>).jobId === jobId) {
        results.push(entry);
      }
    }
    return results.sort((a, b) => a.timestamp - b.timestamp);
  }

  getMetrics(windowMs: number = CONFIG.DEFAULT_METRICS_WINDOW_MS): {
    submitted: number;
    completed: number;
    failed: number;
    failureRate: number;
    avgProcessingTimeMs: number | null;
  } {
    const now = Date.now();
    const windowStart = now - windowMs;
    const startKey = `${String(windowStart).padStart(CONFIG.TIMESTAMP_PAD_LENGTH, "0")}`;

    let submitted = 0;
    let completed = 0;
    let failed = 0;

    const claimedTimes = new Map<string, number>();
    const completedTimes = new Map<string, number>();

    for (const { key, value } of this.db.getRange({ start: startKey })) {
      if (typeof key !== "string") continue;
      const entry = value as LogAction;

      switch (entry.action) {
        case ActionType.JOB_SUBMITTED:
          submitted++;
          break;
        case ActionType.JOB_COMPLETED:
          completed++;
          if (entry.body?.jobId) {
            completedTimes.set(entry.body.jobId as string, entry.timestamp);
          }
          break;
        case ActionType.JOB_FAILED:
          failed++;
          break;
        case ActionType.JOB_CLAIMED:
          if (entry.body?.jobId) {
            claimedTimes.set(entry.body.jobId as string, entry.timestamp);
          }
          break;
      }
    }

    const total = completed + failed;
    const failureRate = total === 0 ? 0 : failed / total;

    let avgProcessingTimeMs: number | null = null;
    const processingTimes: number[] = [];
    for (const [jobId, completedAt] of completedTimes) {
      const claimedAt = claimedTimes.get(jobId);
      if (claimedAt !== undefined) {
        processingTimes.push(completedAt - claimedAt);
      }
    }
    if (processingTimes.length > 0) {
      avgProcessingTimeMs =
        processingTimes.reduce((sum, t) => sum + t, 0) / processingTimes.length;
    }

    return { submitted, completed, failed, failureRate, avgProcessingTimeMs };
  }

  private checkFailureRate(): void {
    const metrics = this.getMetrics();
    if (metrics.failureRate > CONFIG.FAILURE_RATE_THRESHOLD) {
      this.alert(
        `High failure rate detected: ${(metrics.failureRate * 100).toFixed(1)}% (${metrics.failed}/${metrics.completed + metrics.failed} jobs failed)`
      );
    }
  }

  private alert(message: string): void {
    console.log(`ALERT: ${message}`);
  }
}
