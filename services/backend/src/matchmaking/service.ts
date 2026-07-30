import { randomUUID } from "node:crypto";

import {
  DEFAULT_RULESET_V1,
  parseRulesetV1,
  type RulesetV1,
  type RulesetV1Input,
} from "@project-booth/config";
import {
  parseEntityId,
  utcTimestampFromDate,
  type MatchId,
  type UserId,
  type UtcTimestamp,
} from "@project-booth/domain";
import { createMatchState } from "@project-booth/game-engine";
import type { PoolClient } from "pg";

import type { MatchmakingConfig } from "../config.js";
import {
  hashIdempotencyRequest,
  PostgresIdempotencyRepository,
  type StoredHttpResponse,
} from "../persistence/idempotency.js";
import type { JsonObject } from "../persistence/json.js";
import { toJsonObject } from "../persistence/json.js";
import { PostgresMatchRepository } from "../persistence/match-repository.js";
import { PostgresOutboxRepository } from "../persistence/outbox.js";
import { PostgresScheduledJobRepository } from "../persistence/scheduled-jobs.js";
import type { PostgresTransactionRunner } from "../persistence/transaction.js";
import {
  PostgresRealtimeEventRepository,
  type ProjectedMatchEvent,
} from "../realtime/events.js";
import type { MatchmakingQueue, QueueTicket } from "./queue.js";

export const MATCHMAKING_READY_TIMEOUT_JOB_KIND = "matchmaking.ready-timeout";

export interface CreateTicketInput {
  readonly compatibilityVersion: number;
  readonly language: string;
  readonly region: string;
}

export type MatchmakingTicketStatus =
  "cancelled" | "matched" | "proposed" | "queued";

export interface MatchmakingTicketView {
  readonly compatibilityVersion: number;
  readonly createdAt: string;
  readonly language: string;
  readonly matchId?: string;
  readonly proposalId?: string;
  readonly readyConfirmed: boolean;
  readonly readyDeadline?: string;
  readonly region: string;
  readonly rulesetId: string;
  readonly rulesetVersion: number;
  readonly status: MatchmakingTicketStatus;
  readonly ticketId: string;
  readonly updatedAt: string;
}

export interface MatchmakingCommandResult {
  readonly replayed: boolean;
  readonly responseStatus: number;
  readonly ticket: MatchmakingTicketView;
}

export interface MatchmakingApplication {
  cancelTicket(
    userId: string,
    ticketId: string,
    idempotencyKey: string,
  ): Promise<MatchmakingCommandResult>;
  confirmReady(
    userId: string,
    ticketId: string,
    idempotencyKey: string,
  ): Promise<MatchmakingCommandResult>;
  createTicket(
    userId: string,
    idempotencyKey: string,
    input: CreateTicketInput,
  ): Promise<MatchmakingCommandResult>;
  getTicket(userId: string, ticketId: string): Promise<MatchmakingTicketView>;
}

export type MatchmakingErrorCode =
  | "account_ineligible"
  | "matchmaking_conflict"
  | "ticket_not_found"
  | "ticket_not_ready";

export class MatchmakingError extends Error {
  public constructor(
    public readonly code: MatchmakingErrorCode,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "MatchmakingError";
  }
}

interface TicketRow {
  readonly compatibility_version: number;
  readonly created_at: Date;
  readonly id: string;
  readonly language: string;
  readonly match_id: string | null;
  readonly proposal_id: string | null;
  readonly queue_key: string;
  readonly ready_at: Date | null;
  readonly ready_deadline: Date | null;
  readonly region: string;
  readonly restriction_pool: string;
  readonly ruleset_id: string;
  readonly ruleset_version: number;
  readonly status: MatchmakingTicketStatus;
  readonly updated_at: Date;
  readonly user_id: string;
}

interface EligibleTicketRow extends TicketRow {
  readonly current_restriction_pool: string;
  readonly matchmaking_allowed: boolean;
  readonly user_status: string;
}

