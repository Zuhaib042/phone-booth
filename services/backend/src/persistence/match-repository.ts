import type { MatchId, UtcTimestamp } from "@project-booth/domain";
import type { MatchState, MatchVersion } from "@project-booth/game-engine";
import type { PoolClient } from "pg";

import type { JsonObject } from "./json.js";
import { toJsonObject } from "./json.js";
import { decodeMatchState } from "./match-state-codec.js";
import { lockMatchRows } from "./transaction.js";

export interface MatchEventRecord {
  readonly eventId: string;
  readonly matchId: MatchId;
  readonly matchVersion: MatchVersion;
  readonly sequence: number;
  readonly eventType: string;
  readonly payload: JsonObject;
  readonly occurredAt: UtcTimestamp;
}

export interface MatchRepository {
  create(
    client: PoolClient,
    state: MatchState,
    occurredAt: UtcTimestamp,
  ): Promise<void>;
  load(
    client: PoolClient,
    matchId: MatchId,
    options?: { readonly forUpdate?: boolean },
  ): Promise<MatchState | null>;
  save(
    client: PoolClient,
    expectedVersion: MatchVersion,
    state: MatchState,
    occurredAt: UtcTimestamp,
  ): Promise<void>;
  appendEvents(
    client: PoolClient,
    events: readonly MatchEventRecord[],
  ): Promise<void>;
  listActive(client: PoolClient): Promise<readonly MatchState[]>;
}

export class MatchVersionConflictError extends Error {
  public constructor(
    public readonly matchId: MatchId,
    public readonly expectedVersion: MatchVersion,
  ) {
    super(
      `Match ${matchId} is no longer at expected version ${expectedVersion}`,
    );
    this.name = "MatchVersionConflictError";
  }
}

export class RulesetSnapshotConflictError extends Error {
  public constructor(rulesetId: string, version: number) {
    super(`Ruleset ${rulesetId} version ${version} has a different snapshot`);
    this.name = "RulesetSnapshotConflictError";
  }
}

interface MatchRow {
  readonly id: string;
  readonly version: string;
  readonly phase: string;
  readonly phase_deadline: Date | null;
  readonly state_snapshot: unknown;
}

