import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { parseRulesetV1 } from "@project-booth/config";
import {
  parseEntityId,
  parseUtcTimestamp,
  type EntityId,
  type MatchId,
  type UserId,
  type UtcTimestamp,
} from "@project-booth/domain";
import {
  applyLobbyCommand,
  createMatchState,
  type MatchState,
} from "@project-booth/game-engine";
import { Pool } from "pg";

import { MatchDeadlineHandler } from "../src/persistence/deadline-handler.js";
import {
  PostgresMatchCommandExecutor,
  type MatchCommandTransition,
} from "../src/persistence/match-command-executor.js";
import { PostgresMatchRepository } from "../src/persistence/match-repository.js";
import { runMigrations } from "../src/persistence/migrations.js";
import {
  OutboxProcessor,
  PostgresOutboxRepository,
} from "../src/persistence/outbox.js";
import { MatchRecoveryService } from "../src/persistence/recovery.js";
import {
  PostgresScheduledJobRepository,
  ScheduledJobProcessor,
} from "../src/persistence/scheduled-jobs.js";
import { PostgresTransactionRunner } from "../src/persistence/transaction.js";

const { TEST_DATABASE_URL: DATABASE_URL } = process.env;

const RULESET_INPUT = {
  schemaVersion: 1,
  rulesetId: "019824d0-7c1a-7a91-8c4a-3fe0f1b51e22",
  rulesetVersion: 1,
  roster: { contestantCount: 6, minimumReadyCount: 4 },
  phaseDurationsSeconds: {
    firstNegotiation: 120,
    laterNegotiation: 90,
    voting: 20,
    eliminationReveal: 10,
    runoffNegotiation: 30,
    runoffVoting: 15,
    finalPlea: 60,
    juryVoting: 20,
    reconnectGrace: 30,
  },
  communication: { maximumTypedMessageCharacters: 240 },
  economy: {
    references: {
      matchOutflowCap: "economy.match_outflow_cap.standard",
      minimumOfferIncrement: "economy.minimum_offer_increment.standard",
      matchCompletionReward: "economy.reward.match_completion.standard",
      placementReward: "economy.reward.placement.standard",
      winnerReward: "economy.reward.winner.standard",
    },
    rules: {
      outgoingLimitBasis: "cumulative_outgoing",
      incomingTransfersRestoreAllowance: false,
      inMatchPurchasesAvailability: "next_match",
      reversalRestoresAllowance: true,
      acceptedOfferSettlement: "any_valid_ballot",
      promisedTargetEnforced: false,
      missedBallotSettlement: "reverse",
    },
  },
} as const;

function id<Entity extends string>(
  entity: Entity,
  suffix: number,
): EntityId<Entity> {
  const parsed = parseEntityId(
    entity,
    `019824d0-7c1a-7a91-8c4a-${suffix.toString().padStart(12, "0")}`,
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    throw new Error("Test identifier is invalid");
  }
  return parsed.value;
}

function timestamp(value: string): UtcTimestamp {
  const parsed = parseUtcTimestamp(value);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    throw new Error("Test timestamp is invalid");
  }
  return parsed.value;
}

function createState(matchId: MatchId, players: readonly UserId[]): MatchState {
  const ruleset = parseRulesetV1(structuredClone(RULESET_INPUT));
  assert.equal(ruleset.ok, true);
  if (!ruleset.ok) {
    throw new Error("Test ruleset is invalid");
  }
  const state = createMatchState({
    matchId,
    ruleset: ruleset.value,
    playerIds: players,
    lobbyDeadline: timestamp("2026-07-24T12:01:00.000Z"),
  });
  assert.equal(state.ok, true);
  if (!state.ok) {
    throw new Error("Test state is invalid");
  }
  return state.value;
}

function readyTransition(
  state: MatchState,
  playerId: UserId,
  occurredAt: UtcTimestamp,
  marker: string,
): MatchCommandTransition {
  const result = applyLobbyCommand(state, {
    type: "contestant_ready",
    playerId,
    occurredAt,
  });
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error("Ready transition failed");
  }
  return {
    state: result.value.state,
    events: result.value.events,
    response: {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { marker, version: result.value.state.version },
    },
  };
}

