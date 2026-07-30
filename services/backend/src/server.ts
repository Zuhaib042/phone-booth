import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import { buildApi } from "./app.js";
import {
  loadApiConfig,
  loadIdentityConfig,
  loadPostgresConfig,
  type ApiConfig,
  type Environment,
} from "./config.js";
import { createIdentityProvider } from "./identity/provider.js";
import { PostgresIdentityService } from "./identity/service.js";
import { createDatabasePool } from "./persistence/database.js";
import { runMigrations } from "./persistence/migrations.js";
import { PostgresTransactionRunner } from "./persistence/transaction.js";
import {
  subscribeToShutdownSignals,
  type ShutdownSignal,
  type SignalSource,
} from "./process-signals.js";

export interface GracefulShutdownController {
  dispose(): void;
  shutdown(signal: ShutdownSignal): Promise<void>;
}

export interface InstallGracefulShutdownOptions {
  readonly onError?: (error: unknown) => void;
  readonly signalSource?: SignalSource;
}

export interface RunningApi {
  readonly api: FastifyInstance;
  readonly config: ApiConfig;
  readonly shutdown: GracefulShutdownController;
}

export function installGracefulShutdown(
  api: FastifyInstance,
  options: InstallGracefulShutdownOptions = {},
): GracefulShutdownController {
  const signalSource = options.signalSource ?? process;
  const onError =
    options.onError ??
    (() => {
      process.exitCode = 1;
    });
  let disposed = false;
  let shutdownPromise: Promise<void> | undefined;

  const signalSubscription = subscribeToShutdownSignals(
    (signal) => void shutdownFromSignal(signal),
    signalSource,
  );

  function dispose(): void {
    if (disposed) {
      return;
    }

    disposed = true;
    signalSubscription.dispose();
  }

  function shutdown(signal: ShutdownSignal): Promise<void> {
    shutdownPromise ??= (async () => {
      api.log.info({ signal }, "API shutdown requested");

      try {
        await api.close();
        api.log.info({ signal }, "API shutdown complete");
      } finally {
        dispose();
      }
    })();

    return shutdownPromise;
  }

  async function shutdownFromSignal(signal: ShutdownSignal): Promise<void> {
    try {
      await shutdown(signal);
    } catch (error: unknown) {
      api.log.error({ err: error, signal }, "API shutdown failed");
      onError(error);
    }
  }

  return { dispose, shutdown };
}

export async function startApi(
  environment: Environment = process.env,
): Promise<RunningApi> {
  const config = loadApiConfig(environment);
  const identityConfig = loadIdentityConfig(environment);
  let pool: Pool | undefined;
  let identityService: PostgresIdentityService | undefined;

  if (identityConfig.provider !== "disabled") {
    pool = createDatabasePool({
      applicationName: "project-booth-api",
      connectionString: loadPostgresConfig(environment).databaseUrl,
    });
    try {
      await runMigrations(pool);
      identityService = new PostgresIdentityService(
        new PostgresTransactionRunner(pool),
        createIdentityProvider(identityConfig),
        identityConfig,
      );
    } catch (error: unknown) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  }

  const api = buildApi(
    config,
    identityService === undefined ? {} : { identityService },
  );
  if (pool !== undefined) {
    api.addHook("onClose", async () => pool.end());
  }

  try {
    await api.listen({ host: config.host, port: config.port });
  } catch (error: unknown) {
    await api.close();
    throw error;
  }

  const shutdown = installGracefulShutdown(api);
  api.log.info({ addresses: api.addresses() }, "API listening");

  return { api, config, shutdown };
}
