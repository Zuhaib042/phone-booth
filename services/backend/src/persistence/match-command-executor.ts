import type { MatchId, UserId, UtcTimestamp } from "@project-booth/domain";
import type { MatchState } from "@project-booth/game-engine";
import type { PoolClient } from "pg";

import { PostgresRealtimeEventRepository } from "../realtime/events.js";
import {
  hashIdempotencyRequest,
  type IdempotencyIdentity,
  PostgresIdempotencyRepository,
  type StoredHttpResponse,
} from "./idempotency.js";
import type { JsonValue } from "./json.js";
import { PostgresMatchRepository } from "./match-repository.js";
import { PostgresOutboxRepository } from "./outbox.js";
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
  afterApply?(
    client: PoolClient,
    previousState: MatchState,
    transition: MatchCommandTransition,
  ): Promise<void>;
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

function privateRecipient(event: unknown): UserId | undefined {
  if (
    event !== null &&
    typeof event === "object" &&
    "recipientUserId" in event &&
    typeof event.recipientUserId === "string"
  ) {
    return event.recipientUserId as UserId;
  }
  return undefined;
}

export class PostgresMatchCommandExecutor {
  public constructor(
    private readonly transactions: PostgresTransactionRunner,
    private readonly matches = new PostgresMatchRepository(),
    private readonly idempotency = new PostgresIdempotencyRepository(),
    private readonly outbox = new PostgresOutboxRepository(),
    private readonly scheduledJobs = new PostgresScheduledJobRepository(),
    private readonly realtimeEvents = new PostgresRealtimeEventRepository(),
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

      await input.afterApply?.(client, current, transition);

      if (transition.state.version > current.version) {
        await this.matches.save(
          client,
          current.version,
          transition.state,
          input.occurredAt,
        );
        const records = await this.realtimeEvents.appendProjectedEvents(
          client,
          transition.state,
          transition.events.map((event) => {
            const recipientUserId = privateRecipient(event);
            return {
              audience:
                recipientUserId === undefined
                  ? ("participants" as const)
                  : ("player" as const),
              event,
              eventType: eventType(event),
              matchVersion: transition.state.version,
              ...(recipientUserId === undefined ? {} : { recipientUserId }),
            };
          }),
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
