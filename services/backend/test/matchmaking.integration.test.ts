import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { InMemoryMatchmakingQueue } from "../src/matchmaking/queue.js";
import {
  MatchmakingReadyTimeoutHandler,
  PostgresMatchmakingService,
} from "../src/matchmaking/service.js";
import { runMigrations } from "../src/persistence/migrations.js";
import { PostgresTransactionRunner } from "../src/persistence/transaction.js";

const { TEST_DATABASE_URL: DATABASE_URL } = process.env;

test(
  "M6 matchmaking is idempotent, block-safe, and creates only fully ready matches",
  { skip: DATABASE_URL === undefined },
  async () => {
    assert.notEqual(DATABASE_URL, undefined);
    const schema = `m6_matchmaking_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({
      connectionString: DATABASE_URL as string,
      max: 2,
    });
    let pool: Pool | undefined;

    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      pool = new Pool({
        connectionString: DATABASE_URL as string,
        max: 20,
        options: `-c search_path=${schema}`,
      });
      await runMigrations(pool);
      const transactions = new PostgresTransactionRunner(pool, {
        retryBaseDelayMilliseconds: 1,
      });
      const queue = new InMemoryMatchmakingQueue();
      let now = new Date("2026-07-30T12:00:00.000Z");
      const service = new PostgresMatchmakingService(
        transactions,
        queue,
        {
          lobbyReadyTimeoutSeconds: 30,
          readyTimeoutSeconds: 15,
          recentPairingWindowSeconds: 86_400,
        },
        undefined,
        () => new Date(now),
      );

      const users = Array.from({ length: 20 }, () => randomUUID());
      for (const [index, userId] of users.entries()) {
        await pool.query("INSERT INTO users (id) VALUES ($1)", [userId]);
        await pool.query(
          `
            INSERT INTO profiles (
              user_id,
              display_name,
              avatar_key,
              progression_level,
              created_at,
              updated_at
            )
            VALUES ($1, $2, 'avatar.default', 1, $3, $3)
          `,
          [userId, `Player ${index + 1}`, now],
        );
      }
      await pool.query(
        `
          INSERT INTO blocks (blocker_user_id, blocked_user_id, created_at)
          VALUES ($1, $2, $3)
        `,
        [users[0], users[1], now],
      );

      const input = {
        compatibilityVersion: 1,
        language: "en",
        region: "eu-west",
      };
      const created = [];
      for (const userId of users.slice(0, 7)) {
        created.push(
          await service.createTicket(userId as string, randomUUID(), input),
        );
      }
      const firstReplayKey = randomUUID();
      const duplicateOriginal = await service.createTicket(
        users[7] as string,
        firstReplayKey,
        input,
      );
      const duplicateReplay = await service.createTicket(
        users[7] as string,
        firstReplayKey,
        input,
      );
      assert.equal(duplicateReplay.replayed, true);
      assert.equal(
        duplicateReplay.ticket.ticketId,
        duplicateOriginal.ticket.ticketId,
      );

      const inspected = await Promise.all(
        created.map(({ ticket }, index) =>
          service.getTicket(users[index] as string, ticket.ticketId),
        ),
      );
      const proposed = inspected.filter(({ status }) => status === "proposed");
      assert.equal(proposed.length, 6);
      const proposedUsers = new Set(
        inspected
          .map((ticket, index) => ({ ticket, userId: users[index] as string }))
          .filter(({ ticket }) => ticket.status === "proposed")
          .map(({ userId }) => userId),
      );
      assert.equal(
        proposedUsers.has(users[0] as string) &&
          proposedUsers.has(users[1] as string),
        false,
        "mutually blocked users must not share a proposal",
      );

      const proposedEntries = inspected
        .map((ticket, index) => ({ ticket, userId: users[index] as string }))
        .filter(({ ticket }) => ticket.status === "proposed");
      for (const { ticket, userId } of proposedEntries) {
        await service.confirmReady(userId, ticket.ticketId, randomUUID());
      }
      const matched = await Promise.all(
        proposedEntries.map(({ ticket, userId }) =>
          service.getTicket(userId, ticket.ticketId),
        ),
      );
      assert.equal(
        matched.every(({ status }) => status === "matched"),
        true,
      );
      assert.equal(new Set(matched.map(({ matchId }) => matchId)).size, 1);
      const durableMatches = await pool.query<{ count: string }>(
        "SELECT count(*) FROM matches",
      );
      assert.equal(durableMatches.rows[0]?.count, "1");
      const roster = await pool.query<{
        blocked_together: boolean;
        count: string;
      }>(
        `
          SELECT
            count(*)::text AS count,
            bool_or(player_id = $1) AND bool_or(player_id = $2)
              AS blocked_together
          FROM match_players
          WHERE match_id = $3
        `,
        [users[0], users[1], matched[0]?.matchId],
      );
      assert.equal(roster.rows[0]?.count, "6");
      assert.equal(roster.rows[0]?.blocked_together, false);

      const queuedUser = inspected.findIndex(
        ({ status }) => status === "queued",
      );
      assert.notEqual(queuedUser, -1);
      const queuedTicket = inspected[queuedUser];
      assert.notEqual(queuedTicket, undefined);
      const cancelKey = randomUUID();
      const cancelled = await service.cancelTicket(
        users[queuedUser] as string,
        queuedTicket?.ticketId as string,
        cancelKey,
      );
      const cancelReplay = await service.cancelTicket(
        users[queuedUser] as string,
        queuedTicket?.ticketId as string,
        cancelKey,
      );
      assert.equal(cancelled.ticket.status, "cancelled");
      assert.equal(cancelReplay.replayed, true);
      assert.deepEqual(cancelReplay.ticket, cancelled.ticket);
      await service.cancelTicket(
        users[7] as string,
        duplicateOriginal.ticket.ticketId,
        randomUUID(),
      );

      const timeoutTickets = [];
      for (const userId of users.slice(8, 14)) {
        timeoutTickets.push(
          await service.createTicket(userId as string, randomUUID(), input),
        );
      }
      const timeoutInspected = await Promise.all(
        timeoutTickets.map(({ ticket }, index) =>
          service.getTicket(users[index + 8] as string, ticket.ticketId),
        ),
      );
      assert.equal(
        timeoutInspected.every(({ status }) => status === "proposed"),
        true,
      );
      const proposalId = timeoutInspected[0]?.proposalId;
      assert.notEqual(proposalId, undefined);
      await service.confirmReady(
        users[8] as string,
        timeoutInspected[0]?.ticketId as string,
        randomUUID(),
      );
      now = new Date("2026-07-30T12:00:16.000Z");
      await transactions.run((client) =>
        new MatchmakingReadyTimeoutHandler().handle(
          client,
          proposalId as string,
          "2026-07-30T12:00:16.000Z" as never,
        ),
      );
      const released = await Promise.all(
        timeoutInspected.map((ticket, index) =>
          service.getTicket(users[index + 8] as string, ticket.ticketId),
        ),
      );
      assert.equal(
        released.every(({ status }) => status === "queued"),
        true,
      );
      assert.equal(
        released.every(({ readyConfirmed }) => !readyConfirmed),
        true,
      );
      const noPartialMatch = await pool.query<{ count: string }>(
        "SELECT count(*) FROM matches",
      );
      assert.equal(noPartialMatch.rows[0]?.count, "1");

      await pool.query(
        `
          INSERT INTO matchmaking_safety (
            user_id,
            matchmaking_allowed,
            restriction_pool,
            updated_at
          )
          VALUES
            ($1, true, 'restricted', $3),
            ($2, false, 'standard', $3)
        `,
        [users[14], users[15], now],
      );
      const restricted = await service.createTicket(
        users[14] as string,
        randomUUID(),
        input,
      );
      assert.equal(restricted.ticket.status, "queued");
      await assert.rejects(
        service.createTicket(users[15] as string, randomUUID(), input),
        (error: unknown) =>
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "account_ineligible",
      );
      const pools = await pool.query<{ queue_key: string }>(
        `
          SELECT queue_key
          FROM matchmaking_tickets
          WHERE id = ANY($1::uuid[])
          ORDER BY id
        `,
        [[restricted.ticket.ticketId, released[0]?.ticketId as string]],
      );
      assert.equal(
        pools.rows[0]?.queue_key === pools.rows[1]?.queue_key,
        false,
        "restriction pools must produce distinct Valkey grouping keys",
      );
    } finally {
      await pool?.end().catch(() => undefined);
      await admin
        .query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        .catch(() => undefined);
      await admin.end();
    }
  },
);
