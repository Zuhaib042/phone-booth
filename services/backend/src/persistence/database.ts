import { Pool, type PoolConfig } from "pg";

export interface DatabasePoolOptions {
  readonly connectionString: string;
  readonly applicationName: string;
  readonly maximumConnections?: number;
}

export function createDatabasePool(options: DatabasePoolOptions): Pool {
  const config: PoolConfig = {
    application_name: options.applicationName,
    connectionString: options.connectionString,
    idleTimeoutMillis: 30_000,
    max: options.maximumConnections ?? 10,
    statement_timeout: 15_000,
  };

  return new Pool(config);
}