function timestampString(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function verifyRowMatchesSnapshot(row: MatchRow, state: MatchState): void {
  if (
    row.id !== state.matchId ||
    Number(row.version) !== state.version ||
    row.phase !== state.phase ||
    timestampString(row.phase_deadline) !== state.phaseDeadline
  ) {
    throw new Error(`Match ${row.id} columns disagree with its snapshot`);
  }
}

async function persistRuleset(
  client: PoolClient,
  state: MatchState,
): Promise<void> {
  const ruleset = state.rulesetSnapshot;
  await client.query(
    `
      INSERT INTO rulesets (id, version, schema_version, snapshot)
      VALUES ($1, $2, $3, $4::jsonb)
      ON CONFLICT (id, version) DO NOTHING
    `,
    [
      ruleset.rulesetId,
      ruleset.rulesetVersion,
      ruleset.schemaVersion,
      toJsonObject(ruleset),
    ],
  );
  const existing = await client.query<{ snapshot_matches: boolean }>(
    `
      SELECT snapshot = $3::jsonb AS snapshot_matches
      FROM rulesets
      WHERE id = $1 AND version = $2
    `,
    [
      ruleset.rulesetId,
      ruleset.rulesetVersion,
      JSON.stringify(toJsonObject(ruleset)),
    ],
  );
  if (existing.rows[0]?.snapshot_matches !== true) {
    throw new RulesetSnapshotConflictError(
      ruleset.rulesetId,
      ruleset.rulesetVersion,
    );
  }
}

async function insertRoster(
  client: PoolClient,
  state: MatchState,
): Promise<void> {
  for (const [position, entry] of state.roster.entries()) {
    await client.query(
      `
        INSERT INTO match_players (
          match_id, player_id, roster_position, status, ready
        )
        VALUES ($1, $2, $3, $4, $5)
      `,
      [
        state.matchId,
        entry.playerId,
        position,
        entry.status,
        state.readyPlayerIds.includes(entry.playerId),
      ],
    );
  }
}

async function updateRoster(
  client: PoolClient,
  state: MatchState,
): Promise<void> {
  for (const entry of state.roster) {
    const result = await client.query(
      `
        UPDATE match_players
        SET status = $3, ready = $4
        WHERE match_id = $1 AND player_id = $2
      `,
      [
        state.matchId,
        entry.playerId,
        entry.status,
        state.readyPlayerIds.includes(entry.playerId),
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error(
        `Persisted roster is missing player ${entry.playerId} in match ${state.matchId}`,
      );
    }
  }
}

async function persistCompletedRounds(
  client: PoolClient,
  state: MatchState,
  occurredAt: UtcTimestamp,
): Promise<void> {
  for (const [index, round] of state.completedRounds.entries()) {
    const result = await client.query(
      `
        INSERT INTO rounds (
          match_id, round_number, snapshot, completed_at
        )
        VALUES ($1, $2, $3::jsonb, $4)
        ON CONFLICT (match_id, round_number) DO UPDATE
        SET snapshot = EXCLUDED.snapshot
        WHERE rounds.snapshot = EXCLUDED.snapshot
      `,
      [state.matchId, index + 1, toJsonObject(round), occurredAt],
    );
    if (result.rowCount !== 1) {
      throw new Error(
        `Completed round ${index + 1} changed for match ${state.matchId}`,
      );
    }
  }
}

export class PostgresMatchRepository implements MatchRepository {
  public async create(
    client: PoolClient,
    state: MatchState,
    occurredAt: UtcTimestamp,
  ): Promise<void> {
    await persistRuleset(client, state);
    await client.query(
      `
        INSERT INTO matches (
          id,
          ruleset_id,
          ruleset_version,
          version,
          phase,
          phase_deadline,
          state_snapshot,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)
      `,
      [
        state.matchId,
        state.rulesetSnapshot.rulesetId,
        state.rulesetSnapshot.rulesetVersion,
        state.version,
        state.phase,
        state.phaseDeadline,
        toJsonObject(state),
        occurredAt,
      ],
    );
    await insertRoster(client, state);
    await persistCompletedRounds(client, state, occurredAt);
  }

  public async load(
    client: PoolClient,
    matchId: MatchId,
    options: { readonly forUpdate?: boolean } = {},
  ): Promise<MatchState | null> {
    if (options.forUpdate === true) {
      await lockMatchRows(client, [matchId]);
    }
    const result = await client.query<MatchRow>(
      `
        SELECT id, version, phase, phase_deadline, state_snapshot
        FROM matches
        WHERE id = $1
      `,
      [matchId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    const state = decodeMatchState(row.state_snapshot);
    verifyRowMatchesSnapshot(row, state);
    return state;
  }

  public async save(
    client: PoolClient,
    expectedVersion: MatchVersion,
    state: MatchState,
    occurredAt: UtcTimestamp,
  ): Promise<void> {
    if (state.version < expectedVersion) {
      throw new MatchVersionConflictError(state.matchId, expectedVersion);
    }
    const result = await client.query(
      `
        UPDATE matches
        SET
          version = $3,
          phase = $4,
          phase_deadline = $5,
          state_snapshot = $6::jsonb,
          updated_at = $7
        WHERE id = $1 AND version = $2
      `,
      [
        state.matchId,
        expectedVersion,
        state.version,
        state.phase,
        state.phaseDeadline,
        toJsonObject(state),
        occurredAt,
      ],
    );
    if (result.rowCount !== 1) {
      throw new MatchVersionConflictError(state.matchId, expectedVersion);
    }
    await updateRoster(client, state);
    await persistCompletedRounds(client, state, occurredAt);
  }

  public async appendEvents(
    client: PoolClient,
    events: readonly MatchEventRecord[],
  ): Promise<void> {
    for (const event of events) {
      await client.query(
        `
          INSERT INTO match_events (
            id,
            match_id,
            match_version,
            sequence,
            event_type,
            payload,
            occurred_at
          )
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
          ON CONFLICT (id) DO NOTHING
        `,
        [
          event.eventId,
          event.matchId,
          event.matchVersion,
          event.sequence,
          event.eventType,
          event.payload,
          event.occurredAt,
        ],
      );
    }
  }

  public async listActive(client: PoolClient): Promise<readonly MatchState[]> {
    const result = await client.query<MatchRow>(`
      SELECT id, version, phase, phase_deadline, state_snapshot
      FROM matches
      WHERE phase NOT IN ('complete', 'cancelled')
      ORDER BY id
      FOR UPDATE
    `);
    return result.rows.map((row) => {
      const state = decodeMatchState(row.state_snapshot);
      verifyRowMatchesSnapshot(row, state);
      return state;
    });
  }
}