test(
  "M4 PostgreSQL persistence and reliable jobs",
  { skip: DATABASE_URL === undefined },
  async () => {
    assert.notEqual(DATABASE_URL, undefined);
    const databaseUrl = DATABASE_URL as string;
    const schema = `m4_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: databaseUrl, max: 2 });
    let pool: Pool | undefined;

    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const makePool = (): Pool =>
        new Pool({
          connectionString: databaseUrl,
          max: 12,
          options: `-c search_path=${schema}`,
        });
      pool = makePool();

      const firstMigration = await runMigrations(pool);
      const secondMigration = await runMigrations(pool);
      assert.deepEqual(firstMigration.applied, [
        "0001_m4_persistence.sql",
        "0002_immutable_rulesets.sql",
        "0003_m5_identity_accounts_profiles.sql",
        "0004_m6_matchmaking_realtime.sql",
        "0005_m7_chat_safety.sql",
        "0006_m8_coin_ledger_bribes.sql",
      ]);
      assert.deepEqual(firstMigration.pending, []);
      assert.deepEqual(secondMigration.pending, []);
      const tables = await pool.query<{ table_name: string }>(
        `
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = $1
          ORDER BY table_name
        `,
        [schema],
      );
      assert.deepEqual(
        tables.rows.map(({ table_name }) => table_name),
        [
          "account_deletion_requests",
          "blocks",
          "bribe_offers",
          "chat_threads",
          "coin_accounts",
          "coin_grants",
          "cosmetic_purchases",
          "devices",
          "idempotency_keys",
          "inventory_items",
          "ledger_entries",
          "ledger_transactions",
          "match_coin_allowances",
          "match_events",
          "match_players",
          "matches",
          "matchmaking_proposals",
          "matchmaking_safety",
          "matchmaking_tickets",
          "message_filter_results",
          "messages",
          "moderation_reviews",
          "mutes",
          "outbox_events",
          "profiles",
          "provider_credentials",
          "recent_pairings",
          "recipient_events",
          "recipient_streams",
          "reports",
          "rounds",
          "rulesets",
          "scheduled_jobs",
          "schema_migrations",
          "session_refresh_tokens",
          "sessions",
          "user_identities",
          "users",
        ],
      );

      const players = Array.from({ length: 6 }, (_, index) =>
        id("user", index + 1),
      ) as UserId[];
      for (const player of players) {
        await pool.query("INSERT INTO users (id) VALUES ($1)", [player]);
      }

      const transactions = new PostgresTransactionRunner(pool, {
        retryBaseDelayMilliseconds: 1,
      });
      const matches = new PostgresMatchRepository();
      const outbox = new PostgresOutboxRepository();
      const jobs = new PostgresScheduledJobRepository();
      const executor = new PostgresMatchCommandExecutor(
        transactions,
        matches,
        undefined,
        outbox,
        jobs,
      );
      const matchId = id("match", 100) as MatchId;
      const initial = createState(matchId, players);
      const createdAt = timestamp("2026-07-24T12:00:00.000Z");
      await executor.createMatch(initial, createdAt);

      const roundTrip = await transactions.run((client) =>
        matches.load(client, matchId),
      );
      assert.deepEqual(roundTrip, initial);
      assert.equal(Object.isFrozen(roundTrip), true);
      assert.equal(Object.isFrozen(roundTrip?.roster), true);
      await assert.rejects(
        pool.query(
          "UPDATE rulesets SET snapshot = snapshot WHERE id = $1 AND version = $2",
          [
            initial.rulesetSnapshot.rulesetId,
            initial.rulesetSnapshot.rulesetVersion,
          ],
        ),
        (error: unknown) =>
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "23514",
      );

      const readyAt = timestamp("2026-07-24T12:00:10.000Z");
      const concurrentInputs = [0, 1].map((index) => ({
        accountId: players[0] as UserId,
        operation: "contestant-ready",
        idempotencyKey: id("idempotency", 900 + index),
        request: { playerId: players[0] as UserId },
        matchId,
        occurredAt: readyAt,
        apply: (state: MatchState) =>
          readyTransition(state, players[0] as UserId, readyAt, "concurrent"),
      }));
      await Promise.all(
        concurrentInputs.map((input) => executor.execute(input)),
      );
      const afterConcurrent = await transactions.run((client) =>
        matches.load(client, matchId),
      );
      assert.equal(afterConcurrent?.version, 2);
      assert.deepEqual(afterConcurrent?.readyPlayerIds, [players[0]]);
      const committedReadyEvents = await pool.query<{ count: string }>(
        "SELECT count(*) FROM match_events WHERE match_id = $1",
        [matchId],
      );
      assert.equal(committedReadyEvents.rows[0]?.count, "1");

      let mutationCount = 0;
      const idempotencyKey = id("idempotency", 910);
      const replayInput = (request: {
        readonly a: number;
        readonly b: number;
      }) => ({
        accountId: players[1] as UserId,
        operation: "contestant-ready",
        idempotencyKey,
        request,
        matchId,
        occurredAt: timestamp("2026-07-24T12:00:20.000Z"),
        apply: (state: MatchState) => {
          mutationCount += 1;
          return readyTransition(
            state,
            players[1] as UserId,
            timestamp("2026-07-24T12:00:20.000Z"),
            "original",
          );
        },
      });
      const original = await executor.execute(replayInput({ a: 1, b: 2 }));
      const replay = await executor.execute(replayInput({ b: 2, a: 1 }));
      assert.deepEqual(replay, original);
      assert.equal(mutationCount, 1);

      const crashClaim = await transactions.run((client) =>
        outbox.claim(client, {
          workerId: "crashing-worker",
          now: new Date("2026-07-24T12:00:30.000Z"),
          leaseMilliseconds: 1_000,
          batchSize: 100,
        }),
      );
      assert.equal(crashClaim.length, 12);
      const deliveredIds = crashClaim.map(({ eventId }) => eventId);
      const reclaimed = await transactions.run((client) =>
        outbox.claim(client, {
          workerId: "recovery-worker",
          now: new Date("2026-07-24T12:01:31.000Z"),
          leaseMilliseconds: 30_000,
          batchSize: 100,
        }),
      );
      assert.deepEqual(
        reclaimed.map(({ eventId }) => eventId).sort(),
        deliveredIds.toSorted(),
      );
      const processor = new OutboxProcessor(transactions, outbox, {
        async publish(event): Promise<void> {
          deliveredIds.push(event.eventId);
        },
      });
      assert.equal(
        await processor.publishClaimed(
          reclaimed,
          () => new Date("2026-07-24T12:01:32.000Z"),
        ),
        12,
      );
      assert.equal(new Set(deliveredIds).size, 12);
      assert.equal(deliveredIds.length, 24);

      const deadlineHandler = new MatchDeadlineHandler(matches, outbox, jobs);
      const scheduledProcessor = new ScheduledJobProcessor(
        transactions,
        jobs,
        (client, job, occurredAt) =>
          deadlineHandler.handle(client, job, occurredAt),
      );
      const claimAt = new Date("2026-07-24T12:01:01.000Z");
      const [workerOne, workerTwo] = await Promise.all([
        scheduledProcessor.claim({
          workerId: "deadline-worker-1",
          now: claimAt,
          leaseMilliseconds: 30_000,
          batchSize: 1,
        }),
        scheduledProcessor.claim({
          workerId: "deadline-worker-2",
          now: claimAt,
          leaseMilliseconds: 30_000,
          batchSize: 1,
        }),
      ]);
      assert.equal(workerOne.length + workerTwo.length, 1);
      const claimedJob = workerOne[0] ?? workerTwo[0];
      if (claimedJob === undefined) {
        throw new Error("A deadline worker must claim the job");
      }
      assert.equal(
        await scheduledProcessor.process(
          claimedJob,
          timestamp("2026-07-24T12:01:01.000Z"),
        ),
        true,
      );
      assert.equal(
        await scheduledProcessor.process(
          claimedJob,
          timestamp("2026-07-24T12:01:02.000Z"),
        ),
        false,
      );
      const afterDeadline = await transactions.run((client) =>
        matches.load(client, matchId),
      );
      assert.equal(afterDeadline?.version, 4);
      assert.equal(afterDeadline?.phase, "cancelled");

      await pool.query(`
        CREATE TABLE retry_counter (
          id integer PRIMARY KEY,
          value integer NOT NULL
        )
      `);
      await pool.query("INSERT INTO retry_counter (id, value) VALUES (1, 0)");
      let firstAttemptReads = 0;
      let releaseReads!: () => void;
      const bothRead = new Promise<void>((resolve) => {
        releaseReads = resolve;
      });
      const increment = (): Promise<void> =>
        transactions.run(async (client, attempt) => {
          const result = await client.query<{ value: number }>(
            "SELECT value FROM retry_counter WHERE id = 1",
          );
          if (attempt === 1) {
            firstAttemptReads += 1;
            if (firstAttemptReads === 2) {
              releaseReads();
            }
            await bothRead;
          }
          await client.query(
            "UPDATE retry_counter SET value = $1 WHERE id = 1",
            [(result.rows[0]?.value ?? 0) + 1],
          );
        });
      await Promise.all([increment(), increment()]);
      const retryCounter = await pool.query<{ value: number }>(
        "SELECT value FROM retry_counter WHERE id = 1",
      );
      assert.equal(retryCounter.rows[0]?.value, 2);

      const restartMatchId = id("match", 101) as MatchId;
      const restartState = createState(restartMatchId, players);
      await executor.createMatch(restartState, createdAt);
      await pool.end();
      pool = makePool();

      const restartedTransactions = new PostgresTransactionRunner(pool);
      const restartedRepository = new PostgresMatchRepository();
      const reloaded = await restartedTransactions.run((client) =>
        restartedRepository.load(client, restartMatchId),
      );
      assert.deepEqual(reloaded, restartState);
      assert.equal(reloaded?.phase, restartState.phase);
      assert.equal(reloaded?.phaseDeadline, restartState.phaseDeadline);
      assert.equal(reloaded?.version, restartState.version);
      assert.deepEqual(reloaded?.roster, restartState.roster);

      const recovery = new MatchRecoveryService(restartedTransactions);
      assert.equal(
        await recovery.recoverActiveMatches(
          timestamp("2026-07-24T12:00:30.000Z"),
        ),
        1,
      );
      await recovery.recoverActiveMatches(
        timestamp("2026-07-24T12:00:31.000Z"),
      );
      const currentDeadlineJobs = await pool.query<{ count: string }>(
        `
          SELECT count(*)
          FROM scheduled_jobs
          WHERE
            deduplication_key = $1
            AND status IN ('pending', 'processing')
        `,
        [`match-deadline:${restartMatchId}:${restartState.version}`],
      );
      assert.equal(currentDeadlineJobs.rows[0]?.count, "1");
    } finally {
      await pool?.end().catch(() => undefined);
      await admin
        .query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        .catch(() => undefined);
      await admin.end();
    }
  },
);
