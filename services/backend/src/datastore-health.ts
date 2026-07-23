import { Client } from "pg";
import { Redis as Valkey } from "iovalkey";

import type { DatastoreConfig } from "./config.js";

export interface DatastoreHealth {
  readonly postgres: "ok";
  readonly valkey: "ok";
}

export interface DatastoreChecks {
  checkPostgres(databaseUrl: string): Promise<void>;
  checkValkey(valkeyUrl: string): Promise<void>;
}

async function checkPostgres(databaseUrl: string): Promise<void> {
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
  });

  try {
    await client.connect();
    const result = await client.query<{ healthy: number }>(
      "SELECT 1 AS healthy",
    );
    if (result.rows[0]?.healthy !== 1) {
      throw new Error("PostgreSQL health query returned an unexpected result");
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function checkValkey(valkeyUrl: string): Promise<void> {
  const client = new Valkey(valkeyUrl, {
    connectTimeout: 5_000,
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });

  try {
    await client.connect();
    if ((await client.ping()) !== "PONG") {
      throw new Error("Valkey health command returned an unexpected result");
    }
  } finally {
    client.disconnect();
  }
}

const DEFAULT_CHECKS: DatastoreChecks = {
  checkPostgres,
  checkValkey,
};

export async function checkDatastores(
  config: DatastoreConfig,
  checks: DatastoreChecks = DEFAULT_CHECKS,
): Promise<DatastoreHealth> {
  await Promise.all([
    checks.checkPostgres(config.databaseUrl),
    checks.checkValkey(config.valkeyUrl),
  ]);

  return { postgres: "ok", valkey: "ok" };
}
