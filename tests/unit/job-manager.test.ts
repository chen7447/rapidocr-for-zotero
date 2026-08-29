import assert from "node:assert/strict";
import test from "node:test";

import { Job, JobManager, QueueListener } from "../../src/jobs/job-manager";

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    jobId: `job-${Math.random().toString(36).slice(2, 8)}`,
    attachmentID: 1,
    path: "C:\\paper.pdf",
    title: "Test Paper",
    status: "queued",
    ...overrides,
  };
}

class FakeListener implements QueueListener {
  public started: string[] = [];
  public failed: string[] = [];
  public completed: string[] = [];
  public cancelled: string[] = [];

  onJobStarted(job: Job): void { this.started.push(job.jobId); }
  onJobProgress(_job: Job): void {}
  onJobCompleted(job: Job): void { this.completed.push(job.jobId); }
  onJobFailed(job: Job): void { this.failed.push(job.jobId); }
  onJobCancelled(job: Job): void { this.cancelled.push(job.jobId); }
}

test("enqueue adds a job and processes it serially", async () => {
  const manager = new JobManager({ async execute() {} });
  const listener = new FakeListener();
  manager.addListener(listener);
  const job = makeJob();
  manager.enqueue(job);
  assert.equal(manager.all().length, 1);
  assert.equal(manager.all()[0].status, "running");
  await manager.waitForAll();
  assert.equal(manager.all()[0].status, "completed");
  assert.deepEqual(listener.completed, [job.jobId]);
});

test("same attachment ID cannot be enqueued twice", () => {
  const manager = new JobManager({ async execute() {} });
  const a = makeJob({ attachmentID: 42 });
  const b = makeJob({ attachmentID: 42 });
  manager.enqueue(a);
  assert.throws(() => manager.enqueue(b), /already queued or running/);
});

test("jobs execute serially: second starts only after first completes", async () => {
  const order: string[] = [];
  const manager = new JobManager({
    async execute(job) { order.push(job.jobId); },
  });
  const a = makeJob({ jobId: "A", attachmentID: 1 });
  const b = makeJob({ jobId: "B", attachmentID: 2 });
  manager.enqueue(a);
  manager.enqueue(b);
  assert.equal(manager.all().length, 2);
  await manager.waitForAll();
  assert.deepEqual(order, ["A", "B"]);
});

test("a failed job does not block subsequent jobs", async () => {
  const order: string[] = [];
  const manager = new JobManager({
    async execute(job) {
      order.push(job.jobId);
      if (job.jobId === "A") throw new Error("fail");
    },
  });
  const listener = new FakeListener();
  manager.addListener(listener);
  const a = makeJob({ jobId: "A", attachmentID: 1 });
  const b = makeJob({ jobId: "B", attachmentID: 2 });
  manager.enqueue(a);
  manager.enqueue(b);
  await manager.waitForAll();
  assert.deepEqual(order, ["A", "B"]);
  assert.equal(manager.get("A")?.status, "failed");
  assert.equal(manager.get("B")?.status, "completed");
  assert.deepEqual(listener.failed, ["A"]);
  assert.deepEqual(listener.completed, ["B"]);
});

test("cancelCurrent stops the active job and moves it to cancelled", async () => {
  const manager = new JobManager({
    async execute() { await new Promise(() => {}); },
    kill() {},
  });
  const listener = new FakeListener();
  manager.addListener(listener);
  const job = makeJob();
  manager.enqueue(job);
  // Give the microtask queue a chance to transition to running
  await Promise.resolve();
  assert.equal(manager.get(job.jobId)?.status, "running");
  manager.cancelCurrent();
  assert.equal(manager.get(job.jobId)?.status, "cancelled");
  assert.deepEqual(listener.cancelled, [job.jobId]);
});

test("cancelRemaining clears all queued jobs without starting them", async () => {
  const manager = new JobManager({
    async execute() { await new Promise(() => {}); },
    kill() {},
  });
  const a = makeJob({ jobId: "A", attachmentID: 1 });
  const b = makeJob({ jobId: "B", attachmentID: 2 });
  const c = makeJob({ jobId: "C", attachmentID: 3 });
  manager.enqueue(a);
  await Promise.resolve();
  manager.enqueue(b);
  manager.enqueue(c);
  manager.cancelRemaining();
  assert.equal(manager.get("A")?.status, "running");
  assert.equal(manager.get("B")?.status, "cancelled");
  assert.equal(manager.get("C")?.status, "cancelled");
});

test("cancelJob cancels a queued job in place and leaves the queue intact", async () => {
  const manager = new JobManager({
    async execute() { await new Promise(() => {}); },
    kill() {},
  });
  const listener = new FakeListener();
  manager.addListener(listener);
  const a = makeJob({ jobId: "A", attachmentID: 1 });
  const b = makeJob({ jobId: "B", attachmentID: 2 });
  const c = makeJob({ jobId: "C", attachmentID: 3 });
  manager.enqueue(a);
  await Promise.resolve();
  manager.enqueue(b);
  manager.enqueue(c);
  manager.cancelJob("B");
  assert.equal(manager.get("A")?.status, "running");
  assert.equal(manager.get("B")?.status, "cancelled");
  assert.equal(manager.get("C")?.status, "queued");
  assert.deepEqual(listener.cancelled, ["B"]);
  // idempotent: cancelling again is a no-op
  manager.cancelJob("B");
  assert.deepEqual(listener.cancelled, ["B"]);
});

test("cancelJob on the running job behaves like cancelCurrent", async () => {
  let killed = false;
  const manager = new JobManager({
    async execute() { await new Promise(() => {}); },
    kill() { killed = true; },
  });
  const listener = new FakeListener();
  manager.addListener(listener);
  manager.enqueue(makeJob({ jobId: "A", attachmentID: 1 }));
  await Promise.resolve();
  manager.cancelJob("A");
  assert.equal(manager.get("A")?.status, "cancelled");
  assert.equal(killed, true);
  assert.deepEqual(listener.cancelled, ["A"]);
});

test("shutdown clears all listeners and stops the active job", async () => {
  let killed = false;
  const manager = new JobManager({
    async execute() { await new Promise(() => {}); },
    kill() { killed = true; },
  });
  const listener = new FakeListener();
  manager.addListener(listener);
  manager.enqueue(makeJob());
  await Promise.resolve();
  manager.shutdown();
  assert.equal(manager.all().length, 0);
  assert.equal(manager.listenerCount(), 0);
  assert.equal(killed, true);
});