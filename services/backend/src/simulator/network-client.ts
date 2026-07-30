import { randomUUID } from "node:crypto";

import type {
  MatchmakingTicketView,
  CreateTicketInput,
} from "../matchmaking/service.js";
import type { MatchReadyView } from "../matches/service.js";
import type {
  MatchSnapshot,
  RealtimeEventEnvelope,
} from "../realtime/events.js";

export class NetworkedTestClient {
  private socket: WebSocket | undefined;
  private readonly receivedEvents: RealtimeEventEnvelope[] = [];
  private readonly waiters = new Set<{
    readonly predicate: (event: RealtimeEventEnvelope) => boolean;
    readonly resolve: (event: RealtimeEventEnvelope) => void;
  }>();

  public constructor(
    private baseUrl: string,
    private readonly accessToken: string,
  ) {}

  public createTicket(
    input: CreateTicketInput,
  ): Promise<MatchmakingTicketView> {
    return this.request("/v1/matchmaking/tickets", {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "Idempotency-Key": randomUUID() },
    });
  }

  public inspectTicket(ticketId: string): Promise<MatchmakingTicketView> {
    return this.request(`/v1/matchmaking/tickets/${ticketId}`);
  }

  public confirmMatchmakingReady(
    ticketId: string,
  ): Promise<MatchmakingTicketView> {
    return this.request(`/v1/matchmaking/tickets/${ticketId}/ready`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
    });
  }

  public confirmBoothReady(matchId: string): Promise<MatchReadyView> {
    return this.request(`/v1/matches/${matchId}/ready`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
    });
  }

  public snapshot(matchId: string): Promise<MatchSnapshot> {
    return this.request(`/v1/matches/${matchId}/snapshot`);
  }

  public async connect(baseUrl = this.baseUrl): Promise<void> {
    await this.disconnect();
    this.baseUrl = baseUrl;
    const url = `${baseUrl.replace(/^http/u, "ws")}/v1/realtime`;
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, [
        "project-booth.v1",
        `bearer.${this.accessToken}`,
      ]);
      socket.addEventListener(
        "open",
        () => {
          this.socket = socket;
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => reject(new Error("Networked test client WebSocket failed")),
        { once: true },
      );
      socket.addEventListener("message", (message) => {
        const value = JSON.parse(String(message.data)) as {
          readonly recipientCursor?: unknown;
        };
        if (typeof value.recipientCursor !== "number") {
          return;
        }
        const event = value as unknown as RealtimeEventEnvelope;
        if (
          this.receivedEvents.some(({ eventId }) => eventId === event.eventId)
        ) {
          return;
        }
        this.receivedEvents.push(event);
        for (const waiter of this.waiters) {
          if (waiter.predicate(event)) {
            this.waiters.delete(waiter);
            waiter.resolve(event);
          }
        }
      });
    });
  }

  public resume(afterCursor: number): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("Networked test client is not connected");
    }
    this.socket.send(
      JSON.stringify({
        schemaVersion: 1,
        type: "connection.resume",
        afterCursor,
      }),
    );
  }

  public waitForEvent(
    predicate: (event: RealtimeEventEnvelope) => boolean,
    timeoutMilliseconds = 2_000,
  ): Promise<RealtimeEventEnvelope> {
    const existing = this.receivedEvents.find(predicate);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      this.waiters.add(waiter);
      setTimeout(() => {
        if (this.waiters.delete(waiter)) {
          reject(new Error("Timed out waiting for a networked match event"));
        }
      }, timeoutMilliseconds);
    });
  }

  public eventIds(): readonly string[] {
    return this.receivedEvents.map(({ eventId }) => eventId);
  }

  public disconnect(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    if (socket === undefined || socket.readyState === WebSocket.CLOSED) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      socket.addEventListener("close", () => resolve(), { once: true });
      socket.close();
    });
  }

  private async request<Result>(
    path: string,
    init: RequestInit = {},
  ): Promise<Result> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.accessToken}`);
    if (init.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });
    const body = (await response.json()) as unknown;
    if (!response.ok) {
      throw new Error(
        `Networked test request failed with HTTP ${response.status}: ${JSON.stringify(body)}`,
      );
    }
    return body as Result;
  }
}
