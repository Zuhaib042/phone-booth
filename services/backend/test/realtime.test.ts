import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import test from "node:test";

import type { ApiConfig } from "../src/config.js";
import { buildApi } from "../src/app.js";
import type { IdentityApplication } from "../src/identity/service.js";
import type {
  RealtimeEventEnvelope,
  PostgresRealtimeQueryService,
} from "../src/realtime/events.js";
import { RealtimeGateway } from "../src/realtime/websocket.js";

const TEST_CONFIG: ApiConfig = {
  host: "127.0.0.1",
  logLevel: "silent",
  nodeEnvironment: "test",
  port: 0,
};
const USER_ONE = "019824d0-7c1a-7a91-8c4a-3fe0f1b51001";
const USER_TWO = "019824d0-7c1a-7a91-8c4a-3fe0f1b51002";
const MATCH_ID = "019824d0-7c1a-7a91-8c4a-3fe0f1b51100";

const identity = {
  async authenticate(accessToken: string) {
    if (accessToken === "token-one") {
      return { sessionId: "session-one", userId: USER_ONE };
    }
    if (accessToken === "token-two") {
      return { sessionId: "session-two", userId: USER_TWO };
    }
    throw new Error("invalid token");
  },
} as IdentityApplication;

const firstEvent: RealtimeEventEnvelope = {
  schemaVersion: 1,
  eventId: "019824d0-7c1a-7a91-8c4a-3fe0f1b51201",
  type: "match.domain.match.created",
  occurredAt: "2026-07-30T12:00:00.000Z" as never,
  matchId: MATCH_ID,
  matchVersion: 1,
  recipientCursor: 1,
  audience: "player",
  recipientUserId: USER_ONE,
  payload: { phase: "lobby" },
};

function fakeQueries(events: readonly RealtimeEventEnvelope[]) {
  return {
    async listEvents(userId: string, cursor: number) {
      const visible = events.filter(
        (event) =>
          event.recipientCursor > cursor &&
          (event.recipientUserId === undefined ||
            event.recipientUserId === userId),
      );
      return {
        events: visible,
        hasMore: false,
        nextCursor: visible.at(-1)?.recipientCursor ?? cursor,
      };
    },
  } as unknown as PostgresRealtimeQueryService;
}

function socketUrl(address: string): string {
  return `${address.replace(/^http/u, "ws")}/v1/realtime`;
}

function openSocket(url: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, ["project-booth.v1", `bearer.${token}`]);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error("socket error")), {
      once: true,
    });
  });
}

function nextMessage(socket: WebSocket, timeout = 1_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for WebSocket message")),
      timeout,
    );
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        resolve(JSON.parse(String(event.data)) as unknown);
      },
      { once: true },
    );
  });
}

function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    socket.addEventListener("close", () => resolve(), { once: true });
    socket.close();
  });
}

test("authenticated WebSockets route private events and resume across instances", async () => {
  const query = fakeQueries([firstEvent]);
  const realtimeConfig = {
    heartbeatIntervalMilliseconds: 1_000,
    heartbeatTimeoutMilliseconds: 3_000,
    resumeLimit: 100,
  };
  const firstGateway = new RealtimeGateway(identity, query, realtimeConfig);
  const secondGateway = new RealtimeGateway(identity, query, realtimeConfig);
  const firstApi = buildApi(TEST_CONFIG, {
    identityService: identity,
    logger: false,
    realtimeGateway: firstGateway,
  });
  const secondApi = buildApi(TEST_CONFIG, {
    identityService: identity,
    logger: false,
    realtimeGateway: secondGateway,
  });

  await Promise.all([
    firstApi.listen({ host: "127.0.0.1", port: 0 }),
    secondApi.listen({ host: "127.0.0.1", port: 0 }),
  ]);
  const firstAddress = firstApi.listeningOrigin;
  const secondAddress = secondApi.listeningOrigin;
  let userTwoSocket: WebSocket | undefined;
  let reconnected: WebSocket | undefined;

  try {
    userTwoSocket = await openSocket(socketUrl(firstAddress), "token-two");
    const userOneSocket = await openSocket(
      socketUrl(secondAddress),
      "token-one",
    );
    assert.equal(firstGateway.connectionCount(USER_TWO), 1);
    assert.equal(secondGateway.connectionCount(USER_ONE), 1);

    const resumed = nextMessage(userOneSocket);
    userOneSocket.send(
      JSON.stringify({
        schemaVersion: 1,
        type: "connection.resume",
        afterCursor: 0,
      }),
    );
    assert.deepEqual(await resumed, firstEvent);

    const privateDelivery = {
      ...firstEvent,
      eventId: "019824d0-7c1a-7a91-8c4a-3fe0f1b51202",
      recipientCursor: 2,
    };
    const delivered = nextMessage(userOneSocket);
    firstGateway.deliver(USER_ONE, privateDelivery);
    secondGateway.deliver(USER_ONE, privateDelivery);
    assert.deepEqual(await delivered, privateDelivery);
    const unintended = nextMessage(userTwoSocket, 50).then(
      () => true,
      () => false,
    );
    assert.equal(await unintended, false);

    await closeSocket(userOneSocket);
    reconnected = await openSocket(socketUrl(firstAddress), "token-one");
    reconnected.send(
      JSON.stringify({
        schemaVersion: 1,
        type: "connection.resume",
        afterCursor: 1,
      }),
    );
    const duplicate = nextMessage(reconnected, 50).then(
      () => true,
      () => false,
    );
    assert.equal(await duplicate, false);
  } finally {
    await Promise.all(
      [userTwoSocket, reconnected]
        .filter((socket): socket is WebSocket => socket !== undefined)
        .map(closeSocket),
    );
    await Promise.all([firstGateway.stop(), secondGateway.stop()]);
    await Promise.all([firstApi.close(), secondApi.close()]);
  }
});

test("invalid WebSocket access tokens fail the authenticated upgrade", async () => {
  const gateway = new RealtimeGateway(identity, fakeQueries([]), {
    heartbeatIntervalMilliseconds: 1_000,
    heartbeatTimeoutMilliseconds: 3_000,
    resumeLimit: 100,
  });
  const api = buildApi(TEST_CONFIG, {
    identityService: identity,
    logger: false,
    realtimeGateway: gateway,
  });
  await api.listen({ host: "127.0.0.1", port: 0 });
  try {
    await assert.rejects(
      openSocket(socketUrl(api.listeningOrigin), "invalid"),
      /socket error/u,
    );
    assert.equal(gateway.connectionCount(), 0);
  } finally {
    await gateway.stop();
    await api.close();
  }
});

test("connections that stop answering heartbeat pings are closed", async () => {
  const gateway = new RealtimeGateway(identity, fakeQueries([]), {
    heartbeatIntervalMilliseconds: 20,
    heartbeatTimeoutMilliseconds: 50,
    resumeLimit: 100,
  });
  const api = buildApi(TEST_CONFIG, {
    identityService: identity,
    logger: false,
    realtimeGateway: gateway,
  });
  await api.listen({ host: "127.0.0.1", port: 0 });
  const port = Number(new URL(api.listeningOrigin).port);
  const socket = connect({ host: "127.0.0.1", port });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const key = randomBytes(16).toString("base64");
    socket.write(
      [
        "GET /v1/realtime HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Protocol: project-booth.v1, bearer.token-one",
        "",
        "",
      ].join("\r\n"),
    );
    socket.resume();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("stale WebSocket remained open")),
        500,
      );
      socket.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    assert.equal(gateway.connectionCount(), 0);
  } finally {
    socket.destroy();
    await gateway.stop();
    await api.close();
  }
});
