import { randomUUID } from "node:crypto";

import {
  parseEntityId,
  utcTimestampFromDate,
  type UserId,
  type UtcTimestamp,
} from "@project-booth/domain";
import type { PoolClient } from "pg";

import type { ChatConfig } from "../config.js";
import {
  hashIdempotencyRequest,
  type IdempotencyIdentity,
  PostgresIdempotencyRepository,
  type StoredHttpResponse,
} from "../persistence/idempotency.js";
import { toJsonObject, type JsonValue } from "../persistence/json.js";
import { PostgresOutboxRepository } from "../persistence/outbox.js";
import type { PostgresTransactionRunner } from "../persistence/transaction.js";
import { PostgresRealtimeEventRepository } from "../realtime/events.js";
import {
  CHAT_NORMALIZATION_VERSION,
  CHAT_POLICY_VERSION,
  filterTypedMessage,
  type DeterministicFilterResult,
} from "./filter.js";
import {
  classifyWithTimeout,
  decideModerationPolicy,
  type ModerationCategory,
  type ModerationClassification,
  type ModerationProvider,
  ModerationProviderFailure,
} from "./moderation.js";

export const QUICK_PHRASES = {
  deal: "Deal.",
  good_luck: "Good luck.",
  hello: "Hello.",
  no_deal: "No deal.",
  talk: "Can we talk?",
  trust: "You can trust me.",
  vote_together: "Let's vote together.",
} as const;

export type QuickPhraseKey = keyof typeof QUICK_PHRASES;
export type PublicDeliveryStatus =
  | "blocked"
  | "delivered"
  | "provider_unavailable"
  | "rate_limited"
  | "recipient_unavailable";
type StoredDeliveryStatus = PublicDeliveryStatus | "urgent_review";
type ProviderOutcome =
  "allow" | "block" | "failure" | "not_called" | "timeout" | "urgent_review";

export type SendMessageInput =
  | { readonly kind: "quick_phrase"; readonly quickPhraseKey: string }
  | { readonly kind: "typed"; readonly text: string };

export interface ChatMessageAttemptView {
  readonly body: string;
  readonly deliveryStatus: PublicDeliveryStatus;
  readonly kind: "quick_phrase" | "typed";
  readonly messageId: string;
  readonly quickPhraseKey?: QuickPhraseKey;
  readonly recipientUserId: string;
  readonly senderUserId: string;
  readonly sentAt: string;
  readonly threadId: string;
}

export interface ChatMessageView {
  readonly body: string;
  readonly kind: "quick_phrase" | "typed";
  readonly messageId: string;
  readonly quickPhraseKey?: QuickPhraseKey;
  readonly recipientUserId: string;
  readonly senderUserId: string;
  readonly sentAt: string;
  readonly threadId: string;
}

export interface ChatThreadView {
  readonly blocked: boolean;
  readonly createdAt: string;
  readonly matchId: string;
  readonly muted: boolean;
  readonly otherUser: {
    readonly avatarKey: string;
    readonly displayName: string;
    readonly userId: string;
  };
  readonly threadId: string;
}

export interface ChatCommandResult<View> {
  readonly replayed: boolean;
  readonly responseStatus: number;
  readonly value: View;
}

export interface SafetyCommandView {
  readonly active: boolean;
  readonly matchId: string;
  readonly subjectUserId: string;
}

export interface ReportView {
  readonly category: ReportCategory;
  readonly kind: "message" | "user";
  readonly matchId: string;
  readonly reportId: string;
  readonly status: "queued";
  readonly subjectUserId: string;
}

export type ReportCategory =
  "harassment" | "hate" | "other" | "self_harm" | "sexual" | "spam" | "threat";

export interface ChatApplication {
  blockUser(
    userId: string,
    matchId: string,
    subjectUserId: string,
    idempotencyKey: string,
  ): Promise<ChatCommandResult<SafetyCommandView>>;
  listMessages(
    userId: string,
    matchId: string,
    threadId: string,
    afterMessageId?: string,
    limit?: number,
  ): Promise<{
    readonly hasMore: boolean;
    readonly messages: readonly ChatMessageView[];
  }>;
  listQuickPhrases(): readonly {
    readonly key: QuickPhraseKey;
    readonly text: string;
  }[];
  listThreads(
    userId: string,
    matchId: string,
  ): Promise<readonly ChatThreadView[]>;
  muteUser(
    userId: string,
    matchId: string,
    subjectUserId: string,
    idempotencyKey: string,
  ): Promise<ChatCommandResult<SafetyCommandView>>;
  reportMessage(
    userId: string,
    matchId: string,
    messageId: string,
    category: ReportCategory,
    idempotencyKey: string,
  ): Promise<ChatCommandResult<ReportView>>;
  reportUser(
    userId: string,
    matchId: string,
    subjectUserId: string,
    category: ReportCategory,
    idempotencyKey: string,
  ): Promise<ChatCommandResult<ReportView>>;
  sendMessage(
    userId: string,
    matchId: string,
    threadId: string,
    idempotencyKey: string,
    input: SendMessageInput,
  ): Promise<ChatCommandResult<ChatMessageAttemptView>>;
}

