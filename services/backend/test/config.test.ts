import assert from "node:assert/strict";
import test from "node:test";

import {
  ConfigError,
  loadApiConfig,
  loadDatastoreConfig,
  loadWorkerConfig,
} from "../src/config.js";

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

test("loadWorkerConfig validates shared runtime and readiness settings", () => {
  assert.deepEqual(loadWorkerConfig({}), {
    logLevel: "info",
    nodeEnvironment: "development",
    readinessFile: "/tmp/project-booth-worker-ready",
  });
  assert.throws(
    () => loadWorkerConfig({ WORKER_READY_FILE: " " }),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message.startsWith("WORKER_READY_FILE"),
  );
});

test("loadDatastoreConfig requires supported connection URLs", () => {
  assert.deepEqual(
    loadDatastoreConfig({
      DATABASE_URL: "postgresql://database.example/booth",
      VALKEY_URL: "rediss://valkey.example:6379",
    }),
    {
      databaseUrl: "postgresql://database.example/booth",
      valkeyUrl: "rediss://valkey.example:6379",
    },
  );
  assert.throws(
    () => loadDatastoreConfig({ VALKEY_URL: "redis://valkey.example" }),
    (error: unknown) =>
      error instanceof ConfigError && error.message === "DATABASE_URL is required",
  );
  assert.throws(
    () =>
      loadDatastoreConfig({
        DATABASE_URL: "https://database.example/booth",
        VALKEY_URL: "redis://valkey.example",
      }),
    (error: unknown) =>
      error instanceof ConfigError && error.message.startsWith("DATABASE_URL"),
  );
});
