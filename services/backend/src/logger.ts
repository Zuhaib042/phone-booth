import pino, { type Logger, type LoggerOptions } from "pino";

import type { RuntimeConfig } from "./config.js";

export type ServiceName = "backend-api" | "backend-health" | "backend-worker";

export function createLoggerOptions(
  config: RuntimeConfig,
  service: ServiceName,
): LoggerOptions {
  return {
    level: config.logLevel,
    base: {
      environment: config.nodeEnvironment,
      service,
    },
  };
}

export function createRuntimeLogger(
  config: RuntimeConfig,
  service: ServiceName,
): Logger {
  return pino(createLoggerOptions(config, service));
}

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

export function writeStartupFailure(
  service: ServiceName,
  message: string,
  error: unknown,
): void {
  process.stderr.write(
    `${JSON.stringify({
      err: serializeError(error),
      level: "fatal",
      msg: message,
      service,
      time: new Date().toISOString(),
    })}\n`,
  );
}
