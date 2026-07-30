import { randomUUID } from "node:crypto";

import type { UtcTimestamp } from "@project-booth/domain";
import type { MatchState } from "@project-booth/game-engine";
import type { PoolClient } from "pg";

import type { JsonObject } from "./json.js";
import type { PostgresTransactionRunner } from "./transaction.js";

export const MATCH_DEADLINE_JOB_KIND = "match.deadline";

export interface MatchDeadlinePayload extends JsonObject {
  readonly matchId: string;
  readonly expectedVersion: number;
  readonly expectedPhase: string;
  readonly expectedDeadline: string | null;
}

export interface ClaimedScheduledJob {
  readonly jobId: string;
  readonly kind: string;
  readonly deduplicationKey: string;
  readonly payload: JsonObject;
  readonly runAt: UtcTimestamp;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly claimToken: string;
}

interface ScheduledJobRow {
  readonly id: string;
  readonly kind: string;
  readonly deduplication_key: string;
  readonly payload: JsonObject;
  readonly run_at: Date;
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly claim_token: string;
}

function fromRow(row: ScheduledJobRow): ClaimedScheduledJob {
  return {
    jobId: row.id,
    kind: row.kind,
    deduplicationKey: row.deduplication_key,
    payload: row.payload,
    runAt: row.run_at.toISOString() as UtcTimestamp,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    claimToken: row.claim_token,
  };
}

function needsDeadlineJob(state: MatchState): boolean {
  return state.phase !== "complete" && state.phase !== "cancelled";
}

export class PostgresScheduledJobRepository {
  public async synchronizeMatchDeadline(
    client: PoolClient,
    state: MatchState,
    now: UtcTimestamp,
  ): Promise<void> {
    const deduplicationKey = `match-deadline:${state.matchId}:${state.version}`;
    await client.query(
      `
        UPDATE scheduled_jobs
        SET
          status = 'cancelled',
          claim_token = NULL,
          claimed_by = NULL,
          claim_until = NULL,
          updated_at = $3
        WHERE
          kind = $1
          AND payload ->> 'matchId' = $2
          AND deduplication_key <> $4
          AND status = 'pending'
      `,
      [MATCH_DEADLINE_JOB_KIND, state.matchId, now, deduplicationKey],
    );

    if (!needsDeadlineJob(state)) {
      return;
    }

    const payload: MatchDeadlinePayload = {
      matchId: state.matchId,
      expectedVersion: state.version,
      expectedPhase: state.phase,
      expectedDeadline: state.phaseDeadline,
    };
    await client.query(
      `
        INSERT INTO scheduled_jobs (
          id,
          kind,
          deduplication_key,
          payload,
          run_at,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4::jsonb, $5, $6, $6)
        ON CONFLICT (deduplication_key) DO NOTHING
      `,
      [
        randomUUID(),
        MATCH_DEADLINE_JOB_KIND,
        deduplicationKey,
        JSON.stringify(payload),
        state.phaseDeadline ?? now,
        now,
      ],
    );
  }

  public async claim(
    client: PoolClient,
    options: {
      readonly workerId: string;
      readonly now: Date;
      readonly leaseMilliseconds: number;
      readonly batchSize: number;
    },
  ): Promise<readonly ClaimedScheduledJob[]> {
    const claimToken = randomUUID();
    const claimUntil = new Date(
      options.now.getTime() + options.leaseMilliseconds,
    );
    const result = await client.query<ScheduledJobRow>(
      `
        WITH candidates AS (
          SELECT id
          FROM scheduled_jobs
          WHERE
            status IN ('pending', 'processing')
            AND run_at <= $1
            AND (claim_until IS NULL OR claim_until <= $1)
            AND attempt_count < max_attempts
          ORDER BY run_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT $2
        )
        UPDATE scheduled_jobs AS job
        SET
          status = 'processing',
          attempt_count = job.attempt_count + 1,
          claim_token = $3,
          claimed_by = $4,
          claim_until = $5,
          updated_at = $1,
          last_error = NULL
        FROM candidates
        WHERE job.id = candidates.id
        RETURNING
          job.id,
          job.kind,
          job.deduplication_key,
          job.payload,
          job.run_at,
          job.attempt_count,
          job.max_attempts,
          job.claim_token
      `,
      [
        options.now,
        options.batchSize,
        claimToken,
        options.workerId,
        claimUntil,
      ],
    );
    return result.rows.map(fromRow);
  }

  public async lockClaimed(
    client: PoolClient,
    job: ClaimedScheduledJob,
  ): Promise<boolean> {
    const result = await client.query(
      `
        SELECT id
        FROM scheduled_jobs
        WHERE id = $1 AND claim_token = $2 AND status = 'processing'
        FOR UPDATE
      `,
      [job.jobId, job.claimToken],
    );
    return result.rowCount === 1;
  }

  public async complete(
    client: PoolClient,
    job: ClaimedScheduledJob,
    completedAt: UtcTimestamp,
  ): Promise<void> {
    const result = await client.query(
      `
        UPDATE scheduled_jobs
        SET
          status = 'completed',
          completed_at = $3,
          claim_token = NULL,
          claimed_by = NULL,
          claim_until = NULL,
          updated_at = $3,
          last_error = NULL
        WHERE id = $1 AND claim_token = $2 AND status = 'processing'
      `,
      [job.jobId, job.claimToken, completedAt],
    );
    if (result.rowCount !== 1) {
      throw new Error(`Scheduled job ${job.jobId} lost its claim`);
    }
  }

  public async fail(
    client: PoolClient,
    job: ClaimedScheduledJob,
    error: unknown,
    retryAt: Date,
  ): Promise<void> {
    const terminal = job.attemptCount >= job.maxAttempts;
    await client.query(
      `
        UPDATE scheduled_jobs
        SET
          status = $3,
          run_at = $4,
          claim_token = NULL,
          claimed_by = NULL,
          claim_until = NULL,
          updated_at = $5,
          last_error = $6
        WHERE id = $1 AND claim_token = $2 AND status = 'processing'
      `,
      [
        job.jobId,
        job.claimToken,
        terminal ? "failed" : "pending",
        retryAt,
        new Date(),
        error instanceof Error ? error.message : String(error),
      ],
    );
  }
}

export type ScheduledJobHandler = (
  client: PoolClient,
  job: ClaimedScheduledJob,
  occurredAt: UtcTimestamp,
) => Promise<void>;

export class ScheduledJobProcessor {
  public constructor(
    private readonly transactions: PostgresTransactionRunner,
    private readonly repository: PostgresScheduledJobRepository,
    private readonly handler: ScheduledJobHandler,
  ) {}

  public claim(options: {
    readonly workerId: string;
    readonly now: Date;
    readonly leaseMilliseconds: number;
    readonly batchSize: number;
  }): Promise<readonly ClaimedScheduledJob[]> {
    return this.transactions.run((client) =>
      this.repository.claim(client, options),
    );
  }

  public async process(
    job: ClaimedScheduledJob,
    occurredAt: UtcTimestamp,
  ): Promise<boolean> {
    try {
      return await this.transactions.run(async (client) => {
        if (!(await this.repository.lockClaimed(client, job))) {
          return false;
        }
        await this.handler(client, job, occurredAt);
        await this.repository.complete(client, job, occurredAt);
        return true;
      });
    } catch (error: unknown) {
      const delay = Math.min(60_000, 250 * 2 ** job.attemptCount);
      await this.transactions.run((client) =>
        this.repository.fail(
          client,
          job,
          error,
          new Date(Date.parse(occurredAt) + delay),
        ),
      );
      return false;
    }
  }
}