interface CommandOutcome {
  readonly replayed: boolean;
  readonly response: StoredHttpResponse;
  readonly ticket: TicketRow;
  readonly queueAfterCommit?: readonly QueueTicket[];
  readonly removeAfterCommit?: readonly QueueTicket[];
}

const TICKET_SELECT = `
  SELECT
    ticket.id,
    ticket.user_id,
    ticket.ruleset_id,
    ticket.ruleset_version,
    ticket.region,
    ticket.language,
    ticket.compatibility_version,
    ticket.restriction_pool,
    ticket.queue_key,
    ticket.status,
    ticket.proposal_id,
    ticket.ready_at,
    ticket.match_id,
    ticket.created_at,
    ticket.updated_at,
    proposal.ready_deadline
  FROM matchmaking_tickets AS ticket
  LEFT JOIN matchmaking_proposals AS proposal ON proposal.id = ticket.proposal_id
`;

function timestamp(date: Date): UtcTimestamp {
  const parsed = utcTimestampFromDate(date);
  if (!parsed.ok) {
    throw new RangeError("Matchmaking clock returned an invalid timestamp");
  }
  return parsed.value;
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1_000);
}

function queueKey(
  ruleset: RulesetV1,
  input: CreateTicketInput,
  restrictionPool: string,
): string {
  return [
    `${ruleset.rulesetId}.${ruleset.rulesetVersion}`,
    input.region,
    input.language,
    `compat-${input.compatibilityVersion}`,
    restrictionPool,
  ].join(":");
}

function toQueueTicket(row: TicketRow): QueueTicket {
  return {
    createdAtMilliseconds: row.created_at.getTime(),
    queueKey: row.queue_key,
    ticketId: row.id,
  };
}

function toView(row: TicketRow): MatchmakingTicketView {
  return {
    compatibilityVersion: row.compatibility_version,
    createdAt: row.created_at.toISOString(),
    language: row.language,
    ...(row.match_id === null ? {} : { matchId: row.match_id }),
    ...(row.proposal_id === null ? {} : { proposalId: row.proposal_id }),
    readyConfirmed: row.ready_at !== null,
    ...(row.ready_deadline === null
      ? {}
      : { readyDeadline: row.ready_deadline.toISOString() }),
    region: row.region,
    rulesetId: row.ruleset_id,
    rulesetVersion: row.ruleset_version,
    status: row.status,
    ticketId: row.id,
    updatedAt: row.updated_at.toISOString(),
  };
}

function response(ticket: TicketRow, status: number): StoredHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: toJsonObject(toView(ticket)),
  };
}

function ticketFromStored(
  responseValue: StoredHttpResponse,
): MatchmakingTicketView {
  return responseValue.body as unknown as MatchmakingTicketView;
}

async function loadTicket(
  client: PoolClient,
  userId: string,
  ticketId: string,
  forUpdate = false,
): Promise<TicketRow | undefined> {
  const result = await client.query<TicketRow>(
    `
      ${TICKET_SELECT}
      WHERE ticket.id = $1 AND ticket.user_id = $2
      ${forUpdate ? "FOR UPDATE OF ticket" : ""}
    `,
    [ticketId, userId],
  );
  return result.rows[0];
}

function ticketNotFound(): MatchmakingError {
  return new MatchmakingError(
    "ticket_not_found",
    "The matchmaking ticket was not found",
    404,
  );
}

async function persistRuleset(
  client: PoolClient,
  ruleset: RulesetV1,
): Promise<void> {
  const snapshot = JSON.stringify(toJsonObject(ruleset));
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
      snapshot,
    ],
  );
  const existing = await client.query<{ snapshot_matches: boolean }>(
    `
      SELECT snapshot = $3::jsonb AS snapshot_matches
      FROM rulesets
      WHERE id = $1 AND version = $2
    `,
    [ruleset.rulesetId, ruleset.rulesetVersion, snapshot],
  );
  if (existing.rows[0]?.snapshot_matches !== true) {
    throw new Error("Configured matchmaking ruleset conflicts with storage");
  }
}

