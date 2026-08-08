import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { MatchId, UtcTimestamp } from "@project-booth/domain";
import type { MatchState } from "@project-booth/game-engine";
import { Pool } from "pg";

import { buildApi } from "../src/app.js";
import { DeterministicModerationProvider } from "../src/chat/moderation.js";
import { PostgresChatService } from "../src/chat/service.js";
import type { ApiConfig, ChatConfig } from "../src/config.js";
import {
  type EconomyConfig,
  PostgresEconomyService,
} from "../src/economy/service.js";
import type { IdentityApplication } from "../src/identity/service.js";
import { PostgresMatchApplication } from "../src/matches/service.js";
import { InMemoryMatchmakingQueue } from "../src/matchmaking/queue.js";
import { PostgresMatchmakingService } from "../src/matchmaking/service.js";
import { PostgresMatchCommandExecutor } from "../src/persistence/match-command-executor.js";
import { MatchDeadlineHandler } from "../src/persistence/deadline-handler.js";
import { PostgresMatchRepository } from "../src/persistence/match-repository.js";
import { runMigrations } from "../src/persistence/migrations.js";
import {
  OutboxProcessor,
  PostgresOutboxRepository,
} from "../src/persistence/outbox.js";
import { PostgresTransactionRunner } from "../src/persistence/transaction.js";
import {
  PostgresRealtimeQueryService,
  type RealtimeEventEnvelope,
} from "../src/realtime/events.js";
import { RealtimeGateway } from "../src/realtime/websocket.js";
import { NetworkedTestClient } from "../src/simulator/network-client.js";

const { TEST_DATABASE_URL: DATABASE_URL } = process.env;
const API_CONFIG: ApiConfig = {
  host: "127.0.0.1",
  logLevel: "silent",
  nodeEnvironment: "test",
  port: 0,
};
const CHAT_CONFIG: ChatConfig = {
  duplicateWindowSeconds: 30,
  maximumTypedMessageCharacters: 240,
  moderationProvider: "deterministic",
  moderationTimeoutMilliseconds: 50,
  rapidTargetLimit: 5,
  rateLimitWindowSeconds: 10,
  threadRateLimit: 50,
  userRateLimit: 100,
};
const ECONOMY_CONFIG: EconomyConfig = {
  cosmetics: {},
  grants: { "grant.fixture.match": 1_000 },
  matchOutflowCap: 600,
  minimumOfferIncrement: 50,
};