export type ChatErrorCode =
  | "chat_closed"
  | "chat_forbidden"
  | "chat_not_found"
  | "invalid_message"
  | "invalid_quick_phrase"
  | "invalid_report";

export class ChatError extends Error {
  public constructor(
    public readonly code: ChatErrorCode,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "ChatError";
  }
}

interface ThreadAccessRow {
  readonly first_status: "active" | "eliminated";
  readonly first_user_id: string;
  readonly match_version: string;
  readonly phase: string;
  readonly second_status: "active" | "eliminated";
  readonly second_user_id: string;
  readonly sender_chat_allowed: boolean;
  readonly thread_id: string;
}

interface PreparedMessage {
  readonly body: string;
  readonly deterministic: DeterministicFilterResult;
  readonly kind: "quick_phrase" | "typed";
  readonly providerCategories: Readonly<
    Partial<Record<ModerationCategory, number>>
  >;
  readonly providerOutcome: ProviderOutcome;
  readonly providerReasonCodes: readonly ModerationCategory[];
  readonly quickPhraseKey?: QuickPhraseKey;
}

interface SpamDecision {
  readonly blocked: boolean;
  readonly reasonCodes: readonly string[];
}

interface MessageRow {
  readonly body: string;
  readonly created_at: Date;
  readonly delivery_status: StoredDeliveryStatus;
  readonly id: string;
  readonly kind: "quick_phrase" | "typed";
  readonly quick_phrase_key: QuickPhraseKey | null;
  readonly recipient_user_id: string;
  readonly sender_user_id: string;
  readonly thread_id: string;
}

const CHAT_SEND_PHASES = new Set([
  "final_plea",
  "lobby",
  "negotiation",
  "runoff_negotiation",
]);
const URGENT_REPORT_CATEGORIES = new Set<ReportCategory>([
  "self_harm",
  "sexual",
  "threat",
]);

function timestamp(date: Date): UtcTimestamp {
  const parsed = utcTimestampFromDate(date);
  if (!parsed.ok) {
    throw new RangeError("Chat clock returned an invalid timestamp");
  }
  return parsed.value;
}

function asUserId(value: string): UserId {
  const parsed = parseEntityId("user", value);
  if (!parsed.ok) {
    throw new ChatError("chat_not_found", "The chat was not found", 404);
  }
  return parsed.value as UserId;
}

function assertUuid(entity: string, value: string): void {
  const parsed = parseEntityId(entity, value);
  if (!parsed.ok) {
    throw new ChatError("chat_not_found", "The chat was not found", 404);
  }
}

function publicStatus(status: StoredDeliveryStatus): PublicDeliveryStatus {
  return status === "urgent_review" ? "blocked" : status;
}

function toAttempt(row: MessageRow): ChatMessageAttemptView {
  return {
    body: row.body,
    deliveryStatus: publicStatus(row.delivery_status),
    kind: row.kind,
    messageId: row.id,
    ...(row.quick_phrase_key === null
      ? {}
      : { quickPhraseKey: row.quick_phrase_key }),
    recipientUserId: row.recipient_user_id,
    senderUserId: row.sender_user_id,
    sentAt: row.created_at.toISOString(),
    threadId: row.thread_id,
  };
}

function toMessage(row: MessageRow): ChatMessageView {
  const attempt = toAttempt(row);
  const { deliveryStatus: _deliveryStatus, ...message } = attempt;
  return message;
}

function commandIdentity(
  userId: UserId,
  operation: string,
  idempotencyKey: string,
  request: JsonValue,
): IdempotencyIdentity {
  return {
    accountId: userId,
    operation,
    key: idempotencyKey,
    requestHash: hashIdempotencyRequest(request),
  };
}

function commandResult<View>(
  response: StoredHttpResponse,
  replayed: boolean,
): ChatCommandResult<View> {
  return {
    replayed,
    responseStatus: response.status,
    value: response.body as unknown as View,
  };
}