async function commandIdentity(
  userId: string,
  operation: string,
  idempotencyKey: string,
  request: JsonObject,
): Promise<{
  readonly accountId: UserId;
  readonly key: string;
  readonly operation: string;
  readonly requestHash: string;
}> {
  const parsed = parseEntityId("user", userId);
  if (!parsed.ok) {
    throw new MatchmakingError(
      "account_ineligible",
      "The account cannot enter matchmaking",
      403,
    );
  }
  return {
    accountId: parsed.value as UserId,
    key: idempotencyKey,
    operation,
    requestHash: hashIdempotencyRequest(request),
  };
}

export class PostgresMatchmakingService implements MatchmakingApplication {
  private readonly ruleset: RulesetV1;

  public constructor(
    private readonly transactions: PostgresTransactionRunner,
    private readonly queue: MatchmakingQueue,
    private readonly config: MatchmakingConfig,
    rulesetInput: RulesetV1Input = DEFAULT_RULESET_V1,
    private readonly clock: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
    private readonly idempotency = new PostgresIdempotencyRepository(),
    private readonly matches = new PostgresMatchRepository(),
    private readonly outbox = new PostgresOutboxRepository(),
    private readonly scheduledJobs = new PostgresScheduledJobRepository(),
    private readonly realtimeEvents = new PostgresRealtimeEventRepository(),
  ) {
    const parsed = parseRulesetV1(structuredClone(rulesetInput));
    if (!parsed.ok) {
      throw new TypeError("The matchmaking ruleset is invalid");
    }
    this.ruleset = parsed.value;
  }

  public async createTicket(
    userId: string,
    idempotencyKey: string,
    input: CreateTicketInput,
  ): Promise<MatchmakingCommandResult> {
    const occurredAt = timestamp(this.clock());
    const request = toJsonObject(input);
    const identity = await commandIdentity(
      userId,
      "matchmaking.ticket.create",
      idempotencyKey,
      request,
    );
    const outcome = await this.transactions.run<CommandOutcome>(
      async (client) => {
        const acquisition = await this.idempotency.acquire(
          client,
          identity,
          occurredAt,
        );
        if (!acquisition.acquired) {
          return {
            replayed: true,
            response: acquisition.response,
            ticket: {
              ...(acquisition.response.body as unknown as TicketRow),
            },
          };
        }
        await persistRuleset(client, this.ruleset);
        const account = await client.query<{
          allowed: boolean;
          restriction_pool: string;
          status: string;
        }>(
          `
            SELECT
              users.status,
              COALESCE(safety.matchmaking_allowed, true) AS allowed,
              COALESCE(safety.restriction_pool, 'standard') AS restriction_pool
            FROM users
            LEFT JOIN matchmaking_safety AS safety ON safety.user_id = users.id
            WHERE users.id = $1
            FOR UPDATE OF users
          `,
          [userId],
        );
        const eligibility = account.rows[0];
        if (
          eligibility === undefined ||
          eligibility.status !== "active" ||
          !eligibility.allowed
        ) {
          throw new MatchmakingError(
            "account_ineligible",
            "The account cannot enter matchmaking",
            403,
          );
        }
        const existing = await client.query<TicketRow>(
          `
            ${TICKET_SELECT}
            WHERE
              ticket.user_id = $1
              AND ticket.status IN ('queued', 'proposed')
            ORDER BY ticket.created_at DESC
            LIMIT 1
            FOR UPDATE OF ticket
          `,
          [userId],
        );
        let ticket = existing.rows[0];
        const status = ticket === undefined ? 201 : 200;
        if (ticket === undefined) {
          const id = this.newId();
          const group = queueKey(
            this.ruleset,
            input,
            eligibility.restriction_pool,
          );
          const inserted = await client.query<TicketRow>(
            `
              INSERT INTO matchmaking_tickets (
                id,
                user_id,
                ruleset_id,
                ruleset_version,
                region,
                language,
                compatibility_version,
                restriction_pool,
                queue_key,
                status,
                created_at,
                updated_at
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', $10, $10)
              RETURNING
                id,
                user_id,
                ruleset_id,
                ruleset_version,
                region,
                language,
                compatibility_version,
                restriction_pool,
                queue_key,
                status,
                proposal_id,
                ready_at,
                match_id,
                created_at,
                updated_at,
                NULL::timestamptz AS ready_deadline
            `,
            [
              id,
              userId,
              this.ruleset.rulesetId,
              this.ruleset.rulesetVersion,
              input.region,
              input.language,
              input.compatibilityVersion,
              eligibility.restriction_pool,
              group,
              occurredAt,
            ],
          );
          ticket = inserted.rows[0];
        }
        if (ticket === undefined) {
          throw new Error("Matchmaking ticket was not created");
        }
        const stored = response(ticket, status);
        await this.idempotency.complete(client, identity, stored, occurredAt);
        return {
          replayed: false,
          response: stored,
          ticket,
          ...(ticket.status === "queued"
            ? { queueAfterCommit: [toQueueTicket(ticket)] }
            : {}),
        };
      },
    );

    const replayedTicket =
      "ticketId" in (outcome.response.body as object)
        ? ticketFromStored(outcome.response)
        : toView(outcome.ticket);
    for (const queued of outcome.queueAfterCommit ?? []) {
      await this.queue.enqueue(queued);
      await this.tryFormProposal(queued.queueKey);
    }
    return {
      replayed: outcome.replayed,
      responseStatus: outcome.response.status,
      ticket: replayedTicket,
    };
  }

