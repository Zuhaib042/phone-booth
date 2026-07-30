import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

import type { Redis as Valkey } from "iovalkey";

import type { RealtimeConfig } from "../config.js";
import type { IdentityApplication } from "../identity/service.js";
import type {
  PostgresRealtimeQueryService,
  RealtimeEventEnvelope,
} from "./events.js";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_CLIENT_FRAME_BYTES = 64 * 1_024;

interface ClientConnection {
  readonly connectionId: string;
  readonly userId: string;
  close(code?: number): void;
  sendJson(value: unknown): void;
}

export interface ConnectionPresenceStore {
  refresh(connectionId: string, userId: string): Promise<void>;
  remove(connectionId: string, userId: string): Promise<void>;
}

export class ValkeyConnectionPresenceStore implements ConnectionPresenceStore {
  public constructor(
    private readonly valkey: Valkey,
    private readonly instanceId: string,
    private readonly ttlMilliseconds: number,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async refresh(connectionId: string, userId: string): Promise<void> {
    const expiresAt = this.clock().getTime() + this.ttlMilliseconds;
    const transaction = this.valkey.multi();
    transaction.set(
      `project-booth:realtime:connection:${connectionId}`,
      JSON.stringify({ connectionId, instanceId: this.instanceId, userId }),
      "PX",
      this.ttlMilliseconds,
    );
    transaction.zadd(
      `project-booth:realtime:user:${userId}`,
      expiresAt,
      connectionId,
    );
    transaction.pexpire(
      `project-booth:realtime:user:${userId}`,
      this.ttlMilliseconds * 2,
    );
    await transaction.exec();
  }

  public async remove(connectionId: string, userId: string): Promise<void> {
    const transaction = this.valkey.multi();
    transaction.del(`project-booth:realtime:connection:${connectionId}`);
    transaction.zrem(`project-booth:realtime:user:${userId}`, connectionId);
    await transaction.exec();
  }
}

function websocketAccept(key: string): string {
  return createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
}

function frame(opcode: number, payload: Uint8Array = Buffer.alloc(0)): Buffer {
  const bytes = Buffer.from(payload);
  const size = bytes.length;
  let header: Buffer;
  if (size < 126) {
    header = Buffer.from([0x80 | opcode, size]);
  } else if (size <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(size, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(size), 2);
  }
  return Buffer.concat([header, bytes]);
}

class NativeWebSocketConnection implements ClientConnection {
  private buffer: Buffer = Buffer.alloc(0);
  private closed = false;
  private lastPongAt = Date.now();
  private heartbeat: NodeJS.Timeout | undefined;

  public constructor(
    public readonly connectionId: string,
    public readonly userId: string,
    private readonly socket: Duplex,
    head: Buffer,
    private readonly config: RealtimeConfig,
    private readonly onText: (value: string) => Promise<void>,
    private readonly onClose: () => void,
    private readonly onHeartbeat: () => Promise<void>,
  ) {
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("close", () => this.finish());
    socket.on("end", () => this.finish());
    socket.on("error", () => this.finish());
    if (head.length > 0) {
      this.receive(head);
    }
    this.heartbeat = setInterval(
      () => this.heartbeatTick(),
      config.heartbeatIntervalMilliseconds,
    );
  }

  public sendJson(value: unknown): void {
    if (!this.closed) {
      this.socket.write(frame(0x1, Buffer.from(JSON.stringify(value), "utf8")));
    }
  }

  public close(code = 1000): void {
    if (this.closed) {
      return;
    }
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code);
    this.socket.write(frame(0x8, body));
    this.socket.end();
    this.finish();
  }

  private heartbeatTick(): void {
    if (
      Date.now() - this.lastPongAt >
      this.config.heartbeatTimeoutMilliseconds
    ) {
      this.socket.destroy();
      this.finish();
      return;
    }
    this.socket.write(frame(0x9));
    void this.onHeartbeat().catch(() => undefined);
  }

  private receive(chunk: Buffer): void {
    if (this.closed) {
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.readFrame()) {
      // Continue until the buffered bytes no longer contain a complete frame.
    }
  }

