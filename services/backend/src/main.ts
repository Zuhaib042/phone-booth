import { writeStartupFailure } from "./logger.js";
import { startApi } from "./server.js";

try {
  await startApi();
} catch (error: unknown) {
  writeStartupFailure("backend-api", "API startup failed", error);
  process.exitCode = 1;
}