  public getTicket(
    userId: string,
    ticketId: string,
  ): Promise<MatchmakingTicketView> {
    return this.transactions.run(async (client) => {
      const ticket = await loadTicket(client, userId, ticketId);
      if (ticket === undefined) {
        throw ticketNotFound();
      }
      return toView(ticket);
    });
  }

  public async cancelTicket(
    userId: string,
    ticketId: string,
    idempotencyKey: string,
  ): Promise<MatchmakingCommandResult> {
    const occurredAt = timestamp(this.clock());
    const request = { ticketId };
    const identity = await commandIdentity(
      userId,
      "matchmaking.ticket.cancel",
      idempotencyKey,
      request,
    );
    const outcome = await this.transactions.run<CommandOutcome>(
      async (client) => {
        const acquisition = await this.idempotency.acquire(
          client,
          identity,
          occurredAt,
        );
        if (!acquisition.acquired) {
          return {
            replayed: true,
            response: acquisition.response,
            ticket: acquisition.response.body as unknown as TicketRow,
          };
        }
        const current = await loadTicket(client, userId, ticketId, true);
        if (current === undefined) {
          throw ticketNotFound();
        }
        let queueAfterCommit: readonly QueueTicket[] = [];
        if (current.status === "proposed" && current.proposal_id !== null) {
          queueAfterCommit = await this.releaseProposal(
            client,
            current.proposal_id,
            occurredAt,
            ticketId,
          );
        } else if (current.status === "queued") {
          await client.query(
            `
              UPDATE matchmaking_tickets
              SET status = 'cancelled', cancelled_at = $2, updated_at = $2
              WHERE id = $1 AND status = 'queued'
            `,
            [ticketId, occurredAt],
          );
        }
        const ticket = await loadTicket(client, userId, ticketId, true);
        if (ticket === undefined) {
          throw ticketNotFound();
        }
        const stored = response(ticket, 200);
        await this.idempotency.complete(client, identity, stored, occurredAt);
        return {
          replayed: false,
          response: stored,
          ticket,
          queueAfterCommit,
          removeAfterCommit: [toQueueTicket(current)],
        };
      },
    );
    await this.applyQueueChanges(outcome);
    return {
      replayed: outcome.replayed,
      responseStatus: outcome.response.status,
      ticket: ticketFromStored(outcome.response),
    };
  }

