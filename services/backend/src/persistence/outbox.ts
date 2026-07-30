import { randomUUID } from "node:crypto";

import type { UtcTimestamp } from "@project-booth/domain";
import type { PoolClient } from "pg";

import type { JsonObject } from "./json.js";
import type { PostgresTransactionRunner } from "./transaction.js";

export interface NewOutboxEvent {
  readonly eventId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: JsonObject;
  readonly occurredAt: UtcTimestamp;
  readonly availableAt?: UtcTimestamp;
}

export interface ClaimedOutboxEvent extends NewOutboxEvent {
  readonly attemptCount: number;
  readonly claimToken: string;
}

interface OutboxRow {
  readonly id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly event_type: string;
  readonly payload: JsonObject;
  readonly occurred_at: Date;
  readonly available_at: Date;
  readonly attempt_count: number;
  readonly claim_token: string;
}

function fromRow(row: OutboxRow): ClaimedOutboxEvent {
  return {
    eventId: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    occurredAt: row.occurred_at.toISOString() as UtcTimestamp,
    availableAt: row.available_at.toISOString() as UtcTimestamp,
    attemptCount: row.attempt_count,
    claimToken: row.claim_token,
  };
}

export class PostgresOutboxRepository {
  public async enqueue(
    client: PoolClient,
    events: readonly NewOutboxEvent[],
  ): Promise<void> {
    for (const event of events) {
      await client.query(
        `
          INSERT INTO outbox_events (
            id,
            aggregate_type,
            aggregate_id,
            event_type,
            payload,
            occurred_at,
            available_at
          )
          VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
          ON CONFLICT (id) DO NOTHING
        `,
        [
          event.eventId,
          event.aggregateType,
          event.aggregateId,
          event.eventType,
          JSON.stringify(event.payload),
          event.occurredAt,
          event.availableAt ?? event.occurredAt,
        ],
      );
    }
  }

  public async claim(
    client: PoolClient,
    options: {
      readonly workerId: string;
      readonly now: Date;
      readonly leaseMilliseconds: number;
      readonly batchSize: number;
    },
  ): Promise<readonly ClaimedOutboxEvent[]> {
    const claimToken = randomUUID();
    const claimUntil = new Date(
      options.now.getTime() + options.leaseMilliseconds,
    );
    const result = await client.query<OutboxRow>(
      `
        WITH candidates AS (
          SELECT id
          FROM outbox_events
          WHERE
            published_at IS NULL
            AND available_at <= $1
            AND (claim_until IS NULL OR claim_until <= $1)
          ORDER BY available_at, occurred_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT $2
        )
        UPDATE outbox_events AS event
        SET
          attempt_count = event.attempt_count + 1,
          claim_token = $3,
          claimed_by = $4,
          claim_until = $5,
          last_error = NULL
        FROM candidates
        WHERE event.id = candidates.id
        RETURNING
          event.id,
          event.aggregate_type,
          event.aggregate_id,
          event.event_type,
          event.payload,
          event.occurred_at,
          event.available_at,
          event.attempt_count,
          event.claim_token
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

  public async markPublished(
    client: PoolClient,
    event: ClaimedOutboxEvent,
    publishedAt: Date,
  ): Promise<boolean> {
    const result = await client.query(
      `
        UPDATE outbox_events
        SET
          published_at = $3,
          claim_token = NULL,
          claimed_by = NULL,
          claim_until = NULL,
          last_error = NULL
        WHERE id = $1 AND claim_token = $2 AND published_at IS NULL
      `,
      [event.eventId, event.claimToken, publishedAt],
    );
    return result.rowCount === 1;
  }

  public async recordFailure(
    client: PoolClient,
    event: ClaimedOutboxEvent,
    error: unknown,
    availableAt: Date,
  ): Promise<boolean> {
    const result = await client.query(
      `
        UPDATE outbox_events
        SET
          available_at = $3,
          claim_token = NULL,
          claimed_by = NULL,
          claim_until = NULL,
          last_error = $4
        WHERE id = $1 AND claim_token = $2 AND published_at IS NULL
      `,
      [
        event.eventId,
        event.claimToken,
        availableAt,
        error instanceof Error ? error.message : String(error),
      ],
    );
    return result.rowCount === 1;
  }
}

export interface OutboxPublisher {
  publish(event: ClaimedOutboxEvent): Promise<void>;
}

export class OutboxProcessor {
  public constructor(
    private readonly transactions: PostgresTransactionRunner,
    private readonly repository: PostgresOutboxRepository,
    private readonly publisher: OutboxPublisher,
  ) {}

  public async claim(options: {
    readonly workerId: string;
    readonly now: Date;
    readonly leaseMilliseconds: number;
    readonly batchSize: number;
  }): Promise<readonly ClaimedOutboxEvent[]> {
    return this.transactions.run((client) =>
      this.repository.claim(client, options),
    );
  }

  public async publishClaimed(
    events: readonly ClaimedOutboxEvent[],
    now: () => Date = () => new Date(),
  ): Promise<number> {
    let published = 0;
    for (const event of events) {
      try {
        await this.publisher.publish(event);
        const acknowledged = await this.transactions.run((client) =>
          this.repository.markPublished(client, event, now()),
        );
        if (acknowledged) {
          published += 1;
        }
      } catch (error: unknown) {
        const delay = Math.min(60_000, 250 * 2 ** event.attemptCount);
        await this.transactions.run((client) =>
          this.repository.recordFailure(
            client,
            event,
            error,
            new Date(now().getTime() + delay),
          ),
        );
      }
    }
    return published;
  }
}
