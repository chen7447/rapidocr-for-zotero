export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type Job = {
  jobId: string;
  attachmentID: number;
  /** File to render for OCR. */
  path: string;
  title: string;
  status: JobStatus;
  error?: { code: string; message: string; retryable: boolean };
  percent: number;
  stage: string;
  /** 0-based; omit = all pages. */
  pageIndexes?: number[];
  /** Write onto this file instead of creating a sibling [OCR] attachment. */
  inPlace?: boolean;
  /** Overlay onto this file (existing [OCR] copy). Defaults to `path`. */
  writePath?: string;
  writeAttachmentID?: number;
  detLimitSideLen?: number;
  detThresh?: number;
  detBoxThresh?: number;
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