test(
  "M10 six network clients complete matchmaking, negotiation, offers, voting, jury, and dossier",
  { skip: DATABASE_URL === undefined },
  async () => {
    assert.notEqual(DATABASE_URL, undefined);
    const schema = `m10_network_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({
      connectionString: DATABASE_URL as string,
      max: 2,
    });
    let pool: Pool | undefined;
    let firstApi: ReturnType<typeof buildApi> | undefined;
    let secondApi: ReturnType<typeof buildApi> | undefined;
    const clients: NetworkedTestClient[] = [];

    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      pool = new Pool({
        connectionString: DATABASE_URL as string,
        max: 24,
        options: `-c search_path=${schema}`,
      });
      await runMigrations(pool);
      const users: string[] = Array.from({ length: 6 }, () => randomUUID());
      const tokens = new Map(
        users.map((userId, index) => [`network-token-${index}`, userId]),
      );
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
            VALUES (
              $1,
              $2,
              'avatar.default',
              1,
              '2026-07-30T12:00:00.000Z',
              '2026-07-30T12:00:00.000Z'
            )
          `,
          [userId, `Network ${index + 1}`],
        );
      }
      const identity = {
        async authenticate(accessToken: string) {
          const userId = tokens.get(accessToken);
          if (userId === undefined) {
            throw new Error("invalid token");
          }
          return { sessionId: `session-${userId}`, userId };
        },
      } as IdentityApplication;
      const transactions = new PostgresTransactionRunner(pool, {
        retryBaseDelayMilliseconds: 1,
      });
      let clockDate = new Date("2026-07-30T12:00:00.000Z");
      const clock = () => new Date(clockDate);
      const economy = new PostgresEconomyService(
        transactions,
        ECONOMY_CONFIG,
        clock,
      );
      const chat = new PostgresChatService(
        transactions,
        new DeterministicModerationProvider("allow"),
        CHAT_CONFIG,
        clock,
      );
      for (const userId of users) {
        await economy.grantCoins(
          userId,
          "grant.fixture.match",
          "m10-network",
          randomUUID(),
        );
      }
      const matchmaking = new PostgresMatchmakingService(
        transactions,
        new InMemoryMatchmakingQueue(),
        {
          lobbyReadyTimeoutSeconds: 30,
          readyTimeoutSeconds: 15,
          recentPairingWindowSeconds: 86_400,
        },
        undefined,
        clock,
      );
      const executor = new PostgresMatchCommandExecutor(transactions);
      const matches = new PostgresMatchApplication(executor, clock, economy);
      const queries = new PostgresRealtimeQueryService((action) =>
        transactions.run(action),
      );
      const realtimeConfig = {
        heartbeatIntervalMilliseconds: 1_000,
        heartbeatTimeoutMilliseconds: 3_000,
        resumeLimit: 100,
      };
      const firstGateway = new RealtimeGateway(
        identity,
        queries,
        realtimeConfig,
      );
      const secondGateway = new RealtimeGateway(
        identity,
        queries,
        realtimeConfig,
      );
      firstApi = buildApi(API_CONFIG, {
        chatService: chat,
        economyService: economy,
        identityService: identity,
        logger: false,
        matchService: matches,
        matchmakingService: matchmaking,
        realtimeGateway: firstGateway,
        realtimeQueryService: queries,
      });
      secondApi = buildApi(API_CONFIG, {
        chatService: chat,
        economyService: economy,
        identityService: identity,
        logger: false,
        matchService: matches,
        matchmakingService: matchmaking,
        realtimeGateway: secondGateway,
        realtimeQueryService: queries,
      });
      await Promise.all([
        firstApi.listen({ host: "127.0.0.1", port: 0 }),
        secondApi.listen({ host: "127.0.0.1", port: 0 }),
      ]);
      for (let index = 0; index < 6; index += 1) {
        clients.push(
          new NetworkedTestClient(
            firstApi.listeningOrigin,
            `network-token-${index}`,
          ),
        );
      }

      const tickets = [];
      for (const client of clients) {
        tickets.push(
          await client.createTicket({
            compatibilityVersion: 1,
            language: "en",
            region: "eu-west",
          }),
        );
      }
      const proposed = await Promise.all(
        tickets.map((ticket, index) =>
          clients[index]?.inspectTicket(ticket.ticketId),
        ),
      );
      assert.equal(
        proposed.every((ticket) => ticket?.status === "proposed"),
        true,
      );
      for (const [index, ticket] of proposed.entries()) {
        await clients[index]?.confirmMatchmakingReady(
          ticket?.ticketId as string,
        );
      }
      const matched = await Promise.all(
        proposed.map((ticket, index) =>
          clients[index]?.inspectTicket(ticket?.ticketId as string),
        ),
      );
      const matchId = matched[0]?.matchId;
      assert.notEqual(matchId, undefined);
      assert.equal(
        matched.every(
          (ticket) =>
            ticket?.status === "matched" && ticket.matchId === matchId,
        ),
        true,
      );

      await Promise.all(clients.map((client) => client.connect()));
      clockDate = new Date("2026-07-30T12:00:05.000Z");
      for (const client of clients) {
        await client.confirmBoothReady(matchId as string);
      }

      const outbox = new PostgresOutboxRepository();
      const claimed = await transactions.run((client) =>
        outbox.claim(client, {
          workerId: "network-simulator",
          now: new Date("2026-07-30T12:00:10.000Z"),
          leaseMilliseconds: 30_000,
          batchSize: 100,
        }),
      );
      const publisher = new OutboxProcessor(transactions, outbox, {
        async publish(event) {
          if (event.aggregateType === "realtime-recipient") {
            const envelope = event.payload as unknown as RealtimeEventEnvelope;
            firstGateway.deliver(event.aggregateId, envelope);
            secondGateway.deliver(event.aggregateId, envelope);
          }
        },
      });
      await publisher.publishClaimed(
        claimed,
        () => new Date("2026-07-30T12:00:11.000Z"),
      );

      const phaseEvents = await Promise.all(
        clients.map((client) =>
          client.waitForEvent(
            (event) => event.type === "match.domain.match.phase_changed",
          ),
        ),
      );
      const phaseDeadlines = new Set(
        phaseEvents.map(
          ({ payload }) =>
            (payload as { readonly deadline?: unknown }).deadline,
        ),
      );
      assert.equal(phaseDeadlines.size, 1);
      assert.equal(
        phaseEvents.every(
          (event) =>
            event.matchId === matchId &&
            (event.payload as { readonly phase?: unknown }).phase ===
              "negotiation",
        ),
        true,
      );
      const snapshots = await Promise.all(
        clients.map((client) => client.snapshot(matchId as string)),
      );
      assert.equal(
        snapshots.every(
          (snapshot) =>
            snapshot.phase === "negotiation" &&
            snapshot.phaseDeadline === snapshots[0]?.phaseDeadline &&
            snapshot.matchVersion === snapshots[0]?.matchVersion,
        ),
        true,
      );

      const reconnecting = clients[0] as NetworkedTestClient;
      const beforeReconnect = new Set(reconnecting.eventIds());
      await reconnecting.connect(secondApi.listeningOrigin);
      reconnecting.resume(snapshots[0]?.lastRecipientCursor as number);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(new Set(reconnecting.eventIds()), beforeReconnect);
      assert.equal(
        new Set(reconnecting.eventIds()).size,
        reconnecting.eventIds().length,
      );

      assert.equal(
        phaseEvents.every(({ recipientCursor }) => recipientCursor > 0),
        true,
      );

      const durableMatches = new PostgresMatchRepository();
      const deadlineHandler = new MatchDeadlineHandler(
        durableMatches,
        undefined,
        undefined,
        undefined,
        economy,
      );
      const loadState = async (): Promise<MatchState> => {
        const state = await transactions.run((client) =>
          durableMatches.load(client, matchId as MatchId),
        );
        if (state === null) {
          throw new Error("The network match disappeared");
        }
        return state;
      };
      const advance = async (state: MatchState): Promise<MatchState> => {
        const occurredAt = (state.phaseDeadline ??
          clockDate.toISOString()) as UtcTimestamp;
        clockDate = new Date(occurredAt);
        await transactions.run((client) =>
          deadlineHandler.handle(
            client,
            {
              attemptCount: 1,
              claimToken: randomUUID(),
              deduplicationKey: `m10:${state.matchId}:${state.version}`,
              jobId: randomUUID(),
              kind: "match.deadline",
              maxAttempts: 1,
              payload: {
                expectedDeadline: state.phaseDeadline,
                expectedPhase: state.phase,
                expectedVersion: state.version,
                matchId: state.matchId,
              },
              runAt: occurredAt,
            },
            occurredAt,
          ),
        );
        return loadState();
      };
      const clientFor = (userId: string): NetworkedTestClient => {
        const client = clients[users.indexOf(userId)];
        if (client === undefined) {
          throw new Error(`No network client for ${userId}`);
        }
        return client;
      };

      const firstThreads = await (
        clients[0] as NetworkedTestClient
      ).chatThreads(matchId as string);
      const firstPair = firstThreads.find(
        ({ otherUser }) => otherUser.userId === users[1],
      );
      assert.notEqual(firstPair, undefined);
      const quickPhrase = await (
        clients[0] as NetworkedTestClient
      ).sendQuickPhrase(
        matchId as string,
        firstPair?.threadId as string,
        "deal",
      );
      assert.equal(quickPhrase.deliveryStatus, "delivered");

      const openingOrder = (snapshots[0]?.roster ?? []).map(
        ({ userId }) => userId,
      );
      const openingVictim = openingOrder[0] as string;
      const openingAlternate = openingOrder[1] as string;
      const recipientVoteTarget =
        users[1] === openingVictim ? openingAlternate : openingVictim;
      const betrayedRequestedTarget = openingOrder.find(
        (userId) => userId !== users[1] && userId !== recipientVoteTarget,
      );
      assert.notEqual(betrayedRequestedTarget, undefined);
      const offer = await (clients[0] as NetworkedTestClient).createBribeOffer(
        matchId as string,
        {
          amount: 100,
          recipientUserId: users[1] as string,
          requestedTargetUserId: betrayedRequestedTarget as string,
        },
      );
      const accepted = await (
        clients[1] as NetworkedTestClient
      ).acceptBribeOffer(offer.offerId);
      assert.equal(accepted.state, "accepted");

      let matchState = await loadState();
      const eliminationOrder: string[] = [];
      while (
        matchState.roster.filter(({ status }) => status === "active").length > 2
      ) {
        assert.equal(matchState.phase, "negotiation");
        matchState = await advance(matchState);
        assert.equal(matchState.phase, "voting");
        const active = matchState.roster
          .filter(({ status }) => status === "active")
          .map(({ playerId }) => playerId as string);
        const victim = active[0] as string;
        const alternate = active[1] as string;
        for (const voter of active) {
          const acknowledgement = await clientFor(voter).submitBallot(
            matchId as string,
            voter === victim ? alternate : victim,
          );
          assert.equal(acknowledgement.submitted, true);
        }
        matchState = await loadState();
        assert.equal(matchState.phase, "tally");
        matchState = await advance(matchState);
        assert.equal(matchState.phase, "elimination");
        eliminationOrder.push(victim);
        matchState = await advance(matchState);
      }

      assert.equal(matchState.phase, "final_plea");
      const finalists = matchState.roster
        .filter(({ status }) => status === "active")
        .map(({ playerId }) => playerId as string);
      assert.equal(finalists.length, 2);
      for (const [index, finalist] of finalists.entries()) {
        await clientFor(finalist).submitFinalPlea(
          matchId as string,
          `Final plea from contestant ${index + 1}`,
        );
      }
      matchState = await loadState();
      assert.equal(matchState.phase, "jury_voting");

      const firstJuror = eliminationOrder[0] as string;
      await clientFor(firstJuror).connect(secondApi.listeningOrigin);
      const resumedJury = await clientFor(firstJuror).snapshot(
        matchId as string,
      );
      assert.equal(resumedJury.phase, "jury_voting");
      assert.equal(resumedJury.self.userId, firstJuror);
      assert.equal(resumedJury.finalPleas.length, 2);

      for (const juror of eliminationOrder) {
        await clientFor(juror).submitJuryBallot(
          matchId as string,
          finalists[0] as string,
        );
      }
      matchState = await loadState();
      matchState = await advance(matchState);
      assert.equal(matchState.phase, "complete");
      assert.equal(matchState.winnerPlayerId, finalists[0]);

      const completedSnapshots = await Promise.all(
        clients.map((client) => client.snapshot(matchId as string)),
      );
      assert.equal(
        completedSnapshots.every(
          (snapshot) =>
            snapshot.phase === "complete" &&
            snapshot.winnerUserId === finalists[0],
        ),
        true,
      );
      const dossier = await (clients[0] as NetworkedTestClient).dossier<{
        readonly deals: readonly { readonly outcome: string }[];
        readonly eliminationOrder: readonly string[];
        readonly winnerUserId: string;
      }>(matchId as string);
      assert.equal(dossier.winnerUserId, finalists[0]);
      assert.deepEqual(dossier.eliminationOrder, eliminationOrder);
      assert.equal(dossier.deals[0]?.outcome, "betrayed");
    } finally {
      await Promise.all(clients.map((client) => client.disconnect()));
      await Promise.all([
        firstApi?.close().catch(() => undefined),
        secondApi?.close().catch(() => undefined),
      ]);
      await pool?.end().catch(() => undefined);
      await admin
        .query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        .catch(() => undefined);
      await admin.end();
    }
  },
);
