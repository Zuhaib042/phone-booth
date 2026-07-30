import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { buildApi } from "../src/app.js";
import type { ApiConfig } from "../src/config.js";
import type { IdentityApplication } from "../src/identity/service.js";
import { PostgresMatchApplication } from "../src/matches/service.js";
import { InMemoryMatchmakingQueue } from "../src/matchmaking/queue.js";
import { PostgresMatchmakingService } from "../src/matchmaking/service.js";
import { PostgresMatchCommandExecutor } from "../src/persistence/match-command-executor.js";
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

test(
  "M6 six-client simulator matches, enters the booth, and reconnects without sticky sessions",
  { skip: DATABASE_URL === undefined },
  async () => {
    assert.notEqual(DATABASE_URL, undefined);
    const schema = `m6_network_${randomUUID().replaceAll("-", "")}`;
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
      const users = Array.from({ length: 6 }, () => randomUUID());
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
      const matchmaking = new PostgresMatchmakingService(
        transactions,
        new InMemoryMatchmakingQueue(),
        {
          lobbyReadyTimeoutSeconds: 30,
          readyTimeoutSeconds: 15,
          recentPairingWindowSeconds: 86_400,
        },
        undefined,
        () => new Date("2026-07-30T12:00:00.000Z"),
      );
      const matches = new PostgresMatchApplication(
        new PostgresMatchCommandExecutor(transactions),
        () => new Date("2026-07-30T12:00:05.000Z"),
      );
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
        identityService: identity,
        logger: false,
        matchService: matches,
        matchmakingService: matchmaking,
        realtimeGateway: firstGateway,
        realtimeQueryService: queries,
      });
      secondApi = buildApi(API_CONFIG, {
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
