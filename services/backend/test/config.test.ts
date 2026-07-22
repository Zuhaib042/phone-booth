import assert from "node:assert/strict";
import test from "node:test";

import { ConfigError, loadApiConfig } from "../src/config.js";

test("loadApiConfig supplies safe local defaults", () => {
  assert.deepEqual(loadApiConfig({}), {
    host: "0.0.0.0",
    logLevel: "info",
    nodeEnvironment: "development",
    port: 3000,
  });
});

test("loadApiConfig validates and types explicit values", () => {
  assert.deepEqual(
    loadApiConfig({
      HOST: "127.0.0.1",
      LOG_LEVEL: "debug",
      NODE_ENV: "production",
      PORT: "8080",
    }),
    {
      host: "127.0.0.1",
      logLevel: "debug",
      nodeEnvironment: "production",
      port: 8080,
    },
  );
});

test("loadApiConfig rejects invalid environment values", () => {
  assert.throws(
    () => loadApiConfig({ PORT: "not-a-port" }),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message === "PORT must be an integer from 0 to 65535",
  );
  assert.throws(
    () => loadApiConfig({ LOG_LEVEL: "verbose" }),
    (error: unknown) =>
      error instanceof ConfigError && error.message.startsWith("LOG_LEVEL"),
  );
});
