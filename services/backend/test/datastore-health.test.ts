import assert from "node:assert/strict";
import test from "node:test";

import {
  checkDatastores,
  type DatastoreChecks,
} from "../src/datastore-health.js";

test("datastore health performs read-only checks for both services", async () => {
  const calls: string[] = [];
  const checks: DatastoreChecks = {
    async checkPostgres(url): Promise<void> {
      calls.push(`postgres:${url}`);
    },
    async checkValkey(url): Promise<void> {
      calls.push(`valkey:${url}`);
    },
  };

  const result = await checkDatastores(
    {
      databaseUrl: "postgresql://database.example/booth",
      valkeyUrl: "redis://valkey.example:6379",
    },
    checks,
  );

  assert.deepEqual(result, { postgres: "ok", valkey: "ok" });
  assert.deepEqual(calls.sort(), [
    "postgres:postgresql://database.example/booth",
    "valkey:redis://valkey.example:6379",
  ]);
});
