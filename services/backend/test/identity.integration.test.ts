import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { parseUtcTimestamp, type UtcTimestamp } from "@project-booth/domain";
import { Pool } from "pg";

import {
  IdentityError,
  type IdentityProvider,
} from "../src/identity/provider.js";
import {
  AccountDeletionHandler,
  PostgresIdentityService,
} from "../src/identity/service.js";
import { runMigrations } from "../src/persistence/migrations.js";
import {
  PostgresScheduledJobRepository,
  ScheduledJobProcessor,
} from "../src/persistence/scheduled-jobs.js";
import { PostgresTransactionRunner } from "../src/persistence/transaction.js";

const { TEST_DATABASE_URL: DATABASE_URL } = process.env;
const NOW = new Date("2026-07-30T12:00:00.000Z");
const DEVICE = {
  installationId: "019824d0-7c1a-7a91-8c4a-3fe0f1b51e23",
  platform: "test" as const,
};
const CONFIG = {
  accessTokenTtlSeconds: 900,
  accountDeletionDelaySeconds: 0,
  provider: "development" as const,
  refreshTokenTtlSeconds: 2_592_000,
};

function timestamp(value: string): UtcTimestamp {
  const parsed = parseUtcTimestamp(value);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    throw new Error("Invalid test timestamp");
  }
  return parsed.value;
}

const developmentProvider: IdentityProvider = {
  kind: "development",
  async verify({ credential }) {
    return {
      provider: "development",
      subject: credential.replace(/^dev:/u, ""),
    };
  },
};

