import type { Redis as Valkey } from "iovalkey";
import type { PoolClient } from "pg";

import type { PostgresTransactionRunner } from "../persistence/transaction.js";

export interface QueueTicket {
  readonly createdAtMilliseconds: number;
  readonly queueKey: string;
  readonly ticketId: string;
}

export interface MatchmakingQueue {
  enqueue(ticket: QueueTicket): Promise<void>;
  list(queueKey: string, limit: number): Promise<readonly string[]>;
  remove(ticketId: string, queueKey: string): Promise<void>;
}

function valkeyKey(queueKey: string): string {
  return `project-booth:matchmaking:${queueKey}`;
}

export class ValkeyMatchmakingQueue implements MatchmakingQueue {
  public constructor(private readonly valkey: Valkey) {}

  public async enqueue(ticket: QueueTicket): Promise<void> {
    await this.valkey.zadd(
      valkeyKey(ticket.queueKey),
      String(ticket.createdAtMilliseconds),
      ticket.ticketId,
    );
  }

  public async list(
    queueKey: string,
    limit: number,
  ): Promise<readonly string[]> {
    return this.valkey.zrange(valkeyKey(queueKey), "0", String(limit - 1));
  }

  public async remove(ticketId: string, queueKey: string): Promise<void> {
    await this.valkey.zrem(valkeyKey(queueKey), ticketId);
  }
}

export class InMemoryMatchmakingQueue implements MatchmakingQueue {
  private readonly tickets = new Map<string, Map<string, number>>();

  public async enqueue(ticket: QueueTicket): Promise<void> {
    const group =
      this.tickets.get(ticket.queueKey) ?? new Map<string, number>();
    group.set(ticket.ticketId, ticket.createdAtMilliseconds);
    this.tickets.set(ticket.queueKey, group);
  }

  public async list(
    queueKey: string,
    limit: number,
  ): Promise<readonly string[]> {
    return [...(this.tickets.get(queueKey)?.entries() ?? [])]
      .sort(
        ([leftId, leftTime], [rightId, rightTime]) =>
          leftTime - rightTime || leftId.localeCompare(rightId),
      )
      .slice(0, limit)
      .map(([ticketId]) => ticketId);
  }

  public async remove(ticketId: string, queueKey: string): Promise<void> {
    this.tickets.get(queueKey)?.delete(ticketId);
  }
}

interface QueuedTicketRow {
  readonly created_at: Date;
  readonly id: string;
  readonly queue_key: string;
}

export class MatchmakingQueueReconciler {
  public constructor(
    private readonly transactions: PostgresTransactionRunner,
    private readonly queue: MatchmakingQueue,
  ) {}

  public async synchronize(limit = 500): Promise<number> {
    const tickets = await this.transactions.run(
      async (client: PoolClient): Promise<readonly QueuedTicketRow[]> => {
        const result = await client.query<QueuedTicketRow>(
          `
            SELECT id, queue_key, created_at
            FROM matchmaking_tickets
            WHERE status = 'queued'
            ORDER BY created_at, id
            LIMIT $1
          `,
          [limit],
        );
        return result.rows;
      },
    );
    await Promise.all(
      tickets.map((ticket) =>
        this.queue.enqueue({
          createdAtMilliseconds: ticket.created_at.getTime(),
          queueKey: ticket.queue_key,
          ticketId: ticket.id,
        }),
      ),
    );
    return tickets.length;
  }
}
