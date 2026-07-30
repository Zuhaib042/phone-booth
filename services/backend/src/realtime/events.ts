import { randomUUID } from "node:crypto";

import type { UserId, UtcTimestamp } from "@project-booth/domain";
import type { MatchState } from "@project-booth/game-engine";
import type { PoolClient } from "pg";

import type { JsonObject } from "../persistence/json.js";
import { toJsonObject } from "../persistence/json.js";
import type { MatchEventRecord } from "../persistence/match-repository.js";
import type { NewOutboxEvent } from "../persistence/outbox.js";

export type ClientAudience = "active" | "participants" | "player";

export interface RealtimeEventEnvelope {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly type: string;
  readonly occurredAt: UtcTimestamp;
  readonly matchId: string;
  readonly matchVersion: number;
  readonly recipientCursor: number;
  readonly audience: ClientAudience;
  readonly recipientUserId?: string;
  readonly payload: JsonObject;
}

export interface ProjectedMatchEvent {
  readonly audience: ClientAudience;
  readonly event: unknown;
  readonly eventType: string;
  readonly matchVersion: number;
  readonly recipientUserId?: UserId;
}

const CLIENT_INTERNAL_FIELDS = new Set([
  "deviceId",
  "deviceInformation",
  "deviceRiskSignals",
  "enforcementDetails",
  "moderationData",
  "moderationNotes",
  "reportId",
]);

const PLAYER_PRIVATE_FIELDS = new Set([
  "ballotTargetId",
  "coinBalance",
  "conversation",
  "conversations",
  "messageBody",
  "offer",
  "offerAmount",
  "offers",
  "outflowAllowance",
  "pendingFunds",
  "privateMessage",
  "privateMessages",
  "submittedBallot",
  "wallet",
  "walletBalance",
]);

function assertSafeValue(
  value: unknown,
  audience: ClientAudience,
  path = "payload",
): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertSafeValue(item, audience, `${path}[${index}]`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (
      CLIENT_INTERNAL_FIELDS.has(key) ||
      (audience !== "player" && PLAYER_PRIVATE_FIELDS.has(key))
    ) {
      throw new Error(`Unsafe real-time field ${path}.${key}`);
    }
    assertSafeValue(child, audience, `${path}.${key}`);
  }
}

function cursorNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RangeError("Recipient cursor exceeded the safe integer range");
  }
  return parsed;
}

function realtimeType(domainEventType: string): string {
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u.test(domainEventType)) {
    throw new TypeError(`Invalid domain event type: ${domainEventType}`);
  }
  return `match.domain.${domainEventType}`;
}

async function nextCursor(client: PoolClient, userId: UserId): Promise<number> {
  const result = await client.query<{ last_cursor: string }>(
    `
      INSERT INTO recipient_streams (user_id, last_cursor)
      VALUES ($1, 1)
      ON CONFLICT (user_id) DO UPDATE
      SET last_cursor = recipient_streams.last_cursor + 1
      RETURNING last_cursor
    `,
    [userId],
  );
  const value = result.rows[0]?.last_cursor;
  if (value === undefined) {
    throw new Error("Recipient cursor was not allocated");
  }
  return cursorNumber(value);
}

function recipientsFor(
  state: MatchState,
  event: ProjectedMatchEvent,
): readonly UserId[] {
  if (event.audience === "player") {
    if (event.recipientUserId === undefined) {
      throw new TypeError("A player event requires a recipient");
    }
    if (
      !state.roster.some(({ playerId }) => playerId === event.recipientUserId)
    ) {
      throw new Error("A player event recipient is not in the match");
    }
    return [event.recipientUserId];
  }
  return state.roster
    .filter(
      ({ status }) => event.audience === "participants" || status === "active",
    )
    .map(({ playerId }) => playerId);
}

export class PostgresRealtimeEventRepository {
  public async appendProjectedEvents(
    client: PoolClient,
    state: MatchState,
    projectedEvents: readonly ProjectedMatchEvent[],
    occurredAt: UtcTimestamp,
  ): Promise<{
    readonly matchEvents: readonly MatchEventRecord[];
    readonly outboxEvents: readonly NewOutboxEvent[];
  }> {
    const matchEvents: MatchEventRecord[] = [];
    const outboxEvents: NewOutboxEvent[] = [];

    for (const [sequence, projected] of projectedEvents.entries()) {
      const payload = toJsonObject(projected.event);
      assertSafeValue(payload, projected.audience);
      const matchEventId = randomUUID();
      matchEvents.push({
        eventId: matchEventId,
        matchId: state.matchId,
        matchVersion: projected.matchVersion as MatchState["version"],
        sequence,
        eventType: projected.eventType,
        payload,
        occurredAt,
      });

      for (const recipientUserId of recipientsFor(state, projected)) {
        const recipientCursor = await nextCursor(client, recipientUserId);
        const eventId = randomUUID();
        const envelope: RealtimeEventEnvelope = {
          schemaVersion: 1,
          eventId,
          type: realtimeType(projected.eventType),
          occurredAt,
          matchId: state.matchId,
          matchVersion: projected.matchVersion,
          recipientCursor,
          audience: projected.audience,
          ...(projected.audience === "player" ? { recipientUserId } : {}),
          payload,
        };
        await client.query(
          `
            INSERT INTO recipient_events (
              user_id,
              recipient_cursor,
              event_id,
              event_type,
              occurred_at,
              match_id,
              match_version,
              audience,
              payload
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
          `,
          [
            recipientUserId,
            recipientCursor,
            eventId,
            envelope.type,
            occurredAt,
            state.matchId,
            projected.matchVersion,
            projected.audience,
            JSON.stringify(payload),
          ],
        );
        outboxEvents.push({
          eventId,
          aggregateType: "realtime-recipient",
          aggregateId: recipientUserId,
          eventType: "realtime.delivery",
          payload: toJsonObject(envelope),
          occurredAt,
        });
      }
    }
    return { matchEvents, outboxEvents };
  }
}

