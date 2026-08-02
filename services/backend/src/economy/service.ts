import { randomUUID } from "node:crypto";

import {
  parseEntityId,
  utcTimestampFromDate,
  type UserId,
  type UtcTimestamp,
} from "@project-booth/domain";
import type { DossierDealRecord, MatchState } from "@project-booth/game-engine";
import type { PoolClient } from "pg";

import { filterTypedMessage } from "../chat/filter.js";
import {
  hashIdempotencyRequest,
  type IdempotencyIdentity,
  PostgresIdempotencyRepository,
  type StoredHttpResponse,
} from "../persistence/idempotency.js";
import { toJsonObject, type JsonObject } from "../persistence/json.js";
import { PostgresOutboxRepository } from "../persistence/outbox.js";
import type { PostgresTransactionRunner } from "../persistence/transaction.js";
import { PostgresRealtimeEventRepository } from "../realtime/events.js";
import {
  PostgresCoinLedger,
  SYSTEM_COSMETIC_SINK_ACCOUNT_ID,
  SYSTEM_ISSUANCE_ACCOUNT_ID,
} from "./ledger.js";

export type BribeOfferState =
  "accepted" | "declined" | "expired" | "pending" | "reversed" | "settled";

export interface EconomyConfig {
  readonly cosmetics: Readonly<Record<string, number>>;
  readonly grants: Readonly<Record<string, number>>;
  readonly matchOutflowCap: number;
  readonly minimumOfferIncrement: number;
}

export const M8_FIXTURE_ECONOMY_CONFIG: EconomyConfig = Object.freeze({
  cosmetics: Object.freeze({
    "cosmetic.avatar.neon": 300,
    "cosmetic.frame.chrome": 500,
  }),
  grants: Object.freeze({
    "grant.fixture.new_account": 1_000,
    "grant.fixture.round_reward": 200,
  }),
  matchOutflowCap: 600,
  minimumOfferIncrement: 50,
});

export interface WalletView {
  readonly matchAllowance?: {
    readonly acceptedOutflow: number;
    readonly cap: number;
    readonly remaining: number;
  };
  readonly pending: number;
  readonly reserved: number;
  readonly restricted: boolean;
  readonly spendable: number;
}

export interface BribeOfferView {
  readonly amount: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly filteredMessage?: string;
  readonly matchId: string;
  readonly offerId: string;
  readonly recipientUserId: string;
  readonly requestedTargetUserId: string;
  readonly roundNumber: number;
  readonly senderUserId: string;
  readonly state: BribeOfferState;
}

export interface EconomyCommandResult<View> {
  readonly replayed: boolean;
  readonly responseStatus: number;
  readonly value: View;
}

export interface CreateBribeOfferInput {
  readonly amount: number;
  readonly message?: string;
  readonly recipientUserId: string;
  readonly requestedTargetUserId: string;
}

export interface EconomyDossierDeal extends DossierDealRecord {
  readonly amount: number;
  readonly offerId: string;
  readonly roundNumber: number;
}

export type EconomyErrorCode =
  | "economy_forbidden"
  | "economy_not_found"
  | "insufficient_allowance"
  | "insufficient_balance"
  | "invalid_amount"
  | "invalid_offer"
  | "offer_closed"
  | "wrong_phase";

export class EconomyError extends Error {
  public constructor(
    public readonly code: EconomyErrorCode,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "EconomyError";
  }
}

interface AccountRow {
  readonly id: string;
  readonly pending_balance: string;
  readonly reserved_balance: string;
  readonly restricted: boolean;
  readonly spendable_balance: string;
}

interface AllowanceRow {
  readonly accepted_outflow: string;
  readonly outflow_cap: string;
}

interface MatchOfferAccessRow {
  readonly match_version: string;
  readonly phase: string;
  readonly phase_deadline: Date | null;
  readonly recipient_status: "active" | "eliminated";
  readonly round_number: number;
  readonly sender_status: "active" | "eliminated";
  readonly target_status: "active" | "eliminated";
}

interface OfferRow {
  readonly amount: string;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly filtered_message: string | null;
  readonly id: string;
  readonly match_id: string;
  readonly recipient_user_id: string;
  readonly requested_target_user_id: string;
  readonly resolved_at: Date | null;
  readonly round_number: number;
  readonly sender_user_id: string;
  readonly state: BribeOfferState;
}

interface CosmeticPurchaseRow {
  readonly amount: string;
  readonly cosmetic_key: string;
  readonly id: string;
  readonly purchased_at: Date;
}

interface GrantRow {
  readonly amount: string;
  readonly grant_key: string;
  readonly granted_at: Date;
  readonly id: string;
  readonly source_key: string;
}

const ACCOUNT_ID_NAMESPACE = "coin_account";

function timestamp(date: Date): UtcTimestamp {
  const parsed = utcTimestampFromDate(date);
  if (!parsed.ok) {
    throw new RangeError("Economy clock returned an invalid timestamp");
  }
  return parsed.value;
}

function asUuid(entity: string, value: string): string {
  const parsed = parseEntityId(entity, value);
  if (!parsed.ok) {
    throw new EconomyError(
      "economy_not_found",
      "The requested economy record was not found",
      404,
    );
  }
  return parsed.value;
}

function safeCoinNumber(value: string | bigint): number {
  const parsed = typeof value === "bigint" ? value : BigInt(value);
  const number = Number(parsed);
  if (!Number.isSafeInteger(number)) {
    throw new RangeError("Coin amount exceeds the safe integer range");
  }
  return number;
}

