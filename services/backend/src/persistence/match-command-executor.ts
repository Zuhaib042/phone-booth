import { randomUUID } from "node:crypto";

import type { MatchId, UserId, UtcTimestamp } from "@project-booth/domain";
import type { MatchState } from "@project-booth/game-engine";

import {
  hashIdempotencyRequest,
  type IdempotencyIdentity,
  PostgresIdempotencyRepository,
  type StoredHttpResponse,
} from "./idempotency.js";
import type { JsonValue } from "./json.js";
import { toJsonObject } from "./json.js";
import {
  type MatchEventRecord,
  PostgresMatchRepository,
} from "./match-repository.js";
import { type NewOutboxEvent, PostgresOutboxRepository } from "./outbox.js";
import { PostgresScheduledJobRepository } from "./scheduled-jobs.js";
import type { PostgresTransactionRunner } from "./transaction.js";

export interface MatchCommandTransition {
  readonly state: MatchState;
  readonly events: readonly unknown[];
  readonly response: StoredHttpResponse;
}

export interface ExecuteMatchCommandInput {
  readonly accountId: UserId;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly request: JsonValue;
  readonly matchId: MatchId;
  readonly occurredAt: UtcTimestamp;
  apply(
    state: MatchState,
  ): Promise<MatchCommandTransition> | MatchCommandTransition;
}

export class MatchNotFoundError extends Error {
  public constructor(public readonly matchId: MatchId) {
    super(`Match ${matchId} was not found`);
    this.name = "MatchNotFoundError";
  }
}

function eventType(event: unknown): string {
  if (
    event === null ||
    typeof event !== "object" ||
    !("type" in event) ||
    typeof event.type !== "string" ||
    event.type.length === 0
  ) {
    throw new TypeError("Match event must have a non-empty type");
  }
  return event.type;
}

function persistenceEvents(
  matchId: MatchId,
  state: MatchState,
  events: readonly unknown[],
  occurredAt: UtcTimestamp,
): {
  readonly matchEvents: readonly MatchEventRecord[];
  readonly outboxEvents: readonly NewOutboxEvent[];
} {
  const records = events.map((event, sequence) => {
    const id = randomUUID();
    const type = eventType(event);
    const payload = toJsonObject(event);
    return {
      match: {
        eventId: id,
        matchId,
        matchVersion: state.version,
        sequence,
        eventType: type,
        payload,
        occurredAt,
      },
      outbox: {
        eventId: id,
        aggregateType: "match",
        aggregateId: matchId,
        eventType: type,
        payload: toJsonObject({
          eventId: id,
          matchId,
          matchVersion: state.version,
          event: payload,
        }),
        occurredAt,
      },
    };
  });
  return {
    matchEvents: records.map(({ match }) => match),
    outboxEvents: records.map(({ outbox }) => outbox),
  };
}

export class PostgresMatchCommandExecutor {
  public constructor(
    private readonly transactions: PostgresTransactionRunner,
    private readonly matches = new PostgresMatchRepository(),
    private readonly idempotency = new PostgresIdempotencyRepository(),
    private readonly outbox = new PostgresOutboxRepository(),
    private readonly scheduledJobs = new PostgresScheduledJobRepository(),
  ) {}

  public async createMatch(
    state: MatchState,
    occurredAt: UtcTimestamp,
  ): Promise<void> {
    await this.transactions.run(async (client) => {
      await this.matches.create(client, state, occurredAt);
      await this.scheduledJobs.synchronizeMatchDeadline(
        client,
        state,
        occurredAt,
      );
    });
  }

  public execute(input: ExecuteMatchCommandInput): Promise<StoredHttpResponse> {
    const identity: IdempotencyIdentity = {
      accountId: input.accountId,
      operation: input.operation,
      key: input.idempotencyKey,
      requestHash: hashIdempotencyRequest(input.request),
    };

    return this.transactions.run(async (client) => {
      const acquisition = await this.idempotency.acquire(
        client,
        identity,
        input.occurredAt,
      );
      if (!acquisition.acquired) {
        return acquisition.response;
      }

      const current = await this.matches.load(client, input.matchId, {
        forUpdate: true,
      });
      if (current === null) {
        throw new MatchNotFoundError(input.matchId);
      }

      const transition = await input.apply(current);
      if (transition.state.matchId !== current.matchId) {
        throw new Error("Match command changed the match identifier");
      }
      if (transition.state.version < current.version) {
        throw new Error("Match command decreased the match version");
      }
      if (
        transition.state.version === current.version &&
        transition.events.length > 0
      ) {
        throw new Error("An unversioned transition cannot emit events");
      }

      if (transition.state.version > current.version) {
        await this.matches.save(
          client,
          current.version,
          transition.state,
          input.occurredAt,
        );
        const records = persistenceEvents(
          input.matchId,
          transition.state,
          transition.events,
          input.occurredAt,
        );
        await this.matches.appendEvents(client, records.matchEvents);
        await this.outbox.enqueue(client, records.outboxEvents);
        await this.scheduledJobs.synchronizeMatchDeadline(
          client,
          transition.state,
          input.occurredAt,
        );
      }

      await this.idempotency.complete(
        client,
        identity,
        transition.response,
        input.occurredAt,
      );
      return transition.response;
    });
  }
}
