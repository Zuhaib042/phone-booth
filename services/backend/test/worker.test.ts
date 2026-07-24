import assert from "node:assert/strict";
import test from "node:test";

import pino from "pino";

import type { ReadinessReporter, WorkerJob } from "../src/worker.js";
import { WorkerRuntime } from "../src/worker.js";

test("worker handles a no-op job and reports its lifecycle", async () => {
  const events: string[] = [];
  const job: WorkerJob = {
    name: "test-noop",
    async execute(): Promise<void> {
      events.push("job");
    },
  };
  const readiness: ReadinessReporter = {
    async markNotReady(): Promise<void> {
      events.push("not-ready");
    },
    async markReady(): Promise<void> {
      events.push("ready");
    },
  };
  const worker = new WorkerRuntime(pino({ level: "silent" }), readiness, job);

  await worker.start();

  assert.equal(worker.isReady, true);
  assert.deepEqual(events, ["not-ready", "job", "ready"]);
  await assert.rejects(
    worker.start(),
    new Error("Worker runtime can only be started once"),
  );

  await worker.stop("SIGTERM");
  await worker.stopped;

  assert.equal(worker.isReady, false);
  assert.deepEqual(events, ["not-ready", "job", "ready", "not-ready"]);
});
