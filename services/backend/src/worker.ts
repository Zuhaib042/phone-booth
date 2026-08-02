import { unlink, writeFile } from "node:fs/promises";

import type { Logger } from "pino";

import {
  loadDatastoreConfig,
  loadEconomyRuntimeConfig,
  loadReliableJobConfig,
  loadWorkerConfig,
  type Environment,
  type WorkerConfig,
} from "./config.js";
import { createRuntimeLogger } from "./logger.js";
import { M8_FIXTURE_ECONOMY_CONFIG } from "./economy/service.js";
import {
  subscribeToShutdownSignals,
  type ShutdownSignal,
  type SignalSubscription,
} from "./process-signals.js";
import { ReliablePostgresWorkerJob } from "./persistence/reliable-worker.js";

export interface WorkerJob {
  readonly name: string;
  execute(): Promise<void>;
  stop?(): Promise<void>;
}

export interface ReadinessReporter {
  markNotReady(): Promise<void>;
  markReady(): Promise<void>;
}

export interface RunningWorker {
  readonly config: WorkerConfig;
  readonly runtime: WorkerRuntime;
  readonly signals: SignalSubscription;
}

export const STARTUP_NOOP_JOB: WorkerJob = {
  name: "startup-noop",
  async execute(): Promise<void> {},
};

export class FileReadinessReporter implements ReadinessReporter {
  public constructor(private readonly path: string) {}

  public async markReady(): Promise<void> {
    await writeFile(this.path, `${process.pid}\n`, { mode: 0o600 });
  }

  public async markNotReady(): Promise<void> {
    try {
      await unlink(this.path);
    } catch (error: unknown) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        throw error;
      }
    }
  }
}

export class WorkerRuntime {
  private idleTimer: NodeJS.Timeout | undefined;
  private ready = false;
  private resolveStopped!: () => void;
  private started = false;
  private stopPromise: Promise<void> | undefined;
  public readonly stopped = new Promise<void>((resolve) => {
    this.resolveStopped = resolve;
  });

  public constructor(
    private readonly logger: Logger,
    private readonly readiness: ReadinessReporter,
    private readonly startupJob: WorkerJob = STARTUP_NOOP_JOB,
  ) {}

  public get isReady(): boolean {
    return this.ready;
  }

  public async start(): Promise<void> {
    if (this.started) {
      throw new Error("Worker runtime can only be started once");
    }
    this.started = true;

    await this.readiness.markNotReady();
    this.logger.info({ job: this.startupJob.name }, "Worker job started");
    await this.startupJob.execute();
    this.logger.info({ job: this.startupJob.name }, "Worker job completed");
    await this.readiness.markReady();

    this.ready = true;
    this.idleTimer = setInterval(() => undefined, 60_000);
  }

  public stop(signal: ShutdownSignal): Promise<void> {
    this.stopPromise ??= (async () => {
      this.logger.info({ signal }, "Worker shutdown requested");
      this.ready = false;

      if (this.idleTimer !== undefined) {
        clearInterval(this.idleTimer);
        this.idleTimer = undefined;
      }

      try {
        await this.startupJob.stop?.();
        await this.readiness.markNotReady();
        this.logger.info({ signal }, "Worker shutdown complete");
      } finally {
        this.resolveStopped();
      }
    })();

    return this.stopPromise;
  }
}

export async function startWorker(
  environment: Environment = process.env,
): Promise<RunningWorker> {
  const config = loadWorkerConfig(environment);
  const logger = createRuntimeLogger(config, "backend-worker");
  const { DATABASE_URL: databaseUrl, VALKEY_URL: valkeyUrl } = environment;
  const hasDatastoreEnvironment =
    databaseUrl !== undefined || valkeyUrl !== undefined;
  const job =
    config.nodeEnvironment === "test" && !hasDatastoreEnvironment
      ? STARTUP_NOOP_JOB
      : new ReliablePostgresWorkerJob(
          logger,
          loadDatastoreConfig(environment),
          loadReliableJobConfig(environment),
          undefined,
          loadEconomyRuntimeConfig(environment).fixtureValuesEnabled
            ? M8_FIXTURE_ECONOMY_CONFIG
            : undefined,
        );
  const runtime = new WorkerRuntime(
    logger,
    new FileReadinessReporter(config.readinessFile),
    job,
  );

  await runtime.start();

  const signals = subscribeToShutdownSignals((signal) => {
    void runtime.stop(signal).catch((error: unknown) => {
      logger.error({ err: error, signal }, "Worker shutdown failed");
      process.exitCode = 1;
    });
  });
  void runtime.stopped.then(() => signals.dispose());
  logger.info("Worker ready");

  return { config, runtime, signals };
}