async function loadThreadAccess(
  client: PoolClient,
  userId: string,
  matchId: string,
  threadId: string,
  options: { readonly forUpdate?: boolean; readonly sending?: boolean } = {},
): Promise<ThreadAccessRow> {
  const result = await client.query<ThreadAccessRow>(
    `
      SELECT
        thread.id AS thread_id,
        thread.first_user_id,
        thread.second_user_id,
        first_player.status AS first_status,
        second_player.status AS second_status,
        current_match.phase,
        current_match.version AS match_version,
        COALESCE(safety.chat_allowed, true) AS sender_chat_allowed
      FROM chat_threads AS thread
      JOIN matches AS current_match ON current_match.id = thread.match_id
      JOIN match_players AS first_player
        ON first_player.match_id = thread.match_id
        AND first_player.player_id = thread.first_user_id
      JOIN match_players AS second_player
        ON second_player.match_id = thread.match_id
        AND second_player.player_id = thread.second_user_id
      LEFT JOIN matchmaking_safety AS safety ON safety.user_id = $3
      WHERE thread.id = $1 AND thread.match_id = $2
      ${options.forUpdate ? "FOR UPDATE OF thread, current_match, first_player, second_player" : ""}
    `,
    [threadId, matchId, userId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ChatError("chat_not_found", "The chat was not found", 404);
  }
  if (row.first_user_id !== userId && row.second_user_id !== userId) {
    throw new ChatError(
      "chat_forbidden",
      "The account cannot access this private chat",
      403,
    );
  }
  const senderStatus =
    row.first_user_id === userId ? row.first_status : row.second_status;
  const recipientStatus =
    row.first_user_id === userId ? row.second_status : row.first_status;
  if (senderStatus !== "active" || recipientStatus !== "active") {
    throw new ChatError(
      "chat_closed",
      "Private chat is unavailable for inactive contestants",
      409,
    );
  }
  if (options.sending && !CHAT_SEND_PHASES.has(row.phase)) {
    throw new ChatError(
      "chat_closed",
      "Private chat is locked during the current match phase",
      409,
    );
  }
  if (options.sending && !row.sender_chat_allowed) {
    throw new ChatError(
      "chat_forbidden",
      "Free communication is unavailable for this account",
      403,
    );
  }
  return row;
}

function recipientFor(row: ThreadAccessRow, userId: string): string {
  return row.first_user_id === userId ? row.second_user_id : row.first_user_id;
}

function quickPhraseKey(value: string): QuickPhraseKey {
  if (!(value in QUICK_PHRASES)) {
    throw new ChatError(
      "invalid_quick_phrase",
      "The quick phrase is not supported",
      400,
    );
  }
  return value as QuickPhraseKey;
}

function syntheticAllowedFilter(body: string): DeterministicFilterResult {
  return {
    action: "allow",
    characterCount: Array.from(body).length,
    normalizedText: body,
    reasons: [],
    scanText: body.toLocaleLowerCase("en-US"),
  };
}

export class PostgresChatService implements ChatApplication {
  public constructor(
    private readonly transactions: PostgresTransactionRunner,
    private readonly provider: ModerationProvider,
    private readonly config: ChatConfig,
    private readonly clock: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
    private readonly idempotency = new PostgresIdempotencyRepository(),
    private readonly outbox = new PostgresOutboxRepository(),
    private readonly realtime = new PostgresRealtimeEventRepository(),
  ) {}

  public listQuickPhrases(): readonly {
    readonly key: QuickPhraseKey;
    readonly text: string;
  }[] {
    return Object.entries(QUICK_PHRASES).map(([key, text]) => ({
      key: key as QuickPhraseKey,
      text,
    }));
  }

  public listThreads(
    userId: string,
    matchId: string,
  ): Promise<readonly ChatThreadView[]> {
    asUserId(userId);
    assertUuid("match", matchId);
    return this.transactions.run(async (client) => {
      const membership = await client.query<{ status: string }>(
        `
          SELECT status
          FROM match_players
          WHERE match_id = $1 AND player_id = $2
        `,
        [matchId, userId],
      );
      if (membership.rows[0]?.status !== "active") {
        throw new ChatError(
          "chat_forbidden",
          "The account cannot access private chats for this match",
          403,
        );
      }
      const result = await client.query<{
        avatar_key: string | null;
        blocked: boolean;
        created_at: Date;
        display_name: string | null;
        match_id: string;
        muted: boolean;
        other_user_id: string;
        thread_id: string;
      }>(
        `
          SELECT
            thread.id AS thread_id,
            thread.match_id,
            thread.created_at,
            other.player_id AS other_user_id,
            profile.display_name,
            profile.avatar_key,
            EXISTS (
              SELECT 1
              FROM mutes
              WHERE
                mutes.match_id = thread.match_id
                AND mutes.muter_user_id = $2
                AND mutes.muted_user_id = other.player_id
            ) AS muted,
            EXISTS (
              SELECT 1
              FROM blocks
              WHERE
                (blocks.blocker_user_id = $2
                  AND blocks.blocked_user_id = other.player_id)
                OR
                (blocks.blocker_user_id = other.player_id
                  AND blocks.blocked_user_id = $2)
            ) AS blocked
          FROM chat_threads AS thread
          JOIN match_players AS self
            ON self.match_id = thread.match_id
            AND self.player_id = $2
            AND self.status = 'active'
          JOIN match_players AS other
            ON other.match_id = thread.match_id
            AND other.status = 'active'
            AND other.player_id = CASE
              WHEN thread.first_user_id = $2 THEN thread.second_user_id
              ELSE thread.first_user_id
            END
          LEFT JOIN profiles AS profile ON profile.user_id = other.player_id
          WHERE
            thread.match_id = $1
            AND $2 IN (thread.first_user_id, thread.second_user_id)
          ORDER BY other.roster_position
        `,
        [matchId, userId],
      );
      return result.rows.map((row) => ({
        blocked: row.blocked,
        createdAt: row.created_at.toISOString(),
        matchId: row.match_id,
        muted: row.muted,
        otherUser: {
          avatarKey: row.avatar_key ?? "avatar.deleted",
          displayName: row.display_name ?? "Deleted Player",
          userId: row.other_user_id,
        },
        threadId: row.thread_id,
      }));
    });
  }

  public listMessages(
    userId: string,
    matchId: string,
    threadId: string,
    afterMessageId?: string,
    limit = 50,
  ): Promise<{
    readonly hasMore: boolean;
    readonly messages: readonly ChatMessageView[];
  }> {
    asUserId(userId);
    assertUuid("match", matchId);
    assertUuid("chat_thread", threadId);
    if (afterMessageId !== undefined) {
      assertUuid("message", afterMessageId);
    }
    const boundedLimit = Math.max(1, Math.min(100, limit));
    return this.transactions.run(async (client) => {
      await loadThreadAccess(client, userId, matchId, threadId);
      const result = await client.query<MessageRow>(
        `
          SELECT
            message.id,
            message.thread_id,
            message.sender_user_id,
            message.recipient_user_id,
            message.kind,
            message.quick_phrase_key,
            message.normalized_body AS body,
            message.delivery_status,
            message.created_at
          FROM messages AS message
          WHERE
            message.thread_id = $1
            AND message.delivery_status = 'delivered'
            AND (
              $2::uuid IS NULL
              OR (message.created_at, message.id) > (
                SELECT cursor.created_at, cursor.id
                FROM messages AS cursor
                WHERE cursor.id = $2 AND cursor.thread_id = $1
              )
            )
          ORDER BY message.created_at, message.id
          LIMIT $3
        `,
        [threadId, afterMessageId ?? null, boundedLimit + 1],
      );
      return {
        hasMore: result.rows.length > boundedLimit,
        messages: result.rows.slice(0, boundedLimit).map(toMessage),
      };
    });
  }

  public async sendMessage(
    userIdValue: string,
    matchId: string,
    threadId: string,
    idempotencyKey: string,
    input: SendMessageInput,
  ): Promise<ChatCommandResult<ChatMessageAttemptView>> {
    const userId = asUserId(userIdValue);
    assertUuid("match", matchId);
    assertUuid("chat_thread", threadId);
    const occurredAt = timestamp(this.clock());
    const identity = commandIdentity(
      userId,
      "chat.message.send",
      idempotencyKey,
      toJsonObject({ input, matchId, threadId }),
    );
    const replay = await this.transactions.run((client) =>
      this.idempotency.findCompleted(client, identity),
    );
    if (replay !== undefined) {
      return commandResult<ChatMessageAttemptView>(replay, true);
    }

    await this.transactions.run((client) =>
      loadThreadAccess(client, userId, matchId, threadId, { sending: true }),
    );
    const prepared = await this.prepareMessage(input);

    return this.transactions.run(async (client) => {
      const acquisition = await this.idempotency.acquire(
        client,
        identity,
        occurredAt,
      );
      if (!acquisition.acquired) {
        return commandResult<ChatMessageAttemptView>(
          acquisition.response,
          true,
        );
      }
      const access = await loadThreadAccess(client, userId, matchId, threadId, {
        forUpdate: true,
        sending: true,
      });
      const recipientUserId = recipientFor(access, userId);
      const relationshipUnavailable = await this.relationshipUnavailable(
        client,
        userId,
        recipientUserId,
        matchId,
      );
      const spam =
        prepared.deterministic.action === "allow" &&
        (prepared.providerOutcome === "allow" ||
          prepared.kind === "quick_phrase")
          ? await this.spamDecision(
              client,
              userId,
              recipientUserId,
              threadId,
              prepared,
              occurredAt,
            )
          : { blocked: false, reasonCodes: [] };
      const deliveryStatus = this.deliveryStatus(
        prepared,
        relationshipUnavailable,
        spam,
      );
      const messageId = this.newId();
      const inserted = await client.query<MessageRow>(
        `
          INSERT INTO messages (
            id,
            thread_id,
            match_id,
            sender_user_id,
            recipient_user_id,
            kind,
            quick_phrase_key,
            body,
            normalized_body,
            delivery_status,
            policy_version,
            created_at,
            delivered_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
            CASE WHEN $10 = 'delivered' THEN $12::timestamptz ELSE NULL END
          )
          RETURNING
            id,
            thread_id,
            sender_user_id,
            recipient_user_id,
            kind,
            quick_phrase_key,
            normalized_body AS body,
            delivery_status,
            created_at
        `,
        [
          messageId,
          threadId,
          matchId,
          userId,
          recipientUserId,
          prepared.kind,
          prepared.quickPhraseKey ?? null,
          prepared.body,
          prepared.deterministic.normalizedText,
          deliveryStatus,
          CHAT_POLICY_VERSION,
          occurredAt,
        ],
      );
      const message = inserted.rows[0];
      if (message === undefined) {
        throw new Error("Chat message was not persisted");
      }
      const deterministicReasons = [
        ...prepared.deterministic.reasons,
        ...spam.reasonCodes,
      ];
      await client.query(
        `
          INSERT INTO message_filter_results (
            message_id,
            normalization_version,
            deterministic_action,
            deterministic_reasons,
            provider_name,
            provider_outcome,
            provider_categories,
            policy_version,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
        `,
        [
          messageId,
          CHAT_NORMALIZATION_VERSION,
          deterministicReasons.length > 0 ? "block" : "allow",
          deterministicReasons,
          this.provider.name,
          prepared.providerOutcome,
          JSON.stringify(prepared.providerCategories),
          CHAT_POLICY_VERSION,
          occurredAt,
        ],
      );
      if (deliveryStatus === "urgent_review") {
        await client.query(
          `
            INSERT INTO moderation_reviews (
              id,
              message_id,
              priority,
              reason_codes,
              status,
              created_at
            )
            VALUES ($1, $2, 'urgent', $3, 'queued', $4)
          `,
          [
            this.newId(),
            messageId,
            [
              ...prepared.deterministic.reasons,
              ...prepared.providerReasonCodes,
            ],
            occurredAt,
          ],
        );
      }
      if (deliveryStatus === "delivered") {
        const sharedPayload = {
          body: prepared.deterministic.normalizedText,
          kind: prepared.kind,
          messageId,
          ...(prepared.quickPhraseKey === undefined
            ? {}
            : { quickPhraseKey: prepared.quickPhraseKey }),
          recipientUserId,
          senderUserId: userId,
          sentAt: occurredAt,
          threadId,
        };
        const [senderEvent, recipientEvent] = await Promise.all([
          this.realtime.appendPrivateEvent(client, {
            event: {
              deliveryStatus: "delivered",
              ...sharedPayload,
            },
            eventType: "chat.message_acknowledged",
            matchId,
            matchVersion: Number(access.match_version),
            occurredAt,
            recipientUserId: userId,
          }),
          this.realtime.appendPrivateEvent(client, {
            event: sharedPayload,
            eventType: "chat.message_delivered",
            matchId,
            matchVersion: Number(access.match_version),
            occurredAt,
            recipientUserId: asUserId(recipientUserId),
          }),
        ]);
        await this.outbox.enqueue(client, [senderEvent, recipientEvent]);
      }
      const response: StoredHttpResponse = {
        status: this.responseStatus(deliveryStatus),
        headers: { "content-type": "application/json" },
        body: toJsonObject(toAttempt(message)),
      };
      await this.idempotency.complete(client, identity, response, occurredAt);
      return commandResult<ChatMessageAttemptView>(response, false);
    });
  }

  public muteUser(
    userIdValue: string,
    matchId: string,
    subjectUserId: string,
    idempotencyKey: string,
  ): Promise<ChatCommandResult<SafetyCommandView>> {
    return this.relationshipCommand(
      userIdValue,
      matchId,
      subjectUserId,
      idempotencyKey,
      "chat.user.mute",
      true,
      async (client, userId, subject, occurredAt) => {
        await client.query(
          `
            INSERT INTO mutes (
              match_id,
              muter_user_id,
              muted_user_id,
              created_at
            )
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (match_id, muter_user_id, muted_user_id) DO NOTHING
          `,
          [matchId, userId, subject, occurredAt],
        );
      },
    );
  }

  public blockUser(
    userIdValue: string,
    matchId: string,
    subjectUserId: string,
    idempotencyKey: string,
  ): Promise<ChatCommandResult<SafetyCommandView>> {
    return this.relationshipCommand(
      userIdValue,
      matchId,
      subjectUserId,
      idempotencyKey,
      "chat.user.block",
      false,
      async (client, userId, subject, occurredAt) => {
        await client.query(
          `
            INSERT INTO blocks (
              blocker_user_id,
              blocked_user_id,
              created_at
            )
            VALUES ($1, $2, $3)
            ON CONFLICT (blocker_user_id, blocked_user_id) DO NOTHING
          `,
          [userId, subject, occurredAt],
        );
      },
    );
  }

  public reportMessage(
    userIdValue: string,
    matchId: string,
    messageId: string,
    category: ReportCategory,
    idempotencyKey: string,
  ): Promise<ChatCommandResult<ReportView>> {
    const userId = asUserId(userIdValue);
    assertUuid("match", matchId);
    assertUuid("message", messageId);
    this.assertReportCategory(category);
    const occurredAt = timestamp(this.clock());
    const identity = commandIdentity(
      userId,
      "chat.message.report",
      idempotencyKey,
      { category, matchId, messageId },
    );
    return this.transactions.run(async (client) => {
      const acquisition = await this.idempotency.acquire(
        client,
        identity,
        occurredAt,
      );
      if (!acquisition.acquired) {
        return commandResult<ReportView>(acquisition.response, true);
      }
      const reported = await client.query<{
        body: string;
        created_at: Date;
        id: string;
        sender_user_id: string;
        thread_id: string;
      }>(
        `
          SELECT
            message.id,
            message.thread_id,
            message.sender_user_id,
            message.normalized_body AS body,
            message.created_at
          FROM messages AS message
          JOIN chat_threads AS thread ON thread.id = message.thread_id
          JOIN match_players AS reporter
            ON reporter.match_id = message.match_id
            AND reporter.player_id = $2
          WHERE
            message.id = $1
            AND message.match_id = $3
            AND message.recipient_user_id = $2
            AND message.delivery_status = 'delivered'
        `,
        [messageId, userId, matchId],
      );
      const message = reported.rows[0];
      if (message === undefined || message.sender_user_id === userId) {
        throw new ChatError(
          "invalid_report",
          "The message cannot be reported by this account",
          403,
        );
      }
      const context = await client.query<{
        body: string;
        created_at: Date;
        id: string;
        sender_user_id: string;
      }>(
        `
          SELECT id, sender_user_id, normalized_body AS body, created_at
          FROM messages
          WHERE
            thread_id = $1
            AND delivery_status = 'delivered'
            AND created_at BETWEEN $2::timestamptz - interval '2 minutes'
              AND $2::timestamptz + interval '2 minutes'
          ORDER BY created_at, id
          LIMIT 5
        `,
        [message.thread_id, message.created_at],
      );
      return this.createReport(client, identity, occurredAt, {
        category,
        evidence: {
          context: context.rows.map((entry) => ({
            body: entry.body,
            createdAt: entry.created_at.toISOString(),
            messageId: entry.id,
            senderUserId: entry.sender_user_id,
          })),
          reportedMessageId: messageId,
        },
        kind: "message",
        matchId,
        messageId,
        reporterUserId: userId,
        subjectUserId: message.sender_user_id,
      });
    });
  }

  public reportUser(
    userIdValue: string,
    matchId: string,
    subjectUserIdValue: string,
    category: ReportCategory,
    idempotencyKey: string,
  ): Promise<ChatCommandResult<ReportView>> {
    const userId = asUserId(userIdValue);
    const subjectUserId = asUserId(subjectUserIdValue);
    assertUuid("match", matchId);
    this.assertReportCategory(category);
    if (userId === subjectUserId) {
      throw new ChatError(
        "invalid_report",
        "An account cannot report itself",
        400,
      );
    }
    const occurredAt = timestamp(this.clock());
    const identity = commandIdentity(
      userId,
      "chat.user.report",
      idempotencyKey,
      { category, matchId, subjectUserId },
    );
    return this.transactions.run(async (client) => {
      const acquisition = await this.idempotency.acquire(
        client,
        identity,
        occurredAt,
      );
      if (!acquisition.acquired) {
        return commandResult<ReportView>(acquisition.response, true);
      }
      await this.assertMatchRelationship(
        client,
        matchId,
        userId,
        subjectUserId,
        false,
      );
      const recent = await client.query<{
        body: string;
        created_at: Date;
        id: string;
        sender_user_id: string;
      }>(
        `
          SELECT
            message.id,
            message.sender_user_id,
            message.normalized_body AS body,
            message.created_at
          FROM messages AS message
          JOIN chat_threads AS thread ON thread.id = message.thread_id
          WHERE
            thread.match_id = $1
            AND $2 IN (thread.first_user_id, thread.second_user_id)
            AND $3 IN (thread.first_user_id, thread.second_user_id)
            AND message.delivery_status = 'delivered'
          ORDER BY message.created_at DESC, message.id DESC
          LIMIT 5
        `,
        [matchId, userId, subjectUserId],
      );
      return this.createReport(client, identity, occurredAt, {
        category,
        evidence: {
          recentMessages: recent.rows.reverse().map((entry) => ({
            body: entry.body,
            createdAt: entry.created_at.toISOString(),
            messageId: entry.id,
            senderUserId: entry.sender_user_id,
          })),
        },
        kind: "user",
        matchId,
        reporterUserId: userId,
        subjectUserId,
      });
    });
  }

  private async prepareMessage(
    input: SendMessageInput,
  ): Promise<PreparedMessage> {
    if (input.kind === "quick_phrase") {
      const key = quickPhraseKey(input.quickPhraseKey);
      const body = QUICK_PHRASES[key];
      return {
        body,
        deterministic: syntheticAllowedFilter(body),
        kind: "quick_phrase",
        providerCategories: {},
        providerOutcome: "not_called",
        providerReasonCodes: [],
        quickPhraseKey: key,
      };
    }
    if (Array.from(input.text).length > 2_048) {
      throw new ChatError(
        "invalid_message",
        "A typed message exceeds the safe request limit",
        400,
      );
    }
    const deterministic = filterTypedMessage(
      input.text,
      this.config.maximumTypedMessageCharacters,
    );
    if (deterministic.reasons.includes("empty")) {
      throw new ChatError(
        "invalid_message",
        "A typed message must contain visible text",
        400,
      );
    }
    if (deterministic.action === "block") {
      return {
        body: input.text,
        deterministic,
        kind: "typed",
        providerCategories: {},
        providerOutcome: "not_called",
        providerReasonCodes: [],
      };
    }
    try {
      const classification = await classifyWithTimeout(
        this.provider,
        deterministic.normalizedText,
        this.config.moderationTimeoutMilliseconds,
      );
      const decision = decideModerationPolicy(classification);
      return this.preparedFromClassification(
        input.text,
        deterministic,
        classification,
        decision.action,
        decision.reasonCodes,
      );
    } catch (error: unknown) {
      if (!(error instanceof ModerationProviderFailure)) {
        throw error;
      }
      return {
        body: input.text,
        deterministic,
        kind: "typed",
        providerCategories: {},
        providerOutcome: error.kind,
        providerReasonCodes: [],
      };
    }
  }

  private preparedFromClassification(
    body: string,
    deterministic: DeterministicFilterResult,
    classification: ModerationClassification,
    outcome: "allow" | "block" | "urgent_review",
    reasonCodes: readonly ModerationCategory[],
  ): PreparedMessage {
    return {
      body,
      deterministic,
      kind: "typed",
      providerCategories: classification.categories,
      providerOutcome: outcome,
      providerReasonCodes: reasonCodes,
    };
  }

  private deliveryStatus(
    prepared: PreparedMessage,
    relationshipUnavailable: boolean,
    spam: SpamDecision,
  ): StoredDeliveryStatus {
    if (
      prepared.deterministic.reasons.some((reason) =>
        [
          "prohibited_self_harm",
          "prohibited_sexual",
          "prohibited_threat",
        ].includes(reason),
      ) ||
      prepared.providerOutcome === "urgent_review"
    ) {
      return "urgent_review";
    }
    if (prepared.deterministic.action === "block") {
      return "blocked";
    }
    if (
      prepared.providerOutcome === "failure" ||
      prepared.providerOutcome === "timeout"
    ) {
      return "provider_unavailable";
    }
    if (prepared.providerOutcome === "block") {
      return "blocked";
    }
    if (relationshipUnavailable) {
      return "recipient_unavailable";
    }
    if (spam.blocked) {
      return "rate_limited";
    }
    return "delivered";
  }

  private responseStatus(status: StoredDeliveryStatus): number {
    if (status === "delivered") {
      return 201;
    }
    if (status === "provider_unavailable") {
      return 503;
    }
    if (status === "rate_limited") {
      return 429;
    }
    if (status === "recipient_unavailable") {
      return 409;
    }
    return 422;
  }

  private async relationshipUnavailable(
    client: PoolClient,
    senderUserId: string,
    recipientUserId: string,
    matchId: string,
  ): Promise<boolean> {
    const result = await client.query<{ unavailable: boolean }>(
      `
        SELECT
          EXISTS (
            SELECT 1
            FROM blocks
            WHERE
              (blocker_user_id = $1 AND blocked_user_id = $2)
              OR (blocker_user_id = $2 AND blocked_user_id = $1)
          )
          OR EXISTS (
            SELECT 1
            FROM mutes
            WHERE
              match_id = $3
              AND muter_user_id = $2
              AND muted_user_id = $1
          ) AS unavailable
      `,
      [senderUserId, recipientUserId, matchId],
    );
    return result.rows[0]?.unavailable ?? true;
  }

  private async spamDecision(
    client: PoolClient,
    senderUserId: string,
    recipientUserId: string,
    threadId: string,
    prepared: PreparedMessage,
    occurredAt: UtcTimestamp,
  ): Promise<SpamDecision> {
    const windowStart = new Date(
      new Date(occurredAt).getTime() -
        this.config.rateLimitWindowSeconds * 1_000,
    );
    const duplicateStart = new Date(
      new Date(occurredAt).getTime() -
        this.config.duplicateWindowSeconds * 1_000,
    );
    const result = await client.query<{
      duplicate_count: string;
      target_count: string;
      thread_count: string;
      user_count: string;
    }>(
      `
        SELECT
          count(*) FILTER (
            WHERE created_at >= $3 AND thread_id = $2
          )::text AS thread_count,
          count(*) FILTER (WHERE created_at >= $3)::text AS user_count,
          count(DISTINCT recipient_user_id) FILTER (
            WHERE created_at >= $3
          )::text AS target_count,
          count(*) FILTER (
            WHERE
              created_at >= $4
              AND kind = 'typed'
              AND normalized_body = $5
          )::text AS duplicate_count
        FROM messages
        WHERE sender_user_id = $1
      `,
      [
        senderUserId,
        threadId,
        windowStart,
        duplicateStart,
        prepared.deterministic.normalizedText,
      ],
    );
    const row = result.rows[0];
    const reasons: string[] = [];
    if (Number(row?.user_count ?? "0") >= this.config.userRateLimit) {
      reasons.push("spam_user_rate");
    }
    if (Number(row?.thread_count ?? "0") >= this.config.threadRateLimit) {
      reasons.push("spam_thread_rate");
    }
    if (prepared.kind === "typed" && Number(row?.duplicate_count ?? "0") >= 1) {
      reasons.push("spam_duplicate");
    }
    const priorTarget = await client.query<{ seen: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM messages
          WHERE
            sender_user_id = $1
            AND recipient_user_id = $2
            AND created_at >= $3
        ) AS seen
      `,
      [senderUserId, recipientUserId, windowStart],
    );
    if (
      !priorTarget.rows[0]?.seen &&
      Number(row?.target_count ?? "0") >= this.config.rapidTargetLimit
    ) {
      reasons.push("spam_rapid_target_switch");
    }
    return { blocked: reasons.length > 0, reasonCodes: reasons };
  }

  private async relationshipCommand(
    userIdValue: string,
    matchId: string,
    subjectUserIdValue: string,
    idempotencyKey: string,
    operation: string,
    requireActive: boolean,
    apply: (
      client: PoolClient,
      userId: UserId,
      subjectUserId: UserId,
      occurredAt: UtcTimestamp,
    ) => Promise<void>,
  ): Promise<ChatCommandResult<SafetyCommandView>> {
    const userId = asUserId(userIdValue);
    const subjectUserId = asUserId(subjectUserIdValue);
    assertUuid("match", matchId);
    if (userId === subjectUserId) {
      throw new ChatError(
        "chat_forbidden",
        "An account cannot apply this command to itself",
        400,
      );
    }
    const occurredAt = timestamp(this.clock());
    const identity = commandIdentity(userId, operation, idempotencyKey, {
      matchId,
      subjectUserId,
    });
    return this.transactions.run(async (client) => {
      const acquisition = await this.idempotency.acquire(
        client,
        identity,
        occurredAt,
      );
      if (!acquisition.acquired) {
        return commandResult<SafetyCommandView>(acquisition.response, true);
      }
      await this.assertMatchRelationship(
        client,
        matchId,
        userId,
        subjectUserId,
        requireActive,
      );
      await apply(client, userId, subjectUserId, occurredAt);
      const view: SafetyCommandView = {
        active: true,
        matchId,
        subjectUserId,
      };
      const response: StoredHttpResponse = {
        status: 200,
        headers: { "content-type": "application/json" },
        body: toJsonObject(view),
      };
      await this.idempotency.complete(client, identity, response, occurredAt);
      return commandResult<SafetyCommandView>(response, false);
    });
  }

  private async assertMatchRelationship(
    client: PoolClient,
    matchId: string,
    userId: string,
    subjectUserId: string,
    requireActive: boolean,
  ): Promise<void> {
    const result = await client.query<{ player_id: string; status: string }>(
      `
        SELECT player_id, status
        FROM match_players
        WHERE match_id = $1 AND player_id = ANY($2::uuid[])
        FOR UPDATE
      `,
      [matchId, [userId, subjectUserId]],
    );
    if (
      result.rows.length !== 2 ||
      (requireActive && result.rows.some(({ status }) => status !== "active"))
    ) {
      throw new ChatError(
        "chat_forbidden",
        requireActive
          ? "Both accounts must be active contestants in the same match"
          : "Both accounts must be contestants in the same match",
        403,
      );
    }
  }

  private assertReportCategory(
    category: string,
  ): asserts category is ReportCategory {
    if (
      ![
        "harassment",
        "hate",
        "other",
        "self_harm",
        "sexual",
        "spam",
        "threat",
      ].includes(category)
    ) {
      throw new ChatError(
        "invalid_report",
        "The report category is not supported",
        400,
      );
    }
  }

  private async createReport(
    client: PoolClient,
    identity: IdempotencyIdentity,
    occurredAt: UtcTimestamp,
    input: {
      readonly category: ReportCategory;
      readonly evidence: object;
      readonly kind: "message" | "user";
      readonly matchId: string;
      readonly messageId?: string;
      readonly reporterUserId: UserId;
      readonly subjectUserId: string;
    },
  ): Promise<ChatCommandResult<ReportView>> {
    const reportId = this.newId();
    const severity = URGENT_REPORT_CATEGORIES.has(input.category)
      ? "urgent"
      : "standard";
    await client.query(
      `
        INSERT INTO reports (
          id,
          kind,
          reporter_user_id,
          subject_user_id,
          match_id,
          message_id,
          category,
          severity,
          evidence_snapshot,
          status,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'queued', $10)
      `,
      [
        reportId,
        input.kind,
        input.reporterUserId,
        input.subjectUserId,
        input.matchId,
        input.messageId ?? null,
        input.category,
        severity,
        JSON.stringify(input.evidence),
        occurredAt,
      ],
    );
    const view: ReportView = {
      category: input.category,
      kind: input.kind,
      matchId: input.matchId,
      reportId,
      status: "queued",
      subjectUserId: input.subjectUserId,
    };
    const response: StoredHttpResponse = {
      status: 201,
      headers: { "content-type": "application/json" },
      body: toJsonObject(view),
    };
    await this.idempotency.complete(client, identity, response, occurredAt);
    return commandResult<ReportView>(response, false);
  }
}
