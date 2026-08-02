import type { PoolClient } from "pg";

import type { JsonObject } from "../persistence/json.js";

export type CoinBucket = "pending" | "reserved" | "spendable";

export interface LedgerPosting {
  readonly accountId: string;
  readonly amount: bigint;
  readonly bucket: CoinBucket;
}

export interface BalancedLedgerPostings {
  readonly postings: readonly LedgerPosting[];
  readonly total: 0n;
}

export type LedgerTransactionKind =
  | "bribe_accept"
  | "bribe_reverse"
  | "bribe_settle"
  | "bucket_release"
  | "bucket_reserve"
  | "cosmetic_sink"
  | "grant";

export interface PostLedgerTransactionInput {
  readonly createdAt: string;
  readonly kind: LedgerTransactionKind;
  readonly metadata?: JsonObject;
  readonly postings: readonly LedgerPosting[];
  readonly sourceKey: string;
  readonly sourceOperation: string;
  readonly transactionId: string;
}

export interface CoinAccountBalance {
  readonly accountId: string;
  readonly pending: bigint;
  readonly reserved: bigint;
  readonly spendable: bigint;
}

interface CoinAccountRow {
  readonly id: string;
  readonly pending_balance: string;
  readonly reserved_balance: string;
  readonly spendable_balance: string;
}

interface ExistingTransactionRow {
  readonly id: string;
}

export const SYSTEM_ISSUANCE_ACCOUNT_ID =
  "01980000-0000-7000-8000-000000000001";
export const SYSTEM_COSMETIC_SINK_ACCOUNT_ID =
  "01980000-0000-7000-8000-000000000002";

export class InvalidLedgerTransactionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidLedgerTransactionError";
  }
}

export function balanceLedgerPostings(
  postings: readonly LedgerPosting[],
): BalancedLedgerPostings {
  if (postings.length < 2) {
    throw new InvalidLedgerTransactionError(
      "A ledger transaction requires at least two postings",
    );
  }
  let total = 0n;
  for (const posting of postings) {
    if (posting.accountId.length === 0) {
      throw new InvalidLedgerTransactionError(
        "A ledger posting requires an account",
      );
    }
    if (posting.amount === 0n) {
      throw new InvalidLedgerTransactionError(
        "A ledger posting cannot have a zero amount",
      );
    }
    total += posting.amount;
  }
  if (total !== 0n) {
    throw new InvalidLedgerTransactionError(
      `Ledger postings must sum to zero, received ${total}`,
    );
  }
  return Object.freeze({
    postings: Object.freeze(postings.map((posting) => Object.freeze(posting))),
    total: 0n,
  });
}

function rowToBalance(row: CoinAccountRow): CoinAccountBalance {
  return {
    accountId: row.id,
    pending: BigInt(row.pending_balance),
    reserved: BigInt(row.reserved_balance),
    spendable: BigInt(row.spendable_balance),
  };
}

function column(bucket: CoinBucket): string {
  switch (bucket) {
    case "pending":
      return "pending_balance";
    case "reserved":
      return "reserved_balance";
    case "spendable":
      return "spendable_balance";
  }
}

export class PostgresCoinLedger {
  public async ensurePlayerAccount(
    client: PoolClient,
    accountId: string,
    userId: string,
    occurredAt: string,
  ): Promise<CoinAccountBalance> {
    await client.query(
      `
        INSERT INTO coin_accounts (
          id,
          owner_user_id,
          account_kind,
          created_at,
          updated_at
        )
        VALUES ($1, $2, 'player', $3, $3)
        ON CONFLICT (owner_user_id) DO NOTHING
      `,
      [accountId, userId, occurredAt],
    );
    const result = await client.query<CoinAccountRow>(
      `
        SELECT
          id,
          spendable_balance,
          reserved_balance,
          pending_balance
        FROM coin_accounts
        WHERE owner_user_id = $1
      `,
      [userId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("Coin account could not be created");
    }
    return rowToBalance(row);
  }

  public async playerAccount(
    client: PoolClient,
    userId: string,
    forUpdate = false,
  ): Promise<CoinAccountBalance | undefined> {
    const result = await client.query<CoinAccountRow>(
      `
        SELECT
          id,
          spendable_balance,
          reserved_balance,
          pending_balance
        FROM coin_accounts
        WHERE owner_user_id = $1
        ${forUpdate ? "FOR UPDATE" : ""}
      `,
      [userId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : rowToBalance(row);
  }

  public async post(
    client: PoolClient,
    input: PostLedgerTransactionInput,
  ): Promise<{ readonly created: boolean; readonly transactionId: string }> {
    const balanced = balanceLedgerPostings(input.postings);
    const existing = await client.query<ExistingTransactionRow>(
      `
        SELECT id
        FROM ledger_transactions
        WHERE source_operation = $1 AND source_key = $2
      `,
      [input.sourceOperation, input.sourceKey],
    );
    const existingRow = existing.rows[0];
    if (existingRow !== undefined) {
      return { created: false, transactionId: existingRow.id };
    }

    const accountIds = [
      ...new Set(balanced.postings.map(({ accountId }) => accountId)),
    ].sort();
    const locked = await client.query<{ readonly id: string }>(
      `
        SELECT id
        FROM coin_accounts
        WHERE id = ANY($1::uuid[])
        ORDER BY id
        FOR UPDATE
      `,
      [accountIds],
    );
    if (locked.rows.length !== accountIds.length) {
      throw new InvalidLedgerTransactionError(
        "Every ledger posting account must exist",
      );
    }

    await client.query(
      `
        INSERT INTO ledger_transactions (
          id,
          transaction_kind,
          source_operation,
          source_key,
          metadata,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      `,
      [
        input.transactionId,
        input.kind,
        input.sourceOperation,
        input.sourceKey,
        JSON.stringify(input.metadata ?? {}),
        input.createdAt,
      ],
    );

    for (const [sequence, posting] of balanced.postings.entries()) {
      await client.query(
        `
          INSERT INTO ledger_entries (
            transaction_id,
            sequence,
            coin_account_id,
            bucket,
            amount
          )
          VALUES ($1, $2, $3, $4, $5)
        `,
        [
          input.transactionId,
          sequence,
          posting.accountId,
          posting.bucket,
          posting.amount.toString(),
        ],
      );
      await client.query(
        `
          UPDATE coin_accounts
          SET ${column(posting.bucket)} = ${column(posting.bucket)} + $2::bigint,
              updated_at = $3
          WHERE id = $1
        `,
        [posting.accountId, posting.amount.toString(), input.createdAt],
      );
    }

    return { created: true, transactionId: input.transactionId };
  }
}
