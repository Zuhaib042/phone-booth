import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { DEFAULT_RULESET_V1, parseRulesetV1 } from "@project-booth/config";
import type { MatchId, UserId, UtcTimestamp } from "@project-booth/domain";
import { createMatchState } from "@project-booth/game-engine";
import { Pool } from "pg";

import { DeterministicModerationProvider } from "../src/chat/moderation.js";
import { PostgresChatService } from "../src/chat/service.js";
import type { ChatConfig } from "../src/config.js";
import { PostgresMatchRepository } from "../src/persistence/match-repository.js";
import { runMigrations } from "../src/persistence/migrations.js";
import { PostgresTransactionRunner } from "../src/persistence/transaction.js";

const { TEST_DATABASE_URL: DATABASE_URL } = process.env;

const CHAT_CONFIG: ChatConfig = {
  duplicateWindowSeconds: 30,
  maximumTypedMessageCharacters: 240,
  moderationProvider: "deterministic",
  moderationTimeoutMilliseconds: 10,
  rapidTargetLimit: 5,
  rateLimitWindowSeconds: 10,
  threadRateLimit: 50,
  userRateLimit: 100,
};

test(
  "M7 private chat is scoped, moderated, delivered, reportable, muted, and block-safe",
  { skip: DATABASE_URL === undefined },
  async () => {
    assert.notEqual(DATABASE_URL, undefined);
    const schema = `m7_chat_${randomUUID().replaceAll("-", "")}`;
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
      const players = Array.from({ length: 6 }, () => randomUUID()) as UserId[];
      const now = new Date("2026-07-30T12:00:00.000Z");
      for (const [index, player] of players.entries()) {
        await pool.query("INSERT INTO users (id) VALUES ($1)", [player]);
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
          [player, `Player ${index + 1}`, now],
        );
      }
      const parsedRuleset = parseRulesetV1(structuredClone(DEFAULT_RULESET_V1));
      assert.equal(parsedRuleset.ok, true);
      if (!parsedRuleset.ok) {
        throw new Error("Default test ruleset was invalid");
      }
      const matchId = randomUUID() as MatchId;
      const created = createMatchState({
        lobbyDeadline: "2026-07-30T12:05:00.000Z" as UtcTimestamp,
        matchId,
        playerIds: players,
        ruleset: parsedRuleset.value,
      });
      assert.equal(created.ok, true);
      if (!created.ok) {
        throw new Error("Test match was invalid");
      }
      await transactions.run((client) =>
        new PostgresMatchRepository().create(
          client,
          created.value,
          now.toISOString() as UtcTimestamp,
        ),
      );

      const provider = new DeterministicModerationProvider((text) => {
        if (text.includes("provider block")) {
          return "block";
        }
        if (text.includes("provider urgent")) {
          return "urgent_review";
        }
        return "allow";
      });
      const service = new PostgresChatService(
        transactions,
        provider,
        CHAT_CONFIG,
        () => new Date(now),
      );
      const threads = await service.listThreads(players[0] as string, matchId);
      assert.equal(threads.length, 5);
      const pair = threads.find(
        ({ otherUser }) => otherUser.userId === players[1],
      );
      assert.notEqual(pair, undefined);
      const durableThreads = await pool.query<{ count: string }>(
        "SELECT count(*) FROM chat_threads WHERE match_id = $1",
        [matchId],
      );
      assert.equal(durableThreads.rows[0]?.count, "15");

      await assert.rejects(
        service.listMessages(
          players[2] as string,
          matchId,
          pair?.threadId as string,
        ),
        (error: unknown) =>
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "chat_forbidden",
      );

      const sendKey = randomUUID();
      const sent = await service.sendMessage(
        players[0] as string,
        matchId,
        pair?.threadId as string,
        sendKey,
        { kind: "typed", text: "  Secret   plan  " },
      );
      assert.equal(sent.responseStatus, 201);
      assert.equal(sent.value.deliveryStatus, "delivered");
      assert.equal(sent.value.body, "Secret plan");
      const replay = await service.sendMessage(
        players[0] as string,
        matchId,
        pair?.threadId as string,
        sendKey,
        { kind: "typed", text: "  Secret   plan  " },
      );
      assert.equal(replay.replayed, true);
      assert.equal(replay.value.messageId, sent.value.messageId);

      const recipientEvents = await pool.query<{
        event_type: string;
        payload: { messageId?: string };
        user_id: string;
      }>(
        `
          SELECT user_id, event_type, payload
          FROM recipient_events
          WHERE event_type LIKE 'match.domain.chat.message_%'
          ORDER BY user_id, recipient_cursor
        `,
      );
      assert.equal(recipientEvents.rows.length, 2);
      assert.deepEqual(
        new Set(recipientEvents.rows.map(({ user_id }) => user_id)),
        new Set([players[0], players[1]]),
      );
      assert.equal(
        recipientEvents.rows.every(
          ({ payload }) => payload.messageId === sent.value.messageId,
        ),
        true,
      );
      const messageOutbox = await pool.query<{ count: string }>(
        `
          SELECT count(*)
          FROM outbox_events
          WHERE event_type = 'realtime.delivery'
            AND payload -> 'payload' ->> 'messageId' = $1
        `,
        [sent.value.messageId],
      );
      assert.equal(messageOutbox.rows[0]?.count, "2");

      const duplicate = await service.sendMessage(
        players[0] as string,
        matchId,
        pair?.threadId as string,
        randomUUID(),
        { kind: "typed", text: "Secret plan" },
      );
      assert.equal(duplicate.responseStatus, 429);
      assert.equal(duplicate.value.deliveryStatus, "rate_limited");
      const duplicateFilter = await pool.query<{
        deterministic_reasons: string[];
      }>(
        `
          SELECT deterministic_reasons
          FROM message_filter_results
          WHERE message_id = $1
        `,
        [duplicate.value.messageId],
      );
      assert.equal(
        duplicateFilter.rows[0]?.deterministic_reasons.includes(
          "spam_duplicate",
        ),
        true,
      );

      const contact = await service.sendMessage(
        players[0] as string,
        matchId,
        pair?.threadId as string,
        randomUUID(),
        { kind: "typed", text: "find me at example dot com" },
      );
      assert.equal(contact.responseStatus, 422);
      assert.equal(contact.value.deliveryStatus, "blocked");
      const blockByProvider = await service.sendMessage(
        players[0] as string,
        matchId,
        pair?.threadId as string,
        randomUUID(),
        { kind: "typed", text: "provider block fixture" },
      );
      assert.equal(blockByProvider.value.deliveryStatus, "blocked");
      const urgent = await service.sendMessage(
        players[0] as string,
        matchId,
        pair?.threadId as string,
        randomUUID(),
        { kind: "typed", text: "provider urgent fixture" },
      );
      assert.equal(urgent.value.deliveryStatus, "blocked");
      const review = await pool.query<{ count: string }>(
        "SELECT count(*) FROM moderation_reviews WHERE message_id = $1",
        [urgent.value.messageId],
      );
      assert.equal(review.rows[0]?.count, "1");

      const rapid = new PostgresChatService(
        transactions,
        provider,
        { ...CHAT_CONFIG, rapidTargetLimit: 2 },
        () => new Date(now),
      );
      const rapidThreads = await rapid.listThreads(
        players[0] as string,
        matchId,
      );
      const secondTarget = rapidThreads.find(
        ({ otherUser }) => otherUser.userId === players[2],
      );
      const thirdTarget = rapidThreads.find(
        ({ otherUser }) => otherUser.userId === players[3],
      );
      const secondTargetMessage = await rapid.sendMessage(
        players[0] as string,
        matchId,
        secondTarget?.threadId as string,
        randomUUID(),
        { kind: "typed", text: "A second target" },
      );
      assert.equal(secondTargetMessage.value.deliveryStatus, "delivered");
      const rapidSwitch = await rapid.sendMessage(
        players[0] as string,
        matchId,
        thirdTarget?.threadId as string,
        randomUUID(),
        { kind: "typed", text: "A third target" },
      );
      assert.equal(rapidSwitch.value.deliveryStatus, "rate_limited");

      const report = await service.reportMessage(
        players[1] as string,
        matchId,
        sent.value.messageId,
        "harassment",
        randomUUID(),
      );
      assert.equal(report.value.status, "queued");
      const storedEvidence = await pool.query<{
        evidence_snapshot: { reportedMessageId?: string };
      }>("SELECT evidence_snapshot FROM reports WHERE id = $1", [
        report.value.reportId,
      ]);
      assert.equal(
        storedEvidence.rows[0]?.evidence_snapshot.reportedMessageId,
        sent.value.messageId,
      );

      await service.muteUser(
        players[1] as string,
        matchId,
        players[0] as string,
        randomUUID(),
      );
      const muted = await service.sendMessage(
        players[0] as string,
        matchId,
        pair?.threadId as string,
        randomUUID(),
        { kind: "typed", text: "A different quiet message" },
      );
      assert.equal(muted.value.deliveryStatus, "recipient_unavailable");

      const versionBeforeBlock = await pool.query<{ version: string }>(
        "SELECT version FROM matches WHERE id = $1",
        [matchId],
      );
      await service.blockUser(
        players[1] as string,
        matchId,
        players[0] as string,
        randomUUID(),
      );
      const durableBlock = await pool.query<{ count: string }>(
        `
          SELECT count(*)
          FROM blocks
          WHERE blocker_user_id = $1 AND blocked_user_id = $2
        `,
        [players[1], players[0]],
      );
      assert.equal(durableBlock.rows[0]?.count, "1");
      const versionAfterBlock = await pool.query<{ version: string }>(
        "SELECT version FROM matches WHERE id = $1",
        [matchId],
      );
      assert.deepEqual(versionAfterBlock.rows, versionBeforeBlock.rows);

      const outage = new PostgresChatService(
        transactions,
        new DeterministicModerationProvider("failure"),
        CHAT_CONFIG,
        () => new Date(now),
      );
      const outageThread = (
        await outage.listThreads(players[2] as string, matchId)
      ).find(({ otherUser }) => otherUser.userId === players[3]);
      assert.notEqual(outageThread, undefined);
      const unavailable = await outage.sendMessage(
        players[2] as string,
        matchId,
        outageThread?.threadId as string,
        randomUUID(),
        { kind: "typed", text: "Free text during an outage" },
      );
      assert.equal(unavailable.responseStatus, 503);
      assert.equal(unavailable.value.deliveryStatus, "provider_unavailable");
      const quick = await outage.sendMessage(
        players[2] as string,
        matchId,
        outageThread?.threadId as string,
        randomUUID(),
        { kind: "quick_phrase", quickPhraseKey: "hello" },
      );
      assert.equal(quick.value.deliveryStatus, "delivered");

      const limited = new PostgresChatService(
        transactions,
        provider,
        { ...CHAT_CONFIG, threadRateLimit: 1 },
        () => new Date(now),
      );
      const limitedThread = (
        await limited.listThreads(players[4] as string, matchId)
      ).find(({ otherUser }) => otherUser.userId === players[5]);
      const firstLimited = await limited.sendMessage(
        players[4] as string,
        matchId,
        limitedThread?.threadId as string,
        randomUUID(),
        { kind: "typed", text: "First limited message" },
      );
      assert.equal(firstLimited.value.deliveryStatus, "delivered");
      const flood = await limited.sendMessage(
        players[4] as string,
        matchId,
        limitedThread?.threadId as string,
        randomUUID(),
        { kind: "typed", text: "Second limited message" },
      );
      assert.equal(flood.value.deliveryStatus, "rate_limited");

      const timeout = new PostgresChatService(
        transactions,
        new DeterministicModerationProvider("timeout"),
        CHAT_CONFIG,
        () => new Date(now),
      );
      const timeoutThread = (
        await timeout.listThreads(players[4] as string, matchId)
      ).find(({ otherUser }) => otherUser.userId === players[5]);
      const timedOut = await timeout.sendMessage(
        players[4] as string,
        matchId,
        timeoutThread?.threadId as string,
        randomUUID(),
        { kind: "typed", text: "Provider timeout fixture" },
      );
      assert.equal(timedOut.value.deliveryStatus, "provider_unavailable");

      const visible = await service.listMessages(
        players[1] as string,
        matchId,
        pair?.threadId as string,
      );
      assert.deepEqual(
        visible.messages.map(({ messageId }) => messageId),
        [sent.value.messageId],
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
