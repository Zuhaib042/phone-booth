import { loadDatastoreConfig } from "./config.js";
import { checkDatastores } from "./datastore-health.js";
import { writeStartupFailure } from "./logger.js";

try {
  const result = await checkDatastores(loadDatastoreConfig());
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error: unknown) {
  writeStartupFailure("backend-health", "Datastore health check failed", error);
  process.exitCode = 1;
}