function assertPositiveCoinAmount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function validateEconomyConfig(config: EconomyConfig): void {
  assertPositiveCoinAmount(config.matchOutflowCap, "matchOutflowCap");
  assertPositiveCoinAmount(
    config.minimumOfferIncrement,
    "minimumOfferIncrement",
  );
  if (config.matchOutflowCap % config.minimumOfferIncrement !== 0) {
    throw new RangeError(
      "matchOutflowCap must be divisible by minimumOfferIncrement",
    );
  }
  for (const [key, amount] of [
    ...Object.entries(config.grants),
    ...Object.entries(config.cosmetics),
  ]) {
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(key)) {
      throw new RangeError(`Invalid economy configuration key: ${key}`);
    }
    assertPositiveCoinAmount(amount, key);
  }
}

function commandIdentity(
  accountId: UserId,
  operation: string,
  idempotencyKey: string,
  request: JsonObject,
): IdempotencyIdentity {
  return {
    accountId,
    operation,
    key: idempotencyKey,
    requestHash: hashIdempotencyRequest(request),
  };
}

function commandResult<View>(
  response: StoredHttpResponse,
  replayed: boolean,
): EconomyCommandResult<View> {
  return {
    replayed,
    responseStatus: response.status,
    value: response.body as unknown as View,
  };
}

function toOffer(row: OfferRow): BribeOfferView {
  return {
    amount: safeCoinNumber(row.amount),
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    ...(row.filtered_message === null
      ? {}
      : { filteredMessage: row.filtered_message }),
    matchId: row.match_id,
    offerId: row.id,
    recipientUserId: row.recipient_user_id,
    requestedTargetUserId: row.requested_target_user_id,
    roundNumber: row.round_number,
    senderUserId: row.sender_user_id,
    state: row.state,
  };
}

function response(status: number, body: unknown): StoredHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: toJsonObject(body),
  };
}

async function offerById(
  client: PoolClient,
  offerId: string,
  forUpdate = false,
): Promise<OfferRow | undefined> {
  const result = await client.query<OfferRow>(
    `
      SELECT
        id,
        match_id,
        round_number,
        sender_user_id,
        recipient_user_id,
        requested_target_user_id,
        amount,
        filtered_message,
        state,
        created_at,
        expires_at,
        resolved_at
      FROM bribe_offers
      WHERE id = $1
      ${forUpdate ? "FOR UPDATE" : ""}
    `,
    [offerId],
  );
  return result.rows[0];
}

export class PostgresEconomyService {
  public constructor(
    private readonly transactions: PostgresTransactionRunner,
    private readonly config: EconomyConfig,
    private readonly clock: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
    private readonly ledger = new PostgresCoinLedger(),
    private readonly idempotency = new PostgresIdempotencyRepository(),
    private readonly realtime = new PostgresRealtimeEventRepository(),
    private readonly outbox = new PostgresOutboxRepository(),
  ) {
    validateEconomyConfig(config);
  }

