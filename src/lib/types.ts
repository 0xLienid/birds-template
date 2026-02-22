export const ActionType = {
  JOB_SUBMITTED: "job-submitted",
  JOB_DUPLICATE: "job-duplicate",
  JOB_CLAIMED: "job-claimed",
  JOB_COMPLETED: "job-completed",
  JOB_RETRY: "job-retry",
  JOB_FAILED: "job-failed",
  API_REQUEST: "api-request",
  WORKER_START: "worker-start",
} as const;

export type ActionType = (typeof ActionType)[keyof typeof ActionType];

export type LogType = "log" | "warning" | "error";

export interface LogAction {
  id: string;
  timestamp: number;
  type: LogType;
  action: ActionType;
  body: Record<string, unknown>;
}

export type JobStatus = "queued" | "processing" | "completed" | "failed";

export interface ResearchJobRequest {
  name: string;
}

export interface ResearchJob {
  id: string;
  name: string;
  createdAt: number;
  availableForProcessingAt: number;
  retryCount: number;
  status: JobStatus;
  body: Record<string, unknown>;
}

export function toJobId(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-");
}