interface RecipientEventRow {
  readonly audience: ClientAudience;
  readonly event_id: string;
  readonly event_type: string;
  readonly match_id: string;
  readonly match_version: string;
  readonly occurred_at: Date;
  readonly payload: JsonObject;
  readonly recipient_cursor: string;
}

function envelopeFromRow(
  row: RecipientEventRow,
  recipientUserId: string,
): RealtimeEventEnvelope {
  const audience = row.audience;
  return {
    schemaVersion: 1,
    eventId: row.event_id,
    type: row.event_type,
    occurredAt: row.occurred_at.toISOString() as UtcTimestamp,
    matchId: row.match_id,
    matchVersion: Number(row.match_version),
    recipientCursor: cursorNumber(row.recipient_cursor),
    audience,
    ...(audience === "player" ? { recipientUserId } : {}),
    payload: row.payload,
  };
}

export interface MatchSnapshot {
  readonly lastRecipientCursor: number;
  readonly matchId: string;
  readonly matchVersion: number;
  readonly phase: MatchState["phase"];
  readonly phaseDeadline: UtcTimestamp | null;
  readonly roster: readonly {
    readonly avatarKey: string;
    readonly displayName: string;
    readonly ready: boolean;
    readonly status: "active" | "eliminated";
    readonly userId: string;
  }[];
  readonly ruleset: {
    readonly rulesetId: string;
    readonly rulesetVersion: number;
  };
  readonly self: {
    readonly ready: boolean;
    readonly userId: string;
  };
}

export class RealtimeNotFoundError extends Error {
  public readonly code = "match_not_found";
  public readonly statusCode = 404;

  public constructor() {
    super("The match was not found");
    this.name = "RealtimeNotFoundError";
  }
}

export class RealtimeForbiddenError extends Error {
  public readonly code = "match_forbidden";
  public readonly statusCode = 403;

  public constructor() {
    super("The account is not a participant in this match");
    this.name = "RealtimeForbiddenError";
  }
}

export class PostgresRealtimeQueryService {
  public constructor(
    private readonly runTransaction: <Result>(
      action: (client: PoolClient) => Promise<Result>,
    ) => Promise<Result>,
  ) {}

  public getSnapshot(userId: string, matchId: string): Promise<MatchSnapshot> {
    return this.runTransaction(async (client) => {
      const match = await client.query<{
        id: string;
        phase: MatchState["phase"];
        phase_deadline: Date | null;
        ruleset_id: string;
        ruleset_version: number;
        version: string;
      }>(
        `
          SELECT
            id,
            phase,
            phase_deadline,
            ruleset_id,
            ruleset_version,
            version
          FROM matches
          WHERE id = $1
        `,
        [matchId],
      );
      const row = match.rows[0];
      if (row === undefined) {
        throw new RealtimeNotFoundError();
      }
      const roster = await client.query<{
        avatar_key: string | null;
        display_name: string | null;
        player_id: string;
        ready: boolean;
        status: "active" | "eliminated";
      }>(
        `
          SELECT
            player.player_id,
            player.status,
            player.ready,
            profile.display_name,
            profile.avatar_key
          FROM match_players AS player
          LEFT JOIN profiles AS profile ON profile.user_id = player.player_id
          WHERE player.match_id = $1
          ORDER BY player.roster_position
        `,
        [matchId],
      );
      const self = roster.rows.find(({ player_id }) => player_id === userId);
      if (self === undefined) {
        throw new RealtimeForbiddenError();
      }
      const stream = await client.query<{ last_cursor: string }>(
        "SELECT last_cursor FROM recipient_streams WHERE user_id = $1",
        [userId],
      );
      const cursor = Number(stream.rows[0]?.last_cursor ?? "0");
      return {
        lastRecipientCursor: cursor,
        matchId: row.id,
        matchVersion: Number(row.version),
        phase: row.phase,
        phaseDeadline:
          (row.phase_deadline?.toISOString() as UtcTimestamp | undefined) ??
          null,
        roster: roster.rows.map((entry) => ({
          avatarKey: entry.avatar_key ?? "avatar.deleted",
          displayName: entry.display_name ?? "Deleted Player",
          ready: entry.ready,
          status: entry.status,
          userId: entry.player_id,
        })),
        ruleset: {
          rulesetId: row.ruleset_id,
          rulesetVersion: row.ruleset_version,
        },
        self: { ready: self.ready, userId },
      };
    });
  }

  public listEvents(
    userId: string,
    afterCursor: number,
    limit: number,
  ): Promise<{
    readonly events: readonly RealtimeEventEnvelope[];
    readonly hasMore: boolean;
    readonly nextCursor: number;
  }> {
    return this.runTransaction(async (client) => {
      const result = await client.query<RecipientEventRow>(
        `
          SELECT
            recipient_cursor,
            event_id,
            event_type,
            occurred_at,
            match_id,
            match_version,
            audience,
            payload
          FROM recipient_events
          WHERE user_id = $1 AND recipient_cursor > $2
          ORDER BY recipient_cursor
          LIMIT $3
        `,
        [userId, afterCursor, limit + 1],
      );
      const rows = result.rows.slice(0, limit);
      const events = rows.map((row) => envelopeFromRow(row, userId));
      return {
        events,
        hasMore: result.rows.length > limit,
        nextCursor: events.at(-1)?.recipientCursor ?? afterCursor,
      };
    });
  }
}
