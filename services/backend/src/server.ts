import type { FastifyInstance } from "fastify";
import { Redis as Valkey } from "iovalkey";
import type { Pool } from "pg";

import { buildApi } from "./app.js";
import {
  DeterministicModerationProvider,
  UnavailableModerationProvider,
} from "./chat/moderation.js";
import { PostgresChatService } from "./chat/service.js";
import {
  loadApiConfig,
  loadChatConfig,
  loadDatastoreConfig,
  loadIdentityConfig,
  loadMatchmakingConfig,
  loadRealtimeConfig,
  loadReliableJobConfig,
  type ApiConfig,
  type Environment,
} from "./config.js";
import { createIdentityProvider } from "./identity/provider.js";
import { PostgresIdentityService } from "./identity/service.js";
import { PostgresMatchApplication } from "./matches/service.js";
import { ValkeyMatchmakingQueue } from "./matchmaking/queue.js";
import { PostgresMatchmakingService } from "./matchmaking/service.js";
import { createDatabasePool } from "./persistence/database.js";
import { runMigrations } from "./persistence/migrations.js";
import { PostgresMatchCommandExecutor } from "./persistence/match-command-executor.js";
import { PostgresTransactionRunner } from "./persistence/transaction.js";
import { PostgresRealtimeQueryService } from "./realtime/events.js";
import {
  RealtimeGateway,
  ValkeyConnectionPresenceStore,
} from "./realtime/websocket.js";
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
  let valkey: Valkey | undefined;
  let realtimeSubscriber: Valkey | undefined;
  let realtimeGateway: RealtimeGateway | undefined;
  let matchmakingService: PostgresMatchmakingService | undefined;
  let realtimeQueryService: PostgresRealtimeQueryService | undefined;
  let matchService: PostgresMatchApplication | undefined;
  let chatService: PostgresChatService | undefined;

  if (identityConfig.provider !== "disabled") {
    const datastores = loadDatastoreConfig(environment);
    const realtimeConfig = loadRealtimeConfig(environment);
    pool = createDatabasePool({
      applicationName: "project-booth-api",
      connectionString: datastores.databaseUrl,
    });
    valkey = new Valkey(datastores.valkeyUrl, {
      connectTimeout: 5_000,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    realtimeSubscriber = new Valkey(datastores.valkeyUrl, {
      connectTimeout: 5_000,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    try {
      await Promise.all([
        runMigrations(pool),
        valkey.connect(),
        realtimeSubscriber.connect(),
      ]);
      const transactions = new PostgresTransactionRunner(pool);
      const chatConfig = loadChatConfig(environment);
      identityService = new PostgresIdentityService(
        transactions,
        createIdentityProvider(identityConfig),
        identityConfig,
      );
      matchmakingService = new PostgresMatchmakingService(
        transactions,
        new ValkeyMatchmakingQueue(valkey),
        loadMatchmakingConfig(environment),
      );
      realtimeQueryService = new PostgresRealtimeQueryService((action) =>
        transactions.run(action),
      );
      matchService = new PostgresMatchApplication(
        new PostgresMatchCommandExecutor(transactions),
      );
      chatService = new PostgresChatService(
        transactions,
        chatConfig.moderationProvider === "deterministic"
          ? new DeterministicModerationProvider()
          : new UnavailableModerationProvider(),
        chatConfig,
      );
      realtimeGateway = new RealtimeGateway(
        identityService,
        realtimeQueryService,
        realtimeConfig,
        realtimeSubscriber,
        loadReliableJobConfig(environment).outboxChannel,
        new ValkeyConnectionPresenceStore(
          valkey,
          `api-${process.pid}`,
          realtimeConfig.heartbeatTimeoutMilliseconds * 2,
        ),
      );
      await realtimeGateway.start();
    } catch (error: unknown) {
      valkey.disconnect();
      realtimeSubscriber.disconnect();
      await pool.end().catch(() => undefined);
      throw error;
    }
  }

  const api = buildApi(
    config,
    identityService === undefined
      ? {}
      : {
          identityService,
          chatService: chatService as PostgresChatService,
          matchmakingService: matchmakingService as PostgresMatchmakingService,
          matchService: matchService as PostgresMatchApplication,
          realtimeGateway: realtimeGateway as RealtimeGateway,
          realtimeQueryService:
            realtimeQueryService as PostgresRealtimeQueryService,
          realtimeResumeLimit: loadRealtimeConfig(environment).resumeLimit,
        },
  );
  if (pool !== undefined) {
    api.addHook("onClose", async () => {
      await realtimeGateway?.stop();
      valkey?.disconnect();
      await pool.end();
    });
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
