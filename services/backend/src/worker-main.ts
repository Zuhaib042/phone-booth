import { writeStartupFailure } from "./logger.js";
import { startWorker } from "./worker.js";

try {
  await startWorker();
} catch (error: unknown) {
  writeStartupFailure("backend-worker", "Worker startup failed", error);
  process.exitCode = 1;
}