  public async confirmReady(
    userId: string,
    ticketId: string,
    idempotencyKey: string,
  ): Promise<MatchmakingCommandResult> {
    const now = this.clock();
    const occurredAt = timestamp(now);
    const request = { ticketId };
    const identity = await commandIdentity(
      userId,
      "matchmaking.ticket.ready",
      idempotencyKey,
      request,
    );
    const outcome = await this.transactions.run<CommandOutcome>(
      async (client) => {
        const acquisition = await this.idempotency.acquire(
          client,
          identity,
          occurredAt,
        );
        if (!acquisition.acquired) {
          return {
            replayed: true,
            response: acquisition.response,
            ticket: acquisition.response.body as unknown as TicketRow,
          };
        }
        let current = await loadTicket(client, userId, ticketId, true);
        if (current === undefined) {
          throw ticketNotFound();
        }
        let queueAfterCommit: readonly QueueTicket[] = [];
        if (current.status === "matched") {
          const stored = response(current, 200);
          await this.idempotency.complete(client, identity, stored, occurredAt);
          return { replayed: false, response: stored, ticket: current };
        }
        if (current.status !== "proposed" || current.proposal_id === null) {
          throw new MatchmakingError(
            "ticket_not_ready",
            "The ticket has no pending ready confirmation",
            409,
          );
        }
        const proposal = await client.query<{
          ready_deadline: Date;
          status: string;
        }>(
          `
            SELECT ready_deadline, status
            FROM matchmaking_proposals
            WHERE id = $1
            FOR UPDATE
          `,
          [current.proposal_id],
        );
        const proposalRow = proposal.rows[0];
        if (
          proposalRow === undefined ||
          proposalRow.status !== "pending" ||
          proposalRow.ready_deadline <= now
        ) {
          queueAfterCommit = await this.releaseProposal(
            client,
            current.proposal_id,
            occurredAt,
          );
        } else {
          await client.query(
            `
              UPDATE matchmaking_tickets
              SET ready_at = COALESCE(ready_at, $2), updated_at = $2
              WHERE id = $1 AND status = 'proposed'
            `,
            [ticketId, occurredAt],
          );
          const readiness = await client.query<{
            ready_count: string;
            roster_count: string;
          }>(
            `
              SELECT
                count(*) FILTER (WHERE ready_at IS NOT NULL) AS ready_count,
                count(*) AS roster_count
              FROM matchmaking_tickets
              WHERE proposal_id = $1 AND status = 'proposed'
            `,
            [current.proposal_id],
          );
          const counts = readiness.rows[0];
          if (
            counts !== undefined &&
            Number(counts.ready_count) === Number(counts.roster_count) &&
            Number(counts.roster_count) === this.ruleset.roster.contestantCount
          ) {
            await this.createDurableMatch(
              client,
              current.proposal_id,
              occurredAt,
            );
          }
        }
        current = await loadTicket(client, userId, ticketId, true);
        if (current === undefined) {
          throw ticketNotFound();
        }
        const stored = response(current, 200);
        await this.idempotency.complete(client, identity, stored, occurredAt);
        return {
          replayed: false,
          response: stored,
          ticket: current,
          queueAfterCommit,
        };
      },
    );
    await this.applyQueueChanges(outcome);
    return {
      replayed: outcome.replayed,
      responseStatus: outcome.response.status,
      ticket: ticketFromStored(outcome.response),
    };
  }

  private async applyQueueChanges(outcome: CommandOutcome): Promise<void> {
    await Promise.all(
      (outcome.removeAfterCommit ?? []).map((ticket) =>
        this.queue.remove(ticket.ticketId, ticket.queueKey),
      ),
    );
    for (const ticket of outcome.queueAfterCommit ?? []) {
      await this.queue.enqueue(ticket);
      await this.tryFormProposal(ticket.queueKey);
    }
  }