test(
  "M5 identity, accounts, sessions, profiles, and deletion",
  { skip: DATABASE_URL === undefined },
  async () => {
    assert.notEqual(DATABASE_URL, undefined);
    const databaseUrl = DATABASE_URL as string;
    const schema = `m5_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: databaseUrl, max: 2 });
    let pool: Pool | undefined;

    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      pool = new Pool({
        connectionString: databaseUrl,
        max: 16,
        options: `-c search_path=${schema}`,
      });
      await runMigrations(pool);
      const transactions = new PostgresTransactionRunner(pool, {
        retryBaseDelayMilliseconds: 1,
      });
      const identity = new PostgresIdentityService(
        transactions,
        developmentProvider,
        CONFIG,
        () => new Date(NOW),
      );

      const duplicateInputs = [1, 2].map((suffix) => ({
        credential: "dev:same-player",
        device: {
          installationId: `019824d0-7c1a-7a91-8c4a-${suffix
            .toString()
            .padStart(12, "0")}`,
          platform: "test" as const,
        },
      }));
      const duplicates = await Promise.all(
        duplicateInputs.map((input) => identity.exchangeCredential(input)),
      );
      assert.equal(
        duplicates[0]?.account.userId,
        duplicates[1]?.account.userId,
      );
      const linkedUsers = await pool.query<{ count: string }>(
        `
          SELECT count(DISTINCT user_id)
          FROM user_identities
          WHERE provider = 'development' AND provider_subject = 'same-player'
        `,
      );
      assert.equal(linkedUsers.rows[0]?.count, "1");

      const replayProvider: IdentityProvider = {
        kind: "apple",
        async verify() {
          return {
            credentialHash: "a".repeat(64),
            provider: "apple",
            subject: "apple-subject",
          };
        },
      };
      const appleIdentity = new PostgresIdentityService(
        transactions,
        replayProvider,
        {
          ...CONFIG,
          appleClientId: "com.example.project-booth",
          provider: "apple",
        },
        () => new Date(NOW),
      );
      await appleIdentity.exchangeCredential({
        credential: "signed-credential",
        device: DEVICE,
      });
      await assert.rejects(
        appleIdentity.exchangeCredential({
          credential: "signed-credential",
          device: DEVICE,
        }),
        (error: unknown) =>
          error instanceof IdentityError &&
          error.code === "credential_replayed",
      );

      const rotating = await identity.exchangeCredential({
        credential: "dev:rotation-player",
        device: DEVICE,
      });
      const rotated = await identity.refresh(rotating.tokens.refreshToken);
      await assert.rejects(
        identity.authenticate(rotating.tokens.accessToken),
        (error: unknown) =>
          error instanceof IdentityError && error.code === "invalid_token",
      );
      assert.equal(
        (await identity.authenticate(rotated.accessToken)).userId,
        rotating.account.userId,
      );
      await assert.rejects(
        identity.refresh(rotating.tokens.refreshToken),
        (error: unknown) =>
          error instanceof IdentityError &&
          error.code === "refresh_token_reused",
      );
      await assert.rejects(
        identity.authenticate(rotated.accessToken),
        (error: unknown) =>
          error instanceof IdentityError && error.code === "invalid_token",
      );

      const profileAccount = await identity.exchangeCredential({
        credential: "dev:profile-player",
        device: DEVICE,
      });
      await assert.rejects(
        identity.updateProfile(profileAccount.account.userId, "admin"),
        (error: unknown) =>
          error instanceof IdentityError &&
          error.code === "invalid_display_name",
      );
      const profile = await identity.updateProfile(
        profileAccount.account.userId,
        "River Fox",
      );
      assert.deepEqual(
        await identity.getPublicProfile(profile.userId),
        profile,
      );
      assert.deepEqual(Object.keys(profile).toSorted(), [
        "avatarKey",
        "displayName",
        "progressionLevel",
        "userId",
      ]);

      const logoutAccount = await identity.exchangeCredential({
        credential: "dev:logout-player",
        device: DEVICE,
      });
      const logoutSession = await identity.authenticate(
        logoutAccount.tokens.accessToken,
      );
      await identity.logout(logoutSession.sessionId);
      await assert.rejects(
        identity.authenticate(logoutAccount.tokens.accessToken),
        IdentityError,
      );

      const deleted = await identity.exchangeCredential({
        credential: "dev:delete-player",
        device: DEVICE,
      });
      assert.equal(
        await identity.isMatchmakingEligible(deleted.account.userId),
        true,
      );
      assert.deepEqual(
        await identity.requestAccountDeletion(deleted.account.userId),
        { status: "pending" },
      );
      await assert.rejects(
        identity.authenticate(deleted.tokens.accessToken),
        IdentityError,
      );
      assert.equal(
        await identity.isMatchmakingEligible(deleted.account.userId),
        false,
      );

      const jobs = new PostgresScheduledJobRepository();
      const deletionHandler = new AccountDeletionHandler();
      const processor = new ScheduledJobProcessor(
        transactions,
        jobs,
        (client, job, occurredAt) =>
          deletionHandler.handle(client, job, occurredAt),
      );
      const claimed = await processor.claim({
        batchSize: 10,
        leaseMilliseconds: 30_000,
        now: NOW,
        workerId: "identity-test-worker",
      });
      const deletionJob = claimed.find(
        ({ kind }) => kind === "account.deletion",
      );
      assert.notEqual(deletionJob, undefined);
      if (deletionJob === undefined) {
        throw new Error("Deletion job was not claimed");
      }
      assert.equal(
        await processor.process(
          deletionJob,
          timestamp("2026-07-30T12:00:01.000Z"),
        ),
        true,
      );
      const tombstone = await pool.query<{
        identity_count: string;
        profile_count: string;
        session_count: string;
        status: string;
      }>(
        `
          SELECT
            users.status,
            (SELECT count(*) FROM user_identities WHERE user_id = users.id)
              AS identity_count,
            (SELECT count(*) FROM profiles WHERE user_id = users.id)
              AS profile_count,
            (SELECT count(*) FROM sessions WHERE user_id = users.id)
              AS session_count
          FROM users
          WHERE users.id = $1
        `,
        [deleted.account.userId],
      );
      assert.deepEqual(tombstone.rows[0], {
        identity_count: "0",
        profile_count: "0",
        session_count: "0",
        status: "deleted",
      });
    } finally {
      await pool?.end().catch(() => undefined);
      await admin
        .query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        .catch(() => undefined);
      await admin.end();
    }
  },
);