  private readFrame(): boolean {
    if (this.buffer.length < 2) {
      return false;
    }
    const first = this.buffer[0] as number;
    const second = this.buffer[1] as number;
    const final = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (!final || !masked) {
      this.close(1002);
      return false;
    }
    if (length === 126) {
      if (this.buffer.length < 4) {
        return false;
      }
      length = this.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (this.buffer.length < 10) {
        return false;
      }
      const largeLength = this.buffer.readBigUInt64BE(2);
      if (largeLength > BigInt(MAX_CLIENT_FRAME_BYTES)) {
        this.close(1009);
        return false;
      }
      length = Number(largeLength);
      offset = 10;
    }
    if (length > MAX_CLIENT_FRAME_BYTES) {
      this.close(1009);
      return false;
    }
    if (this.buffer.length < offset + 4 + length) {
      return false;
    }
    const mask = this.buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
    this.buffer = this.buffer.subarray(offset + length);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] =
        (payload[index] as number) ^ (mask[index % mask.length] as number);
    }
    this.handleFrame(opcode, payload);
    return this.buffer.length > 0;
  }

  private handleFrame(opcode: number, payload: Buffer): void {
    if (opcode === 0x1) {
      void this.onText(payload.toString("utf8")).catch(() => this.close(1011));
      return;
    }
    if (opcode === 0x8) {
      this.close();
      return;
    }
    if (opcode === 0x9) {
      this.socket.write(frame(0xa, payload));
      return;
    }
    if (opcode === 0xa) {
      this.lastPongAt = Date.now();
      void this.onHeartbeat().catch(() => undefined);
      return;
    }
    this.close(1003);
  }

  private finish(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    this.onClose();
  }
}

interface PublishedOutboxMessage {
  readonly aggregateId?: unknown;
  readonly aggregateType?: unknown;
  readonly payload?: unknown;
}

interface ClientMessageRecord {
  readonly afterCursor?: unknown;
  readonly schemaVersion?: unknown;
  readonly state?: unknown;
  readonly type?: unknown;
}

function protocolError(
  code: "internal_error" | "malformed_message" | "unsupported_schema_version",
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    type: "protocol.error",
    errorId: randomUUID(),
    occurredAt: new Date().toISOString(),
    code,
    retryable: code === "internal_error",
    ...(code === "unsupported_schema_version"
      ? { expectedSchemaVersion: 1 }
      : {}),
  };
}

function accessToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  const bearer =
    typeof authorization === "string"
      ? /^Bearer ([^\s]+)$/u.exec(authorization)?.[1]
      : undefined;
  if (bearer !== undefined) {
    return bearer;
  }
  const protocols = request.headers["sec-websocket-protocol"];
  if (typeof protocols !== "string") {
    return undefined;
  }
  const tokenProtocol = protocols
    .split(",")
    .map((value) => value.trim())
    .find((value) => value.startsWith("bearer."));
  return tokenProtocol?.slice("bearer.".length);
}

