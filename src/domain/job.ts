export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type Job = {
  jobId: string;
  attachmentID: number;
  path: string;
  title: string;
  status: JobStatus;
  error?: { code: string; message: string; retryable: boolean };
  percent: number;
  stage: string;
};

const VALID_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  queued: ["running", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function transitionJob(job: Job, to: JobStatus, error?: { code: string; message: string; retryable: boolean }): void {
  const allowed = VALID_TRANSITIONS[job.status];
  if (!allowed.includes(to)) {
    throw new Error(`Invalid job state transition: ${job.status} → ${to}`);
  }
  job.status = to;
  if (error) job.error = error;
  if (to === "running") {
    job.percent = 0;
    job.stage = "starting";
  }
  if (to === "completed") {
    job.percent = 100;
    job.stage = "completed";
  }
}