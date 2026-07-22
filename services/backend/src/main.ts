import { startApi } from "./server.js";

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return { value: String(error) };
}

try {
  await startApi();
} catch (error: unknown) {
  process.stderr.write(
    `${JSON.stringify({
      err: serializeError(error),
      level: "fatal",
      msg: "API startup failed",
      service: "backend-api",
      time: new Date().toISOString(),
    })}\n`,
  );
  process.exitCode = 1;
}
