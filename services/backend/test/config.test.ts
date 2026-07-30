import assert from "node:assert/strict";
import test from "node:test";

import {
  ConfigError,
  loadApiConfig,
  loadDatastoreConfig,
  loadIdentityConfig,
  loadMatchmakingConfig,
  loadRealtimeConfig,
  loadReliableJobConfig,
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
      error instanceof ConfigError &&
      error.message === "DATABASE_URL is required",
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

test("loadReliableJobConfig validates bounded polling settings", () => {
  assert.deepEqual(loadReliableJobConfig({}), {
    batchSize: 25,
    leaseMilliseconds: 30_000,
    outboxChannel: "project-booth:events",
    pollIntervalMilliseconds: 250,
  });
  assert.deepEqual(
    loadReliableJobConfig({
      OUTBOX_CHANNEL: "test-events",
      WORKER_BATCH_SIZE: "10",
      WORKER_LEASE_MS: "5000",
      WORKER_POLL_INTERVAL_MS: "50",
    }),
    {
      batchSize: 10,
      leaseMilliseconds: 5_000,
      outboxChannel: "test-events",
      pollIntervalMilliseconds: 50,
    },
  );
  assert.throws(
    () => loadReliableJobConfig({ WORKER_LEASE_MS: "999" }),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message.startsWith("WORKER_LEASE_MS"),
  );
});

test("loadIdentityConfig guards development auth from production", () => {
  assert.deepEqual(
    loadIdentityConfig({
      IDENTITY_PROVIDER: "development",
      NODE_ENV: "development",
    }),
    {
      accessTokenTtlSeconds: 900,
      accountDeletionDelaySeconds: 0,
      provider: "development",
      refreshTokenTtlSeconds: 2_592_000,
    },
  );
  assert.throws(
    () =>
      loadIdentityConfig({
        IDENTITY_PROVIDER: "development",
        NODE_ENV: "production",
      }),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message ===
        "IDENTITY_PROVIDER=development is forbidden when NODE_ENV=production",
  );
});

test("loadIdentityConfig requires the Apple audience and bounds lifetimes", () => {
  assert.deepEqual(
    loadIdentityConfig({
      ACCESS_TOKEN_TTL_SECONDS: "600",
      APPLE_CLIENT_ID: "com.example.project-booth",
      IDENTITY_PROVIDER: "apple",
      REFRESH_TOKEN_TTL_SECONDS: "86400",
    }),
    {
      accessTokenTtlSeconds: 600,
      accountDeletionDelaySeconds: 0,
      appleClientId: "com.example.project-booth",
      provider: "apple",
      refreshTokenTtlSeconds: 86_400,
    },
  );
  assert.throws(
    () => loadIdentityConfig({ IDENTITY_PROVIDER: "apple" }),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message === "APPLE_CLIENT_ID must not be empty",
  );
  assert.throws(
    () => loadIdentityConfig({ ACCESS_TOKEN_TTL_SECONDS: "59" }),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message.startsWith("ACCESS_TOKEN_TTL_SECONDS"),
  );
  assert.throws(
    () =>
      loadIdentityConfig({
        ACCESS_TOKEN_TTL_SECONDS: "3600",
        REFRESH_TOKEN_TTL_SECONDS: "3600",
      }),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message ===
        "REFRESH_TOKEN_TTL_SECONDS must be greater than ACCESS_TOKEN_TTL_SECONDS",
  );
});

test("M6 timing and resume settings are bounded and internally consistent", () => {
  assert.deepEqual(loadMatchmakingConfig({}), {
    lobbyReadyTimeoutSeconds: 30,
    readyTimeoutSeconds: 15,
    recentPairingWindowSeconds: 86_400,
  });
  assert.deepEqual(loadRealtimeConfig({}), {
    heartbeatIntervalMilliseconds: 10_000,
    heartbeatTimeoutMilliseconds: 30_000,
    resumeLimit: 100,
  });
  assert.throws(
    () =>
      loadRealtimeConfig({
        REALTIME_HEARTBEAT_INTERVAL_MS: "10000",
        REALTIME_HEARTBEAT_TIMEOUT_MS: "10000",
      }),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message.startsWith("REALTIME_HEARTBEAT_TIMEOUT_MS"),
  );
  assert.throws(
    () =>
      loadMatchmakingConfig({
        MATCHMAKING_READY_TIMEOUT_SECONDS: "4",
      }),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message.startsWith("MATCHMAKING_READY_TIMEOUT_SECONDS"),
  );
});