function rejectUpgrade(socket: Duplex, status: 400 | 401 | 404): void {
  const label =
    status === 401
      ? "Unauthorized"
      : status === 404
        ? "Not Found"
        : "Bad Request";
  socket.end(
    `HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

export class RealtimeGateway {
  private readonly connections = new Map<
    string,
    Map<string, ClientConnection>
  >();
  private server: HttpServer | undefined;
  private started = false;

  public constructor(
    private readonly identity: IdentityApplication,
    private readonly queries: PostgresRealtimeQueryService,
    private readonly config: RealtimeConfig,
    private readonly subscriber?: Valkey,
    private readonly outboxChannel = "project-booth:events",
    private readonly presence?: ConnectionPresenceStore,
  ) {}

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    if (this.subscriber !== undefined) {
      this.subscriber.on("message", (channel, message) => {
        if (channel === this.outboxChannel) {
          this.deliverPublished(message);
        }
      });
      await this.subscriber.subscribe(this.outboxChannel);
    }
  }

  public attach(server: HttpServer): void {
    if (this.server !== undefined) {
      throw new Error("The real-time gateway is already attached");
    }
    this.server = server;
    server.on("upgrade", this.handleUpgrade);
  }

  public async stop(): Promise<void> {
    if (this.server !== undefined) {
      this.server.off("upgrade", this.handleUpgrade);
      this.server = undefined;
    }
    for (const connection of [...this.connections.values()].flatMap((group) => [
      ...group.values(),
    ])) {
      connection.close(1001);
    }
    this.connections.clear();
    if (this.subscriber !== undefined) {
      await this.subscriber.unsubscribe(this.outboxChannel).catch(() => 0);
      this.subscriber.disconnect();
    }
    this.started = false;
  }

  public deliver(userId: string, envelope: RealtimeEventEnvelope): void {
    for (const connection of this.connections.get(userId)?.values() ?? []) {
      connection.sendJson(envelope);
    }
  }

  public connectionCount(userId?: string): number {
    if (userId !== undefined) {
      return this.connections.get(userId)?.size ?? 0;
    }
    return [...this.connections.values()].reduce(
      (total, group) => total + group.size,
      0,
    );
  }

  private readonly handleUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    void this.upgrade(request, socket, head);
  };

  private async upgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== "/v1/realtime") {
      rejectUpgrade(socket, 404);
      return;
    }
    const key = request.headers["sec-websocket-key"];
    if (
      request.headers.upgrade?.toLowerCase() !== "websocket" ||
      request.headers["sec-websocket-version"] !== "13" ||
      typeof key !== "string"
    ) {
      rejectUpgrade(socket, 400);
      return;
    }
    const token = accessToken(request);
    if (token === undefined) {
      rejectUpgrade(socket, 401);
      return;
    }
    let userId: string;
    try {
      userId = (await this.identity.authenticate(token)).userId;
    } catch {
      rejectUpgrade(socket, 401);
      return;
    }
    const protocols = request.headers["sec-websocket-protocol"];
    const selectsProjectBoothProtocol =
      typeof protocols === "string" &&
      protocols
        .split(",")
        .map((value) => value.trim())
        .includes("project-booth.v1");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
        ...(selectsProjectBoothProtocol
          ? ["Sec-WebSocket-Protocol: project-booth.v1"]
          : []),
        "",
        "",
      ].join("\r\n"),
    );
    const connectionId = randomUUID();
    let connection: NativeWebSocketConnection;
    connection = new NativeWebSocketConnection(
      connectionId,
      userId,
      socket,
      head,
      this.config,
      async (message) => this.handleClientMessage(connection, message),
      () => this.unregister(connection),
      async () => this.presence?.refresh(connectionId, userId),
    );
    const group =
      this.connections.get(userId) ?? new Map<string, ClientConnection>();
    group.set(connectionId, connection);
    this.connections.set(userId, group);
    await this.presence?.refresh(connectionId, userId).catch(() => undefined);
  }

  private unregister(connection: ClientConnection): void {
    const group = this.connections.get(connection.userId);
    group?.delete(connection.connectionId);
    if (group?.size === 0) {
      this.connections.delete(connection.userId);
    }
    void this.presence
      ?.remove(connection.connectionId, connection.userId)
      .catch(() => undefined);
  }

  private async handleClientMessage(
    connection: ClientConnection,
    message: string,
  ): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(message);
    } catch {
      connection.sendJson(protocolError("malformed_message"));
      return;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      connection.sendJson(protocolError("malformed_message"));
      return;
    }
    const record = value as ClientMessageRecord;
    if (record.schemaVersion !== 1) {
      connection.sendJson(protocolError("unsupported_schema_version"));
      return;
    }
    if (record.type === "connection.state") {
      if (!["foreground", "background"].includes(String(record.state))) {
        connection.sendJson(protocolError("malformed_message"));
      }
      return;
    }
    if (
      record.type !== "connection.resume" ||
      !Number.isSafeInteger(record.afterCursor) ||
      (record.afterCursor as number) < 0
    ) {
      connection.sendJson(protocolError("malformed_message"));
      return;
    }
    try {
      const page = await this.queries.listEvents(
        connection.userId,
        record.afterCursor as number,
        this.config.resumeLimit,
      );
      for (const event of page.events) {
        connection.sendJson(event);
      }
      if (page.hasMore) {
        connection.sendJson({
          schemaVersion: 1,
          type: "protocol.error",
          errorId: randomUUID(),
          occurredAt: new Date().toISOString(),
          code: "resync_required",
          retryable: true,
          resumeFromCursor: page.nextCursor,
        });
      }
    } catch {
      connection.sendJson(protocolError("internal_error"));
    }
  }

  private deliverPublished(message: string): void {
    let value: PublishedOutboxMessage;
    try {
      value = JSON.parse(message) as PublishedOutboxMessage;
    } catch {
      return;
    }
    if (
      value.aggregateType !== "realtime-recipient" ||
      typeof value.aggregateId !== "string" ||
      value.payload === null ||
      typeof value.payload !== "object" ||
      Array.isArray(value.payload)
    ) {
      return;
    }
    this.deliver(
      value.aggregateId,
      value.payload as unknown as RealtimeEventEnvelope,
    );
  }
}
