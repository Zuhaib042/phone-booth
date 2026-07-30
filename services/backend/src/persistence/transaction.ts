import type { Pool, PoolClient } from "pg";

const RETRYABLE_TRANSACTION_CODES = new Set(["40001", "40P01"]);

export interface TransactionRunnerOptions {
  readonly maximumAttempts?: number;
  readonly retryBaseDelayMilliseconds?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export class TransactionRetryExhaustedError extends Error {
  public constructor(
    public readonly attempts: number,
    options: ErrorOptions,
  ) {
    super(`Transaction failed after ${attempts} attempts`, options);
    this.name = "TransactionRetryExhaustedError";
  }
}

function postgresErrorCode(error: unknown): string | undefined {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

export function isRetryableTransactionError(error: unknown): boolean {
  const code = postgresErrorCode(error);
  return code !== undefined && RETRYABLE_TRANSACTION_CODES.has(code);
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class PostgresTransactionRunner {
  private readonly maximumAttempts: number;
  private readonly retryBaseDelayMilliseconds: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  public constructor(
    private readonly pool: Pool,
    options: TransactionRunnerOptions = {},
  ) {
    this.maximumAttempts = options.maximumAttempts ?? 4;
    this.retryBaseDelayMilliseconds = options.retryBaseDelayMilliseconds ?? 10;
    this.sleep = options.sleep ?? defaultSleep;

    if (!Number.isInteger(this.maximumAttempts) || this.maximumAttempts < 1) {
      throw new RangeError("maximumAttempts must be a positive integer");
    }
  }

  public async run<Result>(
    action: (client: PoolClient, attempt: number) => Promise<Result>,
  ): Promise<Result> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maximumAttempts; attempt += 1) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        const result = await action(client, attempt);
        await client.query("COMMIT");
        return result;
      } catch (error: unknown) {
        lastError = error;
        await client.query("ROLLBACK").catch(() => undefined);
        if (
          !isRetryableTransactionError(error) ||
          attempt === this.maximumAttempts
        ) {
          if (
            isRetryableTransactionError(error) &&
            attempt === this.maximumAttempts
          ) {
            throw new TransactionRetryExhaustedError(attempt, {
              cause: error,
            });
          }
          throw error;
        }
      } finally {
        client.release();
      }

      const exponential = this.retryBaseDelayMilliseconds * 2 ** (attempt - 1);
      const jitter = Math.floor(
        Math.random() * this.retryBaseDelayMilliseconds,
      );
      await this.sleep(exponential + jitter);
    }

    throw new TransactionRetryExhaustedError(this.maximumAttempts, {
      cause: lastError,
    });
  }
}

export function stableUuidOrder(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

export async function lockMatchRows(
  client: PoolClient,
  matchIds: readonly string[],
): Promise<void> {
  const ordered = stableUuidOrder(matchIds);
  if (ordered.length === 0) {
    return;
  }
  await client.query(
    `
      SELECT id
      FROM matches
      WHERE id = ANY($1::uuid[])
      ORDER BY id
      FOR UPDATE
    `,
    [ordered],
  );
}

export async function lockUserRows(
  client: PoolClient,
  userIds: readonly string[],
): Promise<void> {
  const ordered = stableUuidOrder(userIds);
  if (ordered.length === 0) {
    return;
  }
  await client.query(
    `
      SELECT id
      FROM users
      WHERE id = ANY($1::uuid[])
      ORDER BY id
      FOR UPDATE
    `,
    [ordered],
  );
}
