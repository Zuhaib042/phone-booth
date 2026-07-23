import type { FastifyInstance } from "fastify";

import { buildApi } from "./app.js";
import {
  loadApiConfig,
  type ApiConfig,
  type Environment,
} from "./config.js";
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
  const api = buildApi(config);

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
