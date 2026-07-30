import { randomUUID } from "node:crypto";

import { utcTimestampFromDate, type UtcTimestamp } from "@project-booth/domain";
import { Redis as Valkey } from "iovalkey";
import type { Logger } from "pino";

import type { DatastoreConfig, ReliableJobConfig } from "../config.js";
import type { WorkerJob } from "../worker.js";
import { createDatabasePool } from "./database.js";
import { MatchDeadlineHandler } from "./deadline-handler.js";
import { runMigrations } from "./migrations.js";
import {
  type ClaimedOutboxEvent,
  OutboxProcessor,
  type OutboxPublisher,
  PostgresOutboxRepository,
} from "./outbox.js";
import { MatchRecoveryService } from "./recovery.js";
import {
  PostgresScheduledJobRepository,
  ScheduledJobProcessor,
} from "./scheduled-jobs.js";
import { PostgresTransactionRunner } from "./transaction.js";

function timestamp(date: Date): UtcTimestamp {
  const parsed = utcTimestampFromDate(date);
  if (!parsed.ok) {
    throw new RangeError("Worker clock returned an invalid date");
  }
  return parsed.value;
}

class ValkeyOutboxPublisher implements OutboxPublisher {
  public constructor(
    private readonly valkey: Valkey,
    private readonly channel: string,
  ) {}

  public async publish(event: ClaimedOutboxEvent): Promise<void> {
    await this.valkey.publish(
      this.channel,
      JSON.stringify({
        id: event.eventId,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        type: event.eventType,
        occurredAt: event.occurredAt,
        payload: event.payload,
      }),
    );
  }
}

class ReliableJobLoop {
  private activePoll: Promise<void> | undefined;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly logger: Logger,
    private readonly config: ReliableJobConfig,
    private readonly workerId: string,
    private readonly outbox: OutboxProcessor,
    private readonly scheduled: ScheduledJobProcessor,
  ) {}

  public start(): void {
    if (this.timer !== undefined || this.stopped) {
      throw new Error("Reliable job loop can only be started once");
    }
    this.timer = setInterval(
      () => this.beginPoll(),
      this.config.pollIntervalMilliseconds,
    );
    this.beginPoll();
  }

  private beginPoll(): void {
    if (this.activePoll !== undefined || this.stopped) {
      return;
    }
    this.activePoll = this.poll()
      .catch((error: unknown) => {
        this.logger.error({ err: error }, "Reliable job poll failed");
      })
      .finally(() => {
        this.activePoll = undefined;
      });
  }

  private async poll(): Promise<void> {
    const now = new Date();
    const claimOptions = {
      workerId: this.workerId,
      now,
      leaseMilliseconds: this.config.leaseMilliseconds,
      batchSize: this.config.batchSize,
    };
    const outboxEvents = await this.outbox.claim(claimOptions);
    await this.outbox.publishClaimed(outboxEvents);

    const jobs = await this.scheduled.claim({
      ...claimOptions,
      now: new Date(),
    });
    for (const job of jobs) {
      await this.scheduled.process(job, timestamp(new Date()));
    }
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.activePoll;
  }
}

export class ReliablePostgresWorkerJob implements WorkerJob {
  public readonly name = "postgres-reliable-jobs";
  private readonly pool;
  private readonly valkey;
  private loop: ReliableJobLoop | undefined;

  public constructor(
    private readonly logger: Logger,
    datastores: DatastoreConfig,
    private readonly config: ReliableJobConfig,
    private readonly workerId = randomUUID(),
  ) {
    this.pool = createDatabasePool({
      applicationName: "project-booth-worker",
      connectionString: datastores.databaseUrl,
    });
    this.valkey = new Valkey(datastores.valkeyUrl, {
      connectTimeout: 5_000,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
  }

  public async execute(): Promise<void> {
    try {
      await Promise.all([runMigrations(this.pool), this.valkey.connect()]);
      const transactions = new PostgresTransactionRunner(this.pool);
      const outboxRepository = new PostgresOutboxRepository();
      const scheduledRepository = new PostgresScheduledJobRepository();
      const deadlineHandler = new MatchDeadlineHandler(
        undefined,
        outboxRepository,
        scheduledRepository,
      );
      const recovery = new MatchRecoveryService(
        transactions,
        undefined,
        scheduledRepository,
      );
      const recovered = await recovery.recoverActiveMatches(
        timestamp(new Date()),
      );
      this.logger.info({ recovered }, "Active matches recovered");

      this.loop = new ReliableJobLoop(
        this.logger,
        this.config,
        this.workerId,
        new OutboxProcessor(
          transactions,
          outboxRepository,
          new ValkeyOutboxPublisher(this.valkey, this.config.outboxChannel),
        ),
        new ScheduledJobProcessor(
          transactions,
          scheduledRepository,
          (client, job, occurredAt) =>
            deadlineHandler.handle(client, job, occurredAt),
        ),
      );
      this.loop.start();
    } catch (error: unknown) {
      await this.closeResources();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    await this.loop?.stop();
    await this.closeResources();
  }

  private async closeResources(): Promise<void> {
    this.valkey.disconnect();
    await this.pool.end().catch(() => undefined);
  }
}
