import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool, PoolClient } from "pg";

const MIGRATION_NAME_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;
const MIGRATION_LOCK_ID = 7_447_114_024_001;

export interface Migration {
  readonly name: string;
  readonly checksum: string;
  readonly sql: string;
}

export interface MigrationStatus {
  readonly applied: readonly string[];
  readonly pending: readonly string[];
}

export class MigrationChecksumError extends Error {
  public constructor(public readonly migrationName: string) {
    super(`Applied migration checksum changed: ${migrationName}`);
    this.name = "MigrationChecksumError";
  }
}

export function defaultMigrationsDirectory(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../migrations",
  );
}

export async function readMigrations(
  directory = defaultMigrationsDirectory(),
): Promise<readonly Migration[]> {
  const names = (await readdir(directory))
    .filter((name) => MIGRATION_NAME_PATTERN.test(name))
    .sort();
  const migrations = await Promise.all(
    names.map(async (name) => {
      const sql = await readFile(resolve(directory, name), "utf8");
      return {
        name,
        checksum: createHash("sha256").update(sql).digest("hex"),
        sql,
      };
    }),
  );

  if (migrations.length === 0) {
    throw new Error(`No migrations found in ${directory}`);
  }
  return migrations;
}

async function ensureMigrationTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `);
}

async function appliedMigrations(
  client: PoolClient,
): Promise<ReadonlyMap<string, string>> {
  const result = await client.query<{ name: string; checksum: string }>(
    "SELECT name, checksum FROM schema_migrations ORDER BY name",
  );
  return new Map(result.rows.map(({ name, checksum }) => [name, checksum]));
}

async function withMigrationLock<T>(
  pool: Pool,
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    return await action(client);
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID])
      .catch(() => undefined);
    client.release();
  }
}

function verifyChecksums(
  migrations: readonly Migration[],
  applied: ReadonlyMap<string, string>,
): void {
  for (const migration of migrations) {
    const checksum = applied.get(migration.name);
    if (checksum !== undefined && checksum !== migration.checksum) {
      throw new MigrationChecksumError(migration.name);
    }
  }
}

export async function migrationStatus(
  pool: Pool,
  directory?: string,
): Promise<MigrationStatus> {
  const migrations = await readMigrations(directory);
  return withMigrationLock(pool, async (client) => {
    await ensureMigrationTable(client);
    const applied = await appliedMigrations(client);
    verifyChecksums(migrations, applied);
    return {
      applied: migrations
        .filter(({ name }) => applied.has(name))
        .map(({ name }) => name),
      pending: migrations
        .filter(({ name }) => !applied.has(name))
        .map(({ name }) => name),
    };
  });
}

export async function runMigrations(
  pool: Pool,
  directory?: string,
): Promise<MigrationStatus> {
  const migrations = await readMigrations(directory);
  return withMigrationLock(pool, async (client) => {
    await ensureMigrationTable(client);
    let applied = await appliedMigrations(client);
    verifyChecksums(migrations, applied);

    for (const migration of migrations) {
      if (applied.has(migration.name)) {
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
          [migration.name, migration.checksum],
        );
        await client.query("COMMIT");
      } catch (error: unknown) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }

    applied = await appliedMigrations(client);
    return {
      applied: migrations
        .filter(({ name }) => applied.has(name))
        .map(({ name }) => name),
      pending: migrations
        .filter(({ name }) => !applied.has(name))
        .map(({ name }) => name),
    };
  });
}