  private async playerAccount(
    client: PoolClient,
    userId: string,
    occurredAt: UtcTimestamp,
    forUpdate = false,
  ): Promise<AccountRow> {
    await this.ledger.ensurePlayerAccount(
      client,
      this.newIdFor(ACCOUNT_ID_NAMESPACE),
      userId,
      occurredAt,
    );
    const result = await client.query<AccountRow>(
      `
        SELECT
          id,
          spendable_balance,
          reserved_balance,
          pending_balance,
          restricted
        FROM coin_accounts
        WHERE owner_user_id = $1
        ${forUpdate ? "FOR UPDATE" : ""}
      `,
      [userId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("Coin account disappeared after creation");
    }
    return row;
  }

  private newIdFor(_entity: string): string {
    return this.newId();
  }

  private async allowance(
    client: PoolClient,
    matchId: string,
    userId: string,
    occurredAt: UtcTimestamp,
    forUpdate = false,
  ): Promise<AllowanceRow> {
    await client.query(
      `
        INSERT INTO match_coin_allowances (
          match_id,
          player_id,
          outflow_cap,
          accepted_outflow,
          updated_at
        )
        VALUES ($1, $2, $3, 0, $4)
        ON CONFLICT (match_id, player_id) DO NOTHING
      `,
      [matchId, userId, this.config.matchOutflowCap, occurredAt],
    );
    const result = await client.query<AllowanceRow>(
      `
        SELECT outflow_cap, accepted_outflow
        FROM match_coin_allowances
        WHERE match_id = $1 AND player_id = $2
        ${forUpdate ? "FOR UPDATE" : ""}
      `,
      [matchId, userId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("Match coin allowance could not be created");
    }
    return row;
  }

  public async wallet(
    userIdValue: string,
    matchIdValue?: string,
  ): Promise<WalletView> {
    const userId = asUuid("user", userIdValue);
    const matchId =
      matchIdValue === undefined ? undefined : asUuid("match", matchIdValue);
    const occurredAt = timestamp(this.clock());
    return this.transactions.run(async (client) => {
      const account = await this.playerAccount(client, userId, occurredAt);
      if (matchId !== undefined) {
        const participant = await client.query(
          `
            SELECT 1
            FROM match_players
            WHERE match_id = $1 AND player_id = $2
          `,
          [matchId, userId],
        );
        if (participant.rowCount !== 1) {
          throw new EconomyError(
            "economy_forbidden",
            "Only match participants have a match allowance",
            403,
          );
        }
      }
      const allowance =
        matchId === undefined
          ? undefined
          : await this.allowance(client, matchId, userId, occurredAt);
      const acceptedOutflow =
        allowance === undefined
          ? undefined
          : safeCoinNumber(allowance.accepted_outflow);
      const cap =
        allowance === undefined
          ? undefined
          : safeCoinNumber(allowance.outflow_cap);
      return {
        ...(acceptedOutflow === undefined || cap === undefined
          ? {}
          : {
              matchAllowance: {
                acceptedOutflow,
                cap,
                remaining: cap - acceptedOutflow,
              },
            }),
        pending: safeCoinNumber(account.pending_balance),
        reserved: safeCoinNumber(account.reserved_balance),
        restricted: account.restricted,
        spendable: safeCoinNumber(account.spendable_balance),
      };
    });
  }

  public grantCoins(
    userIdValue: string,
    grantKey: string,
    sourceKey: string,
    idempotencyKey: string,
  ): Promise<
    EconomyCommandResult<{
      readonly amount: number;
      readonly grantId: string;
      readonly grantKey: string;
      readonly sourceKey: string;
    }>
  > {
    const userId = asUuid("user", userIdValue) as UserId;
    const amount = this.config.grants[grantKey];
    if (
      amount === undefined ||
      sourceKey.length < 1 ||
      sourceKey.length > 256
    ) {
      throw new EconomyError("invalid_amount", "The grant is invalid", 400);
    }
    const occurredAt = timestamp(this.clock());
    const identity = commandIdentity(
      userId,
      "economy.coin.grant",
      idempotencyKey,
      toJsonObject({ grantKey, sourceKey }),
    );
    return this.transactions.run(async (client) => {
      const acquisition = await this.idempotency.acquire(
        client,
        identity,
        occurredAt,
      );
      if (!acquisition.acquired) {
        return commandResult(acquisition.response, true);
      }
      const existing = await client.query<GrantRow>(
        `
          SELECT id, grant_key, source_key, amount, granted_at
          FROM coin_grants
          WHERE user_id = $1 AND grant_key = $2 AND source_key = $3
        `,
        [userId, grantKey, sourceKey],
      );
      const prior = existing.rows[0];
      if (prior !== undefined) {
        const priorResponse = response(200, {
          amount: safeCoinNumber(prior.amount),
          grantId: prior.id,
          grantKey: prior.grant_key,
          sourceKey: prior.source_key,
        });
        await this.idempotency.complete(
          client,
          identity,
          priorResponse,
          occurredAt,
        );
        return commandResult(priorResponse, true);
      }

      const account = await this.playerAccount(
        client,
        userId,
        occurredAt,
        true,
      );
      const grantId = this.newIdFor("coin_grant");
      const ledgerTransactionId = this.newIdFor("ledger_transaction");
      await this.ledger.post(client, {
        createdAt: occurredAt,
        kind: "grant",
        metadata: toJsonObject({ grantKey, sourceKey, userId }),
        postings: [
          {
            accountId: SYSTEM_ISSUANCE_ACCOUNT_ID,
            amount: -BigInt(amount),
            bucket: "spendable",
          },
          {
            accountId: account.id,
            amount: BigInt(amount),
            bucket: "spendable",
          },
        ],
        sourceKey: `${userId}:${grantKey}:${sourceKey}`,
        sourceOperation: "coin.grant",
        transactionId: ledgerTransactionId,
      });
      await client.query(
        `
          INSERT INTO coin_grants (
            id,
            user_id,
            grant_key,
            source_key,
            amount,
            ledger_transaction_id,
            granted_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          grantId,
          userId,
          grantKey,
          sourceKey,
          amount,
          ledgerTransactionId,
          occurredAt,
        ],
      );
      const stored = response(201, { amount, grantId, grantKey, sourceKey });
      await this.idempotency.complete(client, identity, stored, occurredAt);
      return commandResult(stored, false);
    });
  }

  public purchaseCosmetic(
    userIdValue: string,
    cosmeticKey: string,
    idempotencyKey: string,
  ): Promise<
    EconomyCommandResult<{
      readonly amount: number;
      readonly cosmeticKey: string;
      readonly purchaseId: string;
      readonly purchasedAt: string;
    }>
  > {
    const userId = asUuid("user", userIdValue) as UserId;
    const amount = this.config.cosmetics[cosmeticKey];
    if (amount === undefined) {
      throw new EconomyError("invalid_amount", "The cosmetic is invalid", 400);
    }
    const occurredAt = timestamp(this.clock());
    const identity = commandIdentity(
      userId,
      "economy.cosmetic.purchase",
      idempotencyKey,
      toJsonObject({ cosmeticKey }),
    );
    return this.transactions.run(async (client) => {
      const acquisition = await this.idempotency.acquire(
        client,
        identity,
        occurredAt,
      );
      if (!acquisition.acquired) {
        return commandResult(acquisition.response, true);
      }
      const existing = await client.query<CosmeticPurchaseRow>(
        `
          SELECT id, cosmetic_key, amount, purchased_at
          FROM cosmetic_purchases
          WHERE user_id = $1 AND cosmetic_key = $2
        `,
        [userId, cosmeticKey],
      );
      const prior = existing.rows[0];
      if (prior !== undefined) {
        const priorResponse = response(200, {
          amount: safeCoinNumber(prior.amount),
          cosmeticKey: prior.cosmetic_key,
          purchaseId: prior.id,
          purchasedAt: prior.purchased_at.toISOString(),
        });
        await this.idempotency.complete(
          client,
          identity,
          priorResponse,
          occurredAt,
        );
        return commandResult(priorResponse, true);
      }
      const account = await this.playerAccount(
        client,
        userId,
        occurredAt,
        true,
      );
      if (account.restricted) {
        throw new EconomyError(
          "economy_forbidden",
          "The coin account is restricted",
          403,
        );
      }
      if (BigInt(account.spendable_balance) < BigInt(amount)) {
        throw new EconomyError(
          "insufficient_balance",
          "The spendable balance is too low",
          409,
        );
      }
      const purchaseId = this.newIdFor("cosmetic_purchase");
      const ledgerTransactionId = this.newIdFor("ledger_transaction");
      await this.ledger.post(client, {
        createdAt: occurredAt,
        kind: "cosmetic_sink",
        metadata: toJsonObject({ cosmeticKey, userId }),
        postings: [
          {
            accountId: account.id,
            amount: -BigInt(amount),
            bucket: "spendable",
          },
          {
            accountId: SYSTEM_COSMETIC_SINK_ACCOUNT_ID,
            amount: BigInt(amount),
            bucket: "spendable",
          },
        ],
        sourceKey: purchaseId,
        sourceOperation: "cosmetic.purchase",
        transactionId: ledgerTransactionId,
      });
      await client.query(
        `
          INSERT INTO cosmetic_purchases (
            id,
            user_id,
            cosmetic_key,
            amount,
            ledger_transaction_id,
            purchased_at
          )
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          purchaseId,
          userId,
          cosmeticKey,
          amount,
          ledgerTransactionId,
          occurredAt,
        ],
      );
      await client.query(
        `
          INSERT INTO inventory_items (
            user_id,
            cosmetic_key,
            purchase_id,
            acquired_at
          )
          VALUES ($1, $2, $3, $4)
        `,
        [userId, cosmeticKey, purchaseId, occurredAt],
      );
      const stored = response(201, {
        amount,
        cosmeticKey,
        purchaseId,
        purchasedAt: occurredAt,
      });
      await this.idempotency.complete(client, identity, stored, occurredAt);
      return commandResult(stored, false);
    });
  }

  private assertOfferAmount(amount: number): void {
    if (
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      amount % this.config.minimumOfferIncrement !== 0
    ) {
      throw new EconomyError(
        "invalid_amount",
        "The offer amount does not match the configured increment",
        400,
      );
    }
  }

  private filteredOfferMessage(value: string | undefined): string | null {
    if (value === undefined) {
      return null;
    }
    const filtered = filterTypedMessage(value);
    if (filtered.action === "block") {
      throw new EconomyError(
        "invalid_offer",
        "The optional offer message did not pass filtering",
        422,
      );
    }
    return filtered.normalizedText;
  }

  private async matchOfferAccess(
    client: PoolClient,
    matchId: string,
    senderUserId: string,
    recipientUserId: string,
    targetUserId: string,
  ): Promise<MatchOfferAccessRow> {
    const result = await client.query<MatchOfferAccessRow>(
      `
        SELECT
          current_match.version AS match_version,
          current_match.phase,
          current_match.phase_deadline,
          jsonb_array_length(
            current_match.state_snapshot -> 'completedRounds'
          ) + 1 AS round_number,
          sender.status AS sender_status,
          recipient.status AS recipient_status,
          target.status AS target_status
        FROM matches AS current_match
        JOIN match_players AS sender
          ON sender.match_id = current_match.id AND sender.player_id = $2
        JOIN match_players AS recipient
          ON recipient.match_id = current_match.id AND recipient.player_id = $3
        JOIN match_players AS target
          ON target.match_id = current_match.id AND target.player_id = $4
        WHERE current_match.id = $1
        FOR UPDATE OF current_match, sender, recipient, target
      `,
      [matchId, senderUserId, recipientUserId, targetUserId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new EconomyError(
        "invalid_offer",
        "Every offer participant must belong to the match",
        409,
      );
    }
    return row;
  }

  private assertNegotiationAccess(
    access: MatchOfferAccessRow,
    occurredAt: UtcTimestamp,
  ): void {
    if (
      access.phase !== "negotiation" ||
      access.phase_deadline === null ||
      access.phase_deadline.toISOString() <= occurredAt
    ) {
      throw new EconomyError(
        "wrong_phase",
        "Offers are available only during active negotiation",
        409,
      );
    }
    if (
      access.sender_status !== "active" ||
      access.recipient_status !== "active" ||
      access.target_status !== "active"
    ) {
      throw new EconomyError(
        "invalid_offer",
        "Offer participants and target must be active contestants",
        409,
      );
    }
  }

  public createBribeOffer(
    senderUserIdValue: string,
    matchIdValue: string,
    idempotencyKey: string,
    input: CreateBribeOfferInput,
  ): Promise<EconomyCommandResult<BribeOfferView>> {
    const senderUserId = asUuid("user", senderUserIdValue) as UserId;
    const matchId = asUuid("match", matchIdValue);
    const recipientUserId = asUuid("user", input.recipientUserId);
    const targetUserId = asUuid("user", input.requestedTargetUserId);
    if (senderUserId === recipientUserId || recipientUserId === targetUserId) {
      throw new EconomyError(
        "invalid_offer",
        "Sender, recipient, and ballot target are invalid",
        400,
      );
    }
    this.assertOfferAmount(input.amount);
    const filteredMessage = this.filteredOfferMessage(input.message);
    const occurredAt = timestamp(this.clock());
    const identity = commandIdentity(
      senderUserId,
      "economy.bribe.create",
      idempotencyKey,
      toJsonObject({ input, matchId }),
    );
    return this.transactions.run(async (client) => {
      const acquisition = await this.idempotency.acquire(
        client,
        identity,
        occurredAt,
      );
      if (!acquisition.acquired) {
        return commandResult(acquisition.response, true);
      }
      const access = await this.matchOfferAccess(
        client,
        matchId,
        senderUserId,
        recipientUserId,
        targetUserId,
      );
      this.assertNegotiationAccess(access, occurredAt);
      const account = await this.playerAccount(
        client,
        senderUserId,
        occurredAt,
        true,
      );
      const allowance = await this.allowance(
        client,
        matchId,
        senderUserId,
        occurredAt,
        true,
      );
      if (
        account.restricted ||
        BigInt(account.spendable_balance) < BigInt(input.amount)
      ) {
        throw new EconomyError(
          account.restricted ? "economy_forbidden" : "insufficient_balance",
          account.restricted
            ? "The coin account is restricted"
            : "The spendable balance is too low",
          account.restricted ? 403 : 409,
        );
      }
      if (
        BigInt(allowance.accepted_outflow) + BigInt(input.amount) >
        BigInt(allowance.outflow_cap)
      ) {
        throw new EconomyError(
          "insufficient_allowance",
          "The offer exceeds the remaining match allowance",
          409,
        );
      }

      const pending = await client.query<OfferRow>(
        `
          SELECT
            id,
            match_id,
            round_number,
            sender_user_id,
            recipient_user_id,
            requested_target_user_id,
            amount,
            filtered_message,
            state,
            created_at,
            expires_at,
            resolved_at
          FROM bribe_offers
          WHERE
            match_id = $1
            AND round_number = $2
            AND sender_user_id = $3
            AND recipient_user_id = $4
            AND state = 'pending'
          FOR UPDATE
        `,
        [matchId, access.round_number, senderUserId, recipientUserId],
      );
      const prior = pending.rows[0];
      if (prior !== undefined) {
        await client.query(
          `
            UPDATE bribe_offers
            SET state = 'expired', resolved_at = $2
            WHERE id = $1
          `,
          [prior.id, occurredAt],
        );
        const expiredPrior = await offerById(client, prior.id);
        if (expiredPrior === undefined) {
          throw new Error("Replaced offer disappeared");
        }
        await this.emitOfferEvent(
          client,
          toOffer(expiredPrior),
          Number(access.match_version),
          occurredAt,
        );
      }
      const offerId = this.newIdFor("bribe_offer");
      const inserted = await client.query<OfferRow>(
        `
          INSERT INTO bribe_offers (
            id,
            match_id,
            round_number,
            sender_user_id,
            recipient_user_id,
            requested_target_user_id,
            amount,
            filtered_message,
            state,
            created_at,
            expires_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10)
          RETURNING
            id,
            match_id,
            round_number,
            sender_user_id,
            recipient_user_id,
            requested_target_user_id,
            amount,
            filtered_message,
            state,
            created_at,
            expires_at,
            resolved_at
        `,
        [
          offerId,
          matchId,
          access.round_number,
          senderUserId,
          recipientUserId,
          targetUserId,
          input.amount,
          filteredMessage,
          occurredAt,
          access.phase_deadline,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        throw new Error("Bribe offer was not persisted");
      }
      const view = toOffer(row);
      await this.emitOfferEvent(
        client,
        view,
        Number(access.match_version),
        occurredAt,
      );
      const stored = response(prior === undefined ? 201 : 200, view);
      await this.idempotency.complete(client, identity, stored, occurredAt);
      return commandResult(stored, false);
    });
  }

  public declineBribeOffer(
    recipientUserIdValue: string,
    offerIdValue: string,
    idempotencyKey: string,
  ): Promise<EconomyCommandResult<BribeOfferView>> {
    const recipientUserId = asUuid("user", recipientUserIdValue) as UserId;
    const offerId = asUuid("bribe_offer", offerIdValue);
    return this.offerStateCommand(
      recipientUserId,
      offerId,
      idempotencyKey,
      "economy.bribe.decline",
      async (client, offer, occurredAt, matchVersion) => {
        if (offer.recipient_user_id !== recipientUserId) {
          throw new EconomyError(
            "economy_forbidden",
            "Only the offer recipient may decline it",
            403,
          );
        }
        if (
          offer.state !== "pending" ||
          offer.expires_at.toISOString() <= occurredAt
        ) {
          throw new EconomyError(
            "offer_closed",
            "The offer is no longer pending",
            409,
          );
        }
        await client.query(
          `
            UPDATE bribe_offers
            SET state = 'declined', resolved_at = $2
            WHERE id = $1
          `,
          [offer.id, occurredAt],
        );
        const updated = await offerById(client, offer.id);
        if (updated === undefined) {
          throw new Error("Declined offer disappeared");
        }
        await this.emitOfferEvent(
          client,
          toOffer(updated),
          matchVersion,
          occurredAt,
        );
        return updated;
      },
    );
  }

  public acceptBribeOffer(
    recipientUserIdValue: string,
    offerIdValue: string,
    idempotencyKey: string,
  ): Promise<EconomyCommandResult<BribeOfferView>> {
    const recipientUserId = asUuid("user", recipientUserIdValue) as UserId;
    const offerId = asUuid("bribe_offer", offerIdValue);
    return this.offerStateCommand(
      recipientUserId,
      offerId,
      idempotencyKey,
      "economy.bribe.accept",
      async (client, offer, occurredAt, matchVersion) => {
        if (offer.recipient_user_id !== recipientUserId) {
          throw new EconomyError(
            "economy_forbidden",
            "Only the offer recipient may accept it",
            403,
          );
        }
        if (offer.state === "accepted") {
          return offer;
        }
        if (
          offer.state !== "pending" ||
          offer.expires_at.toISOString() <= occurredAt
        ) {
          throw new EconomyError(
            "offer_closed",
            "The offer is no longer pending",
            409,
          );
        }
        const access = await this.matchOfferAccess(
          client,
          offer.match_id,
          offer.sender_user_id,
          offer.recipient_user_id,
          offer.requested_target_user_id,
        );
        this.assertNegotiationAccess(access, occurredAt);
        if (access.round_number !== offer.round_number) {
          throw new EconomyError(
            "offer_closed",
            "The offer belongs to an earlier round",
            409,
          );
        }
        const sender = await this.playerAccount(
          client,
          offer.sender_user_id,
          occurredAt,
          true,
        );
        const recipient = await this.playerAccount(
          client,
          offer.recipient_user_id,
          occurredAt,
          true,
        );
        const allowance = await this.allowance(
          client,
          offer.match_id,
          offer.sender_user_id,
          occurredAt,
          true,
        );
        const amount = BigInt(offer.amount);
        if (sender.restricted) {
          throw new EconomyError(
            "economy_forbidden",
            "The sender coin account is restricted",
            403,
          );
        }
        if (BigInt(sender.spendable_balance) < amount) {
          throw new EconomyError(
            "insufficient_balance",
            "The sender spendable balance is too low",
            409,
          );
        }
        if (
          BigInt(allowance.accepted_outflow) + amount >
          BigInt(allowance.outflow_cap)
        ) {
          throw new EconomyError(
            "insufficient_allowance",
            "The offer exceeds the sender's remaining match allowance",
            409,
          );
        }
        const transaction = await this.ledger.post(client, {
          createdAt: occurredAt,
          kind: "bribe_accept",
          metadata: toJsonObject({
            matchId: offer.match_id,
            offerId: offer.id,
            recipientUserId: offer.recipient_user_id,
            roundNumber: offer.round_number,
            senderUserId: offer.sender_user_id,
          }),
          postings: [
            {
              accountId: sender.id,
              amount: -amount,
              bucket: "spendable",
            },
            {
              accountId: recipient.id,
              amount,
              bucket: "pending",
            },
          ],
          sourceKey: offer.id,
          sourceOperation: "bribe.accept",
          transactionId: this.newIdFor("ledger_transaction"),
        });
        await client.query(
          `
            UPDATE match_coin_allowances
            SET accepted_outflow = accepted_outflow + $3::bigint,
                updated_at = $4
            WHERE match_id = $1 AND player_id = $2
          `,
          [offer.match_id, offer.sender_user_id, offer.amount, occurredAt],
        );
        await client.query(
          `
            UPDATE bribe_offers
            SET state = 'accepted',
                accepted_ledger_transaction_id = $2
            WHERE id = $1 AND state = 'pending'
          `,
          [offer.id, transaction.transactionId],
        );
        const updated = await offerById(client, offer.id);
        if (updated === undefined) {
          throw new Error("Accepted offer disappeared");
        }
        await this.emitOfferEvent(
          client,
          toOffer(updated),
          matchVersion,
          occurredAt,
        );
        return updated;
      },
    );
  }

  private offerStateCommand(
    actorUserId: UserId,
    offerId: string,
    idempotencyKey: string,
    operation: string,
    action: (
      client: PoolClient,
      offer: OfferRow,
      occurredAt: UtcTimestamp,
      matchVersion: number,
    ) => Promise<OfferRow>,
  ): Promise<EconomyCommandResult<BribeOfferView>> {
    const occurredAt = timestamp(this.clock());
    const identity = commandIdentity(
      actorUserId,
      operation,
      idempotencyKey,
      toJsonObject({ offerId }),
    );
    return this.transactions.run(async (client) => {
      const acquisition = await this.idempotency.acquire(
        client,
        identity,
        occurredAt,
      );
      if (!acquisition.acquired) {
        return commandResult(acquisition.response, true);
      }
      const observedOffer = await offerById(client, offerId);
      if (observedOffer === undefined) {
        throw new EconomyError(
          "economy_not_found",
          "The bribe offer was not found",
          404,
        );
      }
      const match = await client.query<{ readonly version: string }>(
        "SELECT version FROM matches WHERE id = $1 FOR UPDATE",
        [observedOffer.match_id],
      );
      const matchVersion = Number(match.rows[0]?.version);
      if (!Number.isSafeInteger(matchVersion)) {
        throw new EconomyError(
          "economy_not_found",
          "The bribe match was not found",
          404,
        );
      }
      const offer = await offerById(client, offerId, true);
      if (offer === undefined) {
        throw new EconomyError(
          "economy_not_found",
          "The bribe offer was not found",
          404,
        );
      }
      const updated = await action(client, offer, occurredAt, matchVersion);
      const stored = response(200, toOffer(updated));
      await this.idempotency.complete(client, identity, stored, occurredAt);
      return commandResult(stored, false);
    });
  }

  public listBribeOffers(
    userIdValue: string,
    matchIdValue: string,
  ): Promise<readonly BribeOfferView[]> {
    const userId = asUuid("user", userIdValue);
    const matchId = asUuid("match", matchIdValue);
    return this.transactions.run(async (client) => {
      const participant = await client.query(
        `
          SELECT 1
          FROM match_players
          WHERE match_id = $1 AND player_id = $2
        `,
        [matchId, userId],
      );
      if (participant.rowCount !== 1) {
        throw new EconomyError(
          "economy_forbidden",
          "Only match participants may view offers",
          403,
        );
      }
      const result = await client.query<OfferRow>(
        `
          SELECT
            id,
            match_id,
            round_number,
            sender_user_id,
            recipient_user_id,
            requested_target_user_id,
            amount,
            filtered_message,
            state,
            created_at,
            expires_at,
            resolved_at
          FROM bribe_offers
          WHERE match_id = $1
            AND (sender_user_id = $2 OR recipient_user_id = $2)
          ORDER BY created_at, id
        `,
        [matchId, userId],
      );
      return result.rows.map(toOffer);
    });
  }

  private async emitOfferEvent(
    client: PoolClient,
    offer: BribeOfferView,
    matchVersion: number,
    occurredAt: UtcTimestamp,
  ): Promise<void> {
    const recipients = [
      offer.senderUserId as UserId,
      offer.recipientUserId as UserId,
    ];
    const events = await Promise.all(
      recipients.map((recipientUserId) =>
        this.realtime.appendPrivateEvent(client, {
          event: { offer },
          eventType: "economy.bribe_offer.changed",
          matchId: offer.matchId,
          matchVersion,
          occurredAt,
          recipientUserId,
        }),
      ),
    );
    await this.outbox.enqueue(client, events);
  }

  public settleIncomingAfterBallot(
    matchIdValue: string,
    recipientUserIdValue: string,
    roundNumber: number,
    occurredAtValue: UtcTimestamp = timestamp(this.clock()),
  ): Promise<number> {
    const matchId = asUuid("match", matchIdValue);
    const recipientUserId = asUuid("user", recipientUserIdValue);
    return this.transactions.run(async (client) => {
      await client.query("SELECT id FROM matches WHERE id = $1 FOR UPDATE", [
        matchId,
      ]);
      return this.settleIncomingWithinTransaction(
        client,
        matchId,
        recipientUserId,
        roundNumber,
        occurredAtValue,
      );
    });
  }

  public async settleIncomingWithinTransaction(
    client: PoolClient,
    matchId: string,
    recipientUserId: string,
    roundNumber: number,
    occurredAt: UtcTimestamp,
    eventMatchVersion?: number,
  ): Promise<number> {
    const offers = await this.lockAcceptedIncoming(
      client,
      matchId,
      recipientUserId,
      roundNumber,
    );
    if (offers.length === 0) {
      return 0;
    }
    const recipient = await this.playerAccount(
      client,
      recipientUserId,
      occurredAt,
      true,
    );
    let settled = 0;
    for (const offer of offers) {
      const amount = BigInt(offer.amount);
      const transaction = await this.ledger.post(client, {
        createdAt: occurredAt,
        kind: "bribe_settle",
        metadata: toJsonObject({ matchId, offerId: offer.id, roundNumber }),
        postings: [
          {
            accountId: recipient.id,
            amount: -amount,
            bucket: "pending",
          },
          {
            accountId: recipient.id,
            amount,
            bucket: "spendable",
          },
        ],
        sourceKey: offer.id,
        sourceOperation: "bribe.settle",
        transactionId: this.newIdFor("ledger_transaction"),
      });
      await client.query(
        `
          UPDATE bribe_offers
          SET state = 'settled',
              resolved_at = $2,
              resolved_ledger_transaction_id = $3
          WHERE id = $1 AND state = 'accepted'
        `,
        [offer.id, occurredAt, transaction.transactionId],
      );
      const updated = await offerById(client, offer.id);
      if (updated === undefined) {
        throw new Error("Settled offer disappeared");
      }
      await this.emitOfferEvent(
        client,
        toOffer(updated),
        eventMatchVersion ?? (await this.currentMatchVersion(client, matchId)),
        occurredAt,
      );
      settled += safeCoinNumber(amount);
    }
    return settled;
  }

  public reverseIncomingAfterMissedBallot(
    matchIdValue: string,
    recipientUserIdValue: string,
    roundNumber: number,
    occurredAtValue: UtcTimestamp = timestamp(this.clock()),
  ): Promise<number> {
    const matchId = asUuid("match", matchIdValue);
    const recipientUserId = asUuid("user", recipientUserIdValue);
    return this.transactions.run(async (client) => {
      await client.query("SELECT id FROM matches WHERE id = $1 FOR UPDATE", [
        matchId,
      ]);
      return this.reverseIncomingWithinTransaction(
        client,
        matchId,
        recipientUserId,
        roundNumber,
        occurredAtValue,
      );
    });
  }

  public async reverseIncomingWithinTransaction(
    client: PoolClient,
    matchId: string,
    recipientUserId: string,
    roundNumber: number,
    occurredAt: UtcTimestamp,
    eventMatchVersion?: number,
  ): Promise<number> {
    const offers = await this.lockAcceptedIncoming(
      client,
      matchId,
      recipientUserId,
      roundNumber,
    );
    if (offers.length === 0) {
      return 0;
    }
    const recipient = await this.playerAccount(
      client,
      recipientUserId,
      occurredAt,
      true,
    );
    let reversed = 0;
    for (const offer of offers) {
      const sender = await this.playerAccount(
        client,
        offer.sender_user_id,
        occurredAt,
        true,
      );
      const amount = BigInt(offer.amount);
      const transaction = await this.ledger.post(client, {
        createdAt: occurredAt,
        kind: "bribe_reverse",
        metadata: toJsonObject({ matchId, offerId: offer.id, roundNumber }),
        postings: [
          {
            accountId: recipient.id,
            amount: -amount,
            bucket: "pending",
          },
          {
            accountId: sender.id,
            amount,
            bucket: "spendable",
          },
        ],
        sourceKey: offer.id,
        sourceOperation: "bribe.reverse",
        transactionId: this.newIdFor("ledger_transaction"),
      });
      await client.query(
        `
          UPDATE match_coin_allowances
          SET accepted_outflow = accepted_outflow - $3::bigint,
              updated_at = $4
          WHERE match_id = $1
            AND player_id = $2
            AND accepted_outflow >= $3::bigint
        `,
        [matchId, offer.sender_user_id, offer.amount, occurredAt],
      );
      await client.query(
        `
          UPDATE bribe_offers
          SET state = 'reversed',
              resolved_at = $2,
              resolved_ledger_transaction_id = $3
          WHERE id = $1 AND state = 'accepted'
        `,
        [offer.id, occurredAt, transaction.transactionId],
      );
      const updated = await offerById(client, offer.id);
      if (updated === undefined) {
        throw new Error("Reversed offer disappeared");
      }
      await this.emitOfferEvent(
        client,
        toOffer(updated),
        eventMatchVersion ?? (await this.currentMatchVersion(client, matchId)),
        occurredAt,
      );
      reversed += safeCoinNumber(amount);
    }
    return reversed;
  }

  private async lockAcceptedIncoming(
    client: PoolClient,
    matchId: string,
    recipientUserId: string,
    roundNumber: number,
  ): Promise<readonly OfferRow[]> {
    const result = await client.query<OfferRow>(
      `
        SELECT
          id,
          match_id,
          round_number,
          sender_user_id,
          recipient_user_id,
          requested_target_user_id,
          amount,
          filtered_message,
          state,
          created_at,
          expires_at,
          resolved_at
        FROM bribe_offers
        WHERE
          match_id = $1
          AND recipient_user_id = $2
          AND round_number = $3
          AND state = 'accepted'
        ORDER BY id
        FOR UPDATE
      `,
      [matchId, recipientUserId, roundNumber],
    );
    return result.rows;
  }

  public async expirePendingWithinTransaction(
    client: PoolClient,
    matchId: string,
    roundNumber: number,
    occurredAt: UtcTimestamp,
    eventMatchVersion?: number,
  ): Promise<number> {
    const result = await client.query<OfferRow>(
      `
        UPDATE bribe_offers
        SET state = 'expired', resolved_at = $3
        WHERE match_id = $1
          AND round_number = $2
          AND state = 'pending'
          AND expires_at <= $3
        RETURNING
          id,
          match_id,
          round_number,
          sender_user_id,
          recipient_user_id,
          requested_target_user_id,
          amount,
          filtered_message,
          state,
          created_at,
          expires_at,
          resolved_at
      `,
      [matchId, roundNumber, occurredAt],
    );
    const matchVersion =
      eventMatchVersion ?? (await this.currentMatchVersion(client, matchId));
    for (const offer of result.rows) {
      await this.emitOfferEvent(
        client,
        toOffer(offer),
        matchVersion,
        occurredAt,
      );
    }
    return result.rows.length;
  }

  private async currentMatchVersion(
    client: PoolClient,
    matchId: string,
  ): Promise<number> {
    const result = await client.query<{ readonly version: string }>(
      "SELECT version FROM matches WHERE id = $1",
      [matchId],
    );
    const version = Number(result.rows[0]?.version);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new Error("Economy event match version is invalid");
    }
    return version;
  }

  public dossierDeals(
    matchIdValue: string,
    state: MatchState,
  ): Promise<readonly EconomyDossierDeal[]> {
    const matchId = asUuid("match", matchIdValue);
    if (state.matchId !== matchId || state.phase !== "complete") {
      throw new EconomyError(
        "wrong_phase",
        "Deal classifications are available only after match completion",
        409,
      );
    }
    return this.transactions.run(async (client) => {
      const result = await client.query<OfferRow>(
        `
          SELECT
            id,
            match_id,
            round_number,
            sender_user_id,
            recipient_user_id,
            requested_target_user_id,
            amount,
            filtered_message,
            state,
            created_at,
            expires_at,
            resolved_at
          FROM bribe_offers
          WHERE match_id = $1
          ORDER BY round_number, created_at, id
        `,
        [matchId],
      );
      return result.rows.map((offer) => {
        let outcome: EconomyDossierDeal["outcome"];
        if (
          offer.state === "declined" ||
          offer.state === "expired" ||
          offer.state === "reversed"
        ) {
          outcome = offer.state;
        } else if (offer.state === "settled") {
          const round = state.completedRounds[offer.round_number - 1];
          const ballot = round?.normalBallots.find(
            ({ voterId }) => voterId === offer.recipient_user_id,
          );
          if (ballot === undefined) {
            throw new Error("Settled bribe has no recipient ballot");
          }
          outcome =
            ballot.targetId === offer.requested_target_user_id
              ? "honored"
              : "betrayed";
        } else {
          throw new Error(
            `Completed match contains unresolved offer ${offer.id}`,
          );
        }
        return {
          amount: safeCoinNumber(offer.amount),
          offerId: offer.id,
          outcome,
          promisedTargetPlayerId: offer.requested_target_user_id as UserId,
          recipientPlayerId: offer.recipient_user_id as UserId,
          roundNumber: offer.round_number,
          senderPlayerId: offer.sender_user_id as UserId,
        };
      });
    });
  }
}
