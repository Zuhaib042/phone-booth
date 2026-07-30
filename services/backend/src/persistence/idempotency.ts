import { createHash } from "node:crypto";

import type { UserId, UtcTimestamp } from "@project-booth/domain";
import type { PoolClient } from "pg";

import { canonicalJson, type JsonObject, type JsonValue } from "./json.js";

export interface StoredHttpResponse {
  readonly status: number;
  readonly headers: JsonObject;
  readonly body: JsonValue;
}

export type IdempotencyAcquisition =
  | { readonly acquired: true }
  | { readonly acquired: false; readonly response: StoredHttpResponse };

export interface IdempotencyIdentity {
  readonly accountId: UserId;
  readonly operation: string;
  readonly key: string;
  readonly requestHash: string;
}

interface IdempotencyRow {
  readonly request_hash: string;
  readonly response_status: number | null;
  readonly response_headers: unknown;
  readonly response_body: unknown;
  readonly completed_at: Date | null;
}

export class IdempotencyConflictError extends Error {
  public constructor(
    public readonly accountId: UserId,
    public readonly operation: string,
    public readonly key: string,
  ) {
    super("Idempotency key was already used with a different request");
    this.name = "IdempotencyConflictError";
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hashIdempotencyRequest(request: JsonValue): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

export class PostgresIdempotencyRepository {
  public async findCompleted(
    client: PoolClient,
    identity: IdempotencyIdentity,
  ): Promise<StoredHttpResponse | undefined> {
    const existing = await client.query<IdempotencyRow>(
      `
        SELECT
          request_hash,
          response_status,
          response_headers,
          response_body,
          completed_at
        FROM idempotency_keys
        WHERE
          account_id = $1
          AND operation = $2
          AND idempotency_key = $3
      `,
      [identity.accountId, identity.operation, identity.key],
    );
    const row = existing.rows[0];
    if (row === undefined) {
      return undefined;
    }
    if (row.request_hash !== identity.requestHash) {
      throw new IdempotencyConflictError(
        identity.accountId,
        identity.operation,
        identity.key,
      );
    }
    if (
      row.completed_at === null ||
      row.response_status === null ||
      !isJsonObject(row.response_headers)
    ) {
      return undefined;
    }
    return {
      status: row.response_status,
      headers: row.response_headers,
      body: row.response_body as JsonValue,
    };
  }

  public async acquire(
    client: PoolClient,
    identity: IdempotencyIdentity,
    occurredAt: UtcTimestamp,
  ): Promise<IdempotencyAcquisition> {
    const inserted = await client.query(
      `
        INSERT INTO idempotency_keys (
          account_id,
          operation,
          idempotency_key,
          request_hash,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (account_id, operation, idempotency_key) DO NOTHING
        RETURNING idempotency_key
      `,
      [
        identity.accountId,
        identity.operation,
        identity.key,
        identity.requestHash,
        occurredAt,
      ],
    );
    if (inserted.rowCount === 1) {
      return { acquired: true };
    }

    const existing = await client.query<IdempotencyRow>(
      `
        SELECT
          request_hash,
          response_status,
          response_headers,
          response_body,
          completed_at
        FROM idempotency_keys
        WHERE
          account_id = $1
          AND operation = $2
          AND idempotency_key = $3
        FOR UPDATE
      `,
      [identity.accountId, identity.operation, identity.key],
    );
    const row = existing.rows[0];
    if (row === undefined) {
      throw new Error("Idempotency record disappeared while acquiring it");
    }
    if (row.request_hash !== identity.requestHash) {
      throw new IdempotencyConflictError(
        identity.accountId,
        identity.operation,
        identity.key,
      );
    }
    if (
      row.completed_at === null ||
      row.response_status === null ||
      !isJsonObject(row.response_headers)
    ) {
      throw new Error("Idempotency record is incomplete outside its command");
    }

    return {
      acquired: false,
      response: {
        status: row.response_status,
        headers: row.response_headers,
        body: row.response_body as JsonValue,
      },
    };
  }

  public async complete(
    client: PoolClient,
    identity: IdempotencyIdentity,
    response: StoredHttpResponse,
    occurredAt: UtcTimestamp,
  ): Promise<void> {
    const result = await client.query(
      `
        UPDATE idempotency_keys
        SET
          response_status = $5,
          response_headers = $6::jsonb,
          response_body = $7::jsonb,
          completed_at = $8
        WHERE
          account_id = $1
          AND operation = $2
          AND idempotency_key = $3
          AND request_hash = $4
          AND completed_at IS NULL
      `,
      [
        identity.accountId,
        identity.operation,
        identity.key,
        identity.requestHash,
        response.status,
        JSON.stringify(response.headers),
        JSON.stringify(response.body),
        occurredAt,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error("Idempotency record could not be completed");
    }
  }
}
