import { Job, transitionJob } from "../domain/job";

export type { Job } from "../domain/job";
export { transitionJob } from "../domain/job";

export interface JobExecutor {
  execute(job: Job): Promise<void>;
  kill?(): void;
}

export interface QueueListener {
  onJobStarted(job: Job): void;
  onJobProgress(job: Job): void;
  onJobCompleted(job: Job): void;
  onJobFailed(job: Job): void;
  onJobCancelled(job: Job): void;
}

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly listeners = new Set<QueueListener>();
  private running = false;
  private flushPromise: Promise<void> | null = null;
  private flushResolve: (() => void) | null = null;
  private currentJob: Job | null = null;

  constructor(private readonly executor: JobExecutor) {}

  addListener(listener: QueueListener): void {
    this.listeners.add(listener);
  }

  removeListener(listener: QueueListener): void {
    this.listeners.delete(listener);
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  enqueue(job: Job): void {
    for (const existing of this.jobs.values()) {
      if (existing.attachmentID === job.attachmentID && (existing.status === "queued" || existing.status === "running")) {
        throw new Error(`Attachment ${job.attachmentID} is already queued or running.`);
      }
    }
    this.jobs.set(job.jobId, job);
    this.schedule();
  }

  get(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  all(): Job[] {
    return Array.from(this.jobs.values());
  }

  cancelCurrent(): void {
    if (!this.currentJob) return;
    const job = this.currentJob;
    transitionJob(job, "cancelled");
    this.executor.kill?.();
    this.emitCancelled(job);
    this.currentJob = null;
  }

  /** Cancel one job: the running one (same as cancelCurrent) or a queued one in place. */
  cancelJob(jobId: string): void {
    if (this.currentJob?.jobId === jobId) {
      this.cancelCurrent();
      return;
    }
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "queued") return;
    transitionJob(job, "cancelled");
    this.emitCancelled(job);
  }

  cancelRemaining(): void {
    for (const job of this.jobs.values()) {
      if (job.status === "queued") {
        transitionJob(job, "cancelled");
        this.emitCancelled(job);
      }
    }
  }

  shutdown(): void {
    this.cancelCurrent();
    this.cancelRemaining();
    this.jobs.clear();
    this.listeners.clear();
  }

  async waitForAll(): Promise<void> {
    if (!this.flushPromise) return;
    await this.flushPromise;
  }

  private schedule(): void {
    if (this.running) return;
    const next = this.findNext();
    if (!next) return;
    this.running = true;
    this.flushPromise = new Promise<void>((resolve) => { this.flushResolve = resolve; });
    this.run(next);
  }

  private findNext(): Job | undefined {
    for (const job of this.jobs.values()) {
      if (job.status === "queued") return job;
    }
    return undefined;
  }

  private async run(job: Job): Promise<void> {
    this.currentJob = job;
    transitionJob(job, "running");
    this.emitStarted(job);
    try {
      await this.executor.execute(job);
      if (job.status !== "cancelled") {
        transitionJob(job, "completed");
        this.emitCompleted(job);
      }
    } catch (err) {
      const error = {
        code: (err as { code?: string })?.code || "JOB_EXECUTION_ERROR",
        message: (err as Error).message || String(err),
        retryable: false,
      };
      if (job.status !== "cancelled") {
        this.jobs.set(job.jobId, { ...job, status: "failed", error });
        this.emitFailed(job);
      }
    }
    this.currentJob = null;
    this.running = false;
    this.flushResolve?.();
    this.flushResolve = null;
    this.flushPromise = null;
    this.schedule();
  }

  private emitStarted(job: Job): void {
    for (const listener of this.listeners) listener.onJobStarted(job);
  }
  private emitCompleted(job: Job): void {
    for (const listener of this.listeners) listener.onJobCompleted(job);
  }
  private emitFailed(job: Job): void {
    for (const listener of this.listeners) listener.onJobFailed(job);
  }
  private emitCancelled(job: Job): void {
    for (const listener of this.listeners) listener.onJobCancelled(job);
  }
}