  private async tryFormProposal(queueGroup: string): Promise<void> {
    const candidateIds = await this.queue.list(queueGroup, 64);
    if (candidateIds.length < this.ruleset.roster.contestantCount) {
      return;
    }
    const now = this.clock();
    const occurredAt = timestamp(now);
    const selected = await this.transactions.run<readonly TicketRow[]>(
      async (client) => {
        const candidates = await client.query<EligibleTicketRow>(
          `
            SELECT
              ticket.id,
              ticket.user_id,
              ticket.ruleset_id,
              ticket.ruleset_version,
              ticket.region,
              ticket.language,
              ticket.compatibility_version,
              ticket.restriction_pool,
              ticket.queue_key,
              ticket.status,
              ticket.proposal_id,
              ticket.ready_at,
              ticket.match_id,
              ticket.created_at,
              ticket.updated_at,
              NULL::timestamptz AS ready_deadline,
              users.status AS user_status,
              COALESCE(safety.matchmaking_allowed, true)
                AS matchmaking_allowed,
              COALESCE(safety.restriction_pool, 'standard')
                AS current_restriction_pool
            FROM matchmaking_tickets AS ticket
            JOIN users ON users.id = ticket.user_id
            LEFT JOIN matchmaking_safety AS safety
              ON safety.user_id = ticket.user_id
            WHERE ticket.id = ANY($1::uuid[])
            ORDER BY ticket.created_at, ticket.id
            FOR UPDATE OF ticket
          `,
          [candidateIds],
        );
        const eligible = candidates.rows.filter(
          (ticket) =>
            ticket.status === "queued" &&
            ticket.queue_key === queueGroup &&
            ticket.user_status === "active" &&
            ticket.matchmaking_allowed &&
            ticket.current_restriction_pool === ticket.restriction_pool,
        );
        if (eligible.length < this.ruleset.roster.contestantCount) {
          return [];
        }
        const userIds = eligible.map(({ user_id }) => user_id);
        const blocks = await client.query<{
          blocked_user_id: string;
          blocker_user_id: string;
        }>(
          `
            SELECT blocker_user_id, blocked_user_id
            FROM blocks
            WHERE
              blocker_user_id = ANY($1::uuid[])
              AND blocked_user_id = ANY($1::uuid[])
          `,
          [userIds],
        );
        const blockedPairs = new Set(
          blocks.rows.map(
            ({ blocked_user_id, blocker_user_id }) =>
              `${blocker_user_id}:${blocked_user_id}`,
          ),
        );
        const recentCutoff = addSeconds(
          now,
          -this.config.recentPairingWindowSeconds,
        );
        const recent = await client.query<{
          first_user_id: string;
          second_user_id: string;
        }>(
          `
            SELECT first_user_id, second_user_id
            FROM recent_pairings
            WHERE
              first_user_id = ANY($1::uuid[])
              AND second_user_id = ANY($1::uuid[])
              AND last_matched_at >= $2
          `,
          [userIds, recentCutoff],
        );
        const recentPairs = new Set(
          recent.rows.map(
            ({ first_user_id, second_user_id }) =>
              `${first_user_id}:${second_user_id}`,
          ),
        );
        const pair = (left: string, right: string): string =>
          left < right ? `${left}:${right}` : `${right}:${left}`;
        const compatible = (
          candidate: EligibleTicketRow,
          roster: readonly EligibleTicketRow[],
        ): boolean =>
          roster.every(
            (selectedTicket) =>
              !blockedPairs.has(
                `${candidate.user_id}:${selectedTicket.user_id}`,
              ) &&
              !blockedPairs.has(
                `${selectedTicket.user_id}:${candidate.user_id}`,
              ),
          );
        const roster: EligibleTicketRow[] = [];
        for (const candidate of eligible) {
          if (
            compatible(candidate, roster) &&
            roster.every(
              (selectedTicket) =>
                !recentPairs.has(
                  pair(candidate.user_id, selectedTicket.user_id),
                ),
            )
          ) {
            roster.push(candidate);
          }
          if (roster.length === this.ruleset.roster.contestantCount) {
            break;
          }
        }
        if (roster.length < this.ruleset.roster.contestantCount) {
          for (const candidate of eligible) {
            if (!roster.includes(candidate) && compatible(candidate, roster)) {
              roster.push(candidate);
            }
            if (roster.length === this.ruleset.roster.contestantCount) {
              break;
            }
          }
        }
        if (roster.length < this.ruleset.roster.contestantCount) {
          return [];
        }
        const proposalId = this.newId();
        const readyDeadline = addSeconds(now, this.config.readyTimeoutSeconds);
        await client.query(
          `
            INSERT INTO matchmaking_proposals (
              id,
              ruleset_id,
              ruleset_version,
              status,
              ready_deadline,
              created_at
            )
            VALUES ($1, $2, $3, 'pending', $4, $5)
          `,
          [
            proposalId,
            this.ruleset.rulesetId,
            this.ruleset.rulesetVersion,
            readyDeadline,
            occurredAt,
          ],
        );
        await client.query(
          `
            UPDATE matchmaking_tickets
            SET status = 'proposed', proposal_id = $2, updated_at = $3
            WHERE id = ANY($1::uuid[]) AND status = 'queued'
          `,
          [roster.map(({ id }) => id), proposalId, occurredAt],
        );
        await client.query(
          `
            INSERT INTO scheduled_jobs (
              id,
              kind,
              deduplication_key,
              payload,
              run_at,
              created_at,
              updated_at
            )
            VALUES (
              $1,
              $2,
              $3,
              jsonb_build_object('proposalId', $4::text),
              $5,
              $6,
              $6
            )
          `,
          [
            this.newId(),
            MATCHMAKING_READY_TIMEOUT_JOB_KIND,
            `matchmaking-ready-timeout:${proposalId}`,
            proposalId,
            readyDeadline,
            occurredAt,
          ],
        );
        return roster;
      },
    );
    await Promise.all(
      selected.map((ticket) => this.queue.remove(ticket.id, ticket.queue_key)),
    );
  }

  private async releaseProposal(
    client: PoolClient,
    proposalId: string,
    occurredAt: UtcTimestamp,
    cancelledTicketId?: string,
  ): Promise<readonly QueueTicket[]> {
    await client.query(
      `
        UPDATE matchmaking_proposals
        SET status = 'expired', resolved_at = $2
        WHERE id = $1 AND status = 'pending'
      `,
      [proposalId, occurredAt],
    );
    const released = await client.query<TicketRow>(
      `
        UPDATE matchmaking_tickets
        SET
          status = CASE WHEN id = $2 THEN 'cancelled' ELSE 'queued' END,
          proposal_id = NULL,
          ready_at = NULL,
          match_id = NULL,
          cancelled_at = CASE WHEN id = $2 THEN $3 ELSE NULL END,
          updated_at = $3
        WHERE proposal_id = $1 AND status = 'proposed'
        RETURNING
          id,
          user_id,
          ruleset_id,
          ruleset_version,
          region,
          language,
          compatibility_version,
          restriction_pool,
          queue_key,
          status,
          proposal_id,
          ready_at,
          match_id,
          created_at,
          updated_at,
          NULL::timestamptz AS ready_deadline
      `,
      [proposalId, cancelledTicketId ?? null, occurredAt],
    );
    await client.query(
      `
        UPDATE scheduled_jobs
        SET
          status = 'cancelled',
          claim_token = NULL,
          claimed_by = NULL,
          claim_until = NULL,
          updated_at = $2
        WHERE
          kind = $1
          AND payload ->> 'proposalId' = $3
          AND status = 'pending'
      `,
      [MATCHMAKING_READY_TIMEOUT_JOB_KIND, occurredAt, proposalId],
    );
    return released.rows
      .filter(({ status }) => status === "queued")
      .map(toQueueTicket);
  }

  private async createDurableMatch(
    client: PoolClient,
    proposalId: string,
    occurredAt: UtcTimestamp,
  ): Promise<void> {
    const tickets = await client.query<TicketRow>(
      `
        ${TICKET_SELECT}
        WHERE ticket.proposal_id = $1 AND ticket.status = 'proposed'
        ORDER BY ticket.created_at, ticket.id
        FOR UPDATE OF ticket
      `,
      [proposalId],
    );
    if (
      tickets.rows.length !== this.ruleset.roster.contestantCount ||
      tickets.rows.some(({ ready_at }) => ready_at === null)
    ) {
      throw new Error(
        "A match cannot be created before the full roster is ready",
      );
    }
    const matchId = this.newId();
    const parsedMatchId = parseEntityId("match", matchId);
    if (!parsedMatchId.ok) {
      throw new TypeError(
        "The match identifier generator returned an invalid UUID",
      );
    }
    const lobbyDeadline = timestamp(
      addSeconds(
        new Date(Date.parse(occurredAt)),
        this.config.lobbyReadyTimeoutSeconds,
      ),
    );
    const state = createMatchState({
      matchId: parsedMatchId.value as MatchId,
      ruleset: this.ruleset,
      playerIds: tickets.rows.map(({ user_id }) => user_id as UserId),
      lobbyDeadline,
    });
    if (!state.ok) {
      throw new Error(`Match construction failed: ${state.error.code}`);
    }
    await this.matches.create(client, state.value, occurredAt);
    await this.scheduledJobs.synchronizeMatchDeadline(
      client,
      state.value,
      occurredAt,
    );
    const createdEvent = {
      type: "match.created",
      phase: "lobby",
      deadline: lobbyDeadline,
    };
    const projected: ProjectedMatchEvent[] = [
      {
        audience: "participants",
        event: createdEvent,
        eventType: createdEvent.type,
        matchVersion: state.value.version,
      },
    ];
    const delivery = await this.realtimeEvents.appendProjectedEvents(
      client,
      state.value,
      projected,
      occurredAt,
    );
    await this.matches.appendEvents(client, delivery.matchEvents);
    await this.outbox.enqueue(client, delivery.outboxEvents);
    await client.query(
      `
        UPDATE matchmaking_proposals
        SET status = 'matched', match_id = $2, resolved_at = $3
        WHERE id = $1 AND status = 'pending'
      `,
      [proposalId, matchId, occurredAt],
    );
    await client.query(
      `
        UPDATE matchmaking_tickets
        SET status = 'matched', match_id = $2, updated_at = $3
        WHERE proposal_id = $1 AND status = 'proposed'
      `,
      [proposalId, matchId, occurredAt],
    );
    const userIds = tickets.rows
      .map(({ user_id }) => user_id)
      .sort((left, right) => left.localeCompare(right));
    for (let left = 0; left < userIds.length; left += 1) {
      for (let right = left + 1; right < userIds.length; right += 1) {
        await client.query(
          `
            INSERT INTO recent_pairings (
              first_user_id,
              second_user_id,
              last_matched_at
            )
            VALUES ($1, $2, $3)
            ON CONFLICT (first_user_id, second_user_id) DO UPDATE
            SET
              last_matched_at = EXCLUDED.last_matched_at,
              match_count = recent_pairings.match_count + 1
          `,
          [userIds[left], userIds[right], occurredAt],
        );
      }
    }
    await client.query(
      `
        UPDATE scheduled_jobs
        SET
          status = 'cancelled',
          claim_token = NULL,
          claimed_by = NULL,
          claim_until = NULL,
          updated_at = $2
        WHERE
          kind = $1
          AND payload ->> 'proposalId' = $3
          AND status = 'pending'
      `,
      [MATCHMAKING_READY_TIMEOUT_JOB_KIND, occurredAt, proposalId],
    );
  }
}

export class MatchmakingReadyTimeoutHandler {
  public async handle(
    client: PoolClient,
    proposalId: string,
    occurredAt: UtcTimestamp,
  ): Promise<void> {
    const proposal = await client.query<{ status: string }>(
      `
        SELECT status
        FROM matchmaking_proposals
        WHERE id = $1
        FOR UPDATE
      `,
      [proposalId],
    );
    if (proposal.rows[0]?.status !== "pending") {
      return;
    }
    await client.query(
      `
        UPDATE matchmaking_proposals
        SET status = 'expired', resolved_at = $2
        WHERE id = $1 AND status = 'pending'
      `,
      [proposalId, occurredAt],
    );
    await client.query(
      `
        UPDATE matchmaking_tickets
        SET
          status = 'queued',
          proposal_id = NULL,
          ready_at = NULL,
          updated_at = $2
        WHERE proposal_id = $1 AND status = 'proposed'
      `,
      [proposalId, occurredAt],
    );
  }
}
