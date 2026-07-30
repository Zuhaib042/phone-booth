import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import type { IdentityConfig } from "../config.js";
import type { ClaimedScheduledJob } from "../persistence/scheduled-jobs.js";
import type { PostgresTransactionRunner } from "../persistence/transaction.js";
import { defaultDisplayName, normalizeDisplayName } from "./profile.js";
import {
  IdentityError,
  type IdentityProvider,
  type VerifiedIdentity,
} from "./provider.js";

export interface DeviceInput {
  readonly appVersion?: string;
  readonly installationId: string;
  readonly platform: "ios" | "test";
}

export interface TokenPair {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: string;
  readonly tokenType: "Bearer";
}

export interface PublicProfile {
  readonly avatarKey: string;
  readonly displayName: string;
  readonly progressionLevel: number;
  readonly userId: string;
}

export interface AccountView {
  readonly deletionStatus: "none" | "pending" | "completed";
  readonly profile: PublicProfile;
  readonly status: "active" | "deleted" | "deletion_pending";
  readonly userId: string;
}

export interface AuthenticatedSession {
  readonly sessionId: string;
  readonly userId: string;
}

export interface ExchangeResult {
  readonly account: AccountView;
  readonly tokens: TokenPair;
}

export interface IdentityApplication {
  authenticate(accessToken: string): Promise<AuthenticatedSession>;
  exchangeCredential(input: {
    readonly credential: string;
    readonly device: DeviceInput;
    readonly nonce?: string;
  }): Promise<ExchangeResult>;
  getAccount(userId: string): Promise<AccountView>;
  getPublicProfile(userId: string): Promise<PublicProfile>;
  logout(sessionId: string): Promise<void>;
  refresh(refreshToken: string): Promise<TokenPair>;
  requestAccountDeletion(userId: string): Promise<{
    readonly status: "completed" | "pending";
  }>;
  updateProfile(userId: string, displayName: string): Promise<PublicProfile>;
}

interface IdentityServiceConfig {
  readonly accessTokenTtlSeconds: number;
  readonly accountDeletionDelaySeconds: number;
  readonly refreshTokenTtlSeconds: number;
}

interface TokenMaterial extends TokenPair {
  readonly accessTokenHash: string;
  readonly refreshTokenHash: string;
}

interface AccountRow {
  readonly avatar_key: string;
  readonly deletion_status: "completed" | "none" | "pending";
  readonly display_name: string;
  readonly progression_level: number;
  readonly status: "active" | "deleted" | "deletion_pending";
  readonly user_id: string;
}

interface SessionRow {
  readonly refresh_expires_at: Date;
  readonly refresh_token_hash: string;
  readonly reuse_detected: boolean;
  readonly revoked_at: Date | null;
  readonly session_id: string;
  readonly status: "active" | "deleted" | "deletion_pending";
  readonly user_id: string;
}

function token(prefix: "pb_at_" | "pb_rt_"): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function tokenHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1_000);
}

function toPublicProfile(row: AccountRow): PublicProfile {
  return {
    avatarKey: row.avatar_key,
    displayName: row.display_name,
    progressionLevel: row.progression_level,
    userId: row.user_id,
  };
}

function toAccount(row: AccountRow): AccountView {
  return {
    deletionStatus: row.deletion_status,
    profile: toPublicProfile(row),
    status: row.status,
    userId: row.user_id,
  };
}

function issueTokenMaterial(
  now: Date,
  config: IdentityServiceConfig,
): TokenMaterial {
  const accessToken = token("pb_at_");
  const refreshToken = token("pb_rt_");
  return {
    accessToken,
    accessTokenExpiresAt: addSeconds(
      now,
      config.accessTokenTtlSeconds,
    ).toISOString(),
    accessTokenHash: tokenHash(accessToken),
    refreshToken,
    refreshTokenExpiresAt: addSeconds(
      now,
      config.refreshTokenTtlSeconds,
    ).toISOString(),
    refreshTokenHash: tokenHash(refreshToken),
    tokenType: "Bearer",
  };
}

function publicTokenPair(material: TokenMaterial): TokenPair {
  return {
    accessToken: material.accessToken,
    accessTokenExpiresAt: material.accessTokenExpiresAt,
    refreshToken: material.refreshToken,
    refreshTokenExpiresAt: material.refreshTokenExpiresAt,
    tokenType: material.tokenType,
  };
}

function invalidToken(): IdentityError {
  return new IdentityError(
    "invalid_token",
    "The authentication token is invalid or expired",
    401,
  );
}

async function loadAccount(
  client: PoolClient,
  userId: string,
): Promise<AccountRow | undefined> {
  const result = await client.query<AccountRow>(
    `
      SELECT
        users.id AS user_id,
        users.status,
        profiles.display_name,
        profiles.avatar_key,
        profiles.progression_level,
        CASE
          WHEN deletion.status = 'completed' THEN 'completed'
          WHEN deletion.status IN ('pending', 'processing') THEN 'pending'
          ELSE 'none'
        END AS deletion_status
      FROM users
      JOIN profiles ON profiles.user_id = users.id
      LEFT JOIN account_deletion_requests AS deletion
        ON deletion.user_id = users.id
      WHERE users.id = $1
    `,
    [userId],
  );
  return result.rows[0];
}

export class PostgresIdentityService implements IdentityApplication {
  private readonly config: IdentityServiceConfig;

  public constructor(
    private readonly transactions: PostgresTransactionRunner,
    private readonly provider: IdentityProvider,
    config: Exclude<IdentityConfig, { readonly provider: "disabled" }>,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.config = config;
  }

  public async exchangeCredential(input: {
    readonly credential: string;
    readonly device: DeviceInput;
    readonly nonce?: string;
  }): Promise<ExchangeResult> {
    const now = this.clock();
    const verificationInput =
      input.nonce === undefined
        ? { credential: input.credential, now }
        : { credential: input.credential, nonce: input.nonce, now };
    const identity = await this.provider.verify(verificationInput);
    const material = issueTokenMaterial(now, this.config);
    const outcome = await this.transactions.run(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${identity.provider}:${identity.subject}`],
      );
      if (
        identity.credentialHash !== undefined &&
        (await this.credentialWasConsumed(client, identity.credentialHash))
      ) {
        return { kind: "replay" as const };
      }

      const userId = await this.findOrCreateUser(client, identity, now);
      const account = await loadAccount(client, userId);
      if (account === undefined || account.status !== "active") {
        return { kind: "unavailable" as const };
      }
      if (identity.credentialHash !== undefined) {
        await client.query(
          `
            INSERT INTO provider_credentials (
              credential_hash,
              identity_id,
              consumed_at
            )
            SELECT $1, id, $4
            FROM user_identities
            WHERE provider = $2 AND provider_subject = $3
          `,
          [identity.credentialHash, identity.provider, identity.subject, now],
        );
      }

      const deviceId = randomUUID();
      const device = await client.query<{ id: string }>(
        `
          INSERT INTO devices (
            id,
            user_id,
            installation_id,
            platform,
            app_version,
            created_at,
            last_seen_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $6)
          ON CONFLICT (user_id, installation_id)
          DO UPDATE SET
            platform = EXCLUDED.platform,
            app_version = EXCLUDED.app_version,
            last_seen_at = EXCLUDED.last_seen_at
          RETURNING id
        `,
        [
          deviceId,
          userId,
          input.device.installationId,
          input.device.platform,
          input.device.appVersion ?? null,
          now,
        ],
      );
      await client.query(
        `
          INSERT INTO sessions (
            id,
            user_id,
            device_id,
            access_token_hash,
            access_expires_at,
            refresh_token_hash,
            refresh_expires_at,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
        `,
        [
          randomUUID(),
          userId,
          device.rows[0]?.id,
          material.accessTokenHash,
          material.accessTokenExpiresAt,
          material.refreshTokenHash,
          material.refreshTokenExpiresAt,
          now,
        ],
      );
      return { account: toAccount(account), kind: "success" as const };
    });

    if (outcome.kind === "replay") {
      throw new IdentityError(
        "credential_replayed",
        "The identity credential has already been exchanged",
        409,
      );
    }
    if (outcome.kind === "unavailable") {
      throw new IdentityError(
        "account_unavailable",
        "This account is unavailable",
        403,
      );
    }
    return {
      account: outcome.account,
      tokens: publicTokenPair(material),
    };
  }

  private async credentialWasConsumed(
    client: PoolClient,
    credentialHash: string,
  ): Promise<boolean> {
    const result = await client.query(
      "SELECT credential_hash FROM provider_credentials WHERE credential_hash = $1",
      [credentialHash],
    );
    return result.rowCount === 1;
  }

  private async findOrCreateUser(
    client: PoolClient,
    identity: VerifiedIdentity,
    now: Date,
  ): Promise<string> {
    const existing = await client.query<{ user_id: string }>(
      `
        UPDATE user_identities
        SET last_authenticated_at = $3
        WHERE provider = $1 AND provider_subject = $2
        RETURNING user_id
      `,
      [identity.provider, identity.subject, now],
    );
    if (existing.rows[0] !== undefined) {
      return existing.rows[0].user_id;
    }

    const userId = randomUUID();
    await client.query("INSERT INTO users (id, created_at) VALUES ($1, $2)", [
      userId,
      now,
    ]);
    await client.query(
      `
        INSERT INTO user_identities (
          id,
          user_id,
          provider,
          provider_subject,
          created_at,
          last_authenticated_at
        )
        VALUES ($1, $2, $3, $4, $5, $5)
      `,
      [randomUUID(), userId, identity.provider, identity.subject, now],
    );
    await client.query(
      `
        INSERT INTO profiles (
          user_id,
          display_name,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $3)
      `,
      [userId, defaultDisplayName(userId), now],
    );
    return userId;
  }

  public async refresh(refreshToken: string): Promise<TokenPair> {
    if (!refreshToken.startsWith("pb_rt_")) {
      throw invalidToken();
    }
    const now = this.clock();
    const hash = tokenHash(refreshToken);
    const material = issueTokenMaterial(now, this.config);
    const outcome = await this.transactions.run(async (client) => {
      const result = await client.query<SessionRow>(
        `
          SELECT
            sessions.id AS session_id,
            sessions.user_id,
            sessions.refresh_token_hash,
            sessions.refresh_expires_at,
            sessions.revoked_at,
            users.status,
            EXISTS (
              SELECT 1
              FROM session_refresh_tokens
              WHERE
                session_refresh_tokens.session_id = sessions.id
                AND session_refresh_tokens.token_hash = $1
            ) AS reuse_detected
          FROM sessions
          JOIN users ON users.id = sessions.user_id
          WHERE
            sessions.refresh_token_hash = $1
            OR EXISTS (
              SELECT 1
              FROM session_refresh_tokens
              WHERE
                session_refresh_tokens.session_id = sessions.id
                AND session_refresh_tokens.token_hash = $1
            )
          FOR UPDATE OF sessions
        `,
        [hash],
      );
      const session = result.rows[0];
      if (session === undefined) {
        return "invalid" as const;
      }
      if (session.reuse_detected) {
        await client.query(
          `
            UPDATE sessions
            SET
              revoked_at = COALESCE(revoked_at, $2),
              reuse_detected_at = CASE WHEN id = $1 THEN $2 ELSE reuse_detected_at END,
              updated_at = $2
            WHERE user_id = $3
          `,
          [session.session_id, now, session.user_id],
        );
        return "reused" as const;
      }
      if (
        session.revoked_at !== null ||
        session.status !== "active" ||
        session.refresh_expires_at.getTime() <= now.getTime()
      ) {
        return "invalid" as const;
      }

      await client.query(
        `
          INSERT INTO session_refresh_tokens (
            token_hash,
            session_id,
            rotated_at
          )
          VALUES ($1, $2, $3)
        `,
        [session.refresh_token_hash, session.session_id, now],
      );
      await client.query(
        `
          UPDATE sessions
          SET
            access_token_hash = $2,
            access_expires_at = $3,
            refresh_token_hash = $4,
            refresh_expires_at = $5,
            updated_at = $6
          WHERE id = $1
        `,
        [
          session.session_id,
          material.accessTokenHash,
          material.accessTokenExpiresAt,
          material.refreshTokenHash,
          material.refreshTokenExpiresAt,
          now,
        ],
      );
      return "rotated" as const;
    });

    if (outcome === "reused") {
      throw new IdentityError(
        "refresh_token_reused",
        "Refresh token reuse was detected and all account sessions were revoked",
        401,
      );
    }
    if (outcome === "invalid") {
      throw invalidToken();
    }
    return publicTokenPair(material);
  }

  public async authenticate(
    accessToken: string,
  ): Promise<AuthenticatedSession> {
    if (!accessToken.startsWith("pb_at_")) {
      throw invalidToken();
    }
    const now = this.clock();
    const result = await this.transactions.run((client) =>
      client.query<{ session_id: string; user_id: string }>(
        `
          SELECT sessions.id AS session_id, sessions.user_id
          FROM sessions
          JOIN users ON users.id = sessions.user_id
          WHERE
            sessions.access_token_hash = $1
            AND sessions.access_expires_at > $2
            AND sessions.revoked_at IS NULL
            AND users.status = 'active'
        `,
        [tokenHash(accessToken), now],
      ),
    );
    const session = result.rows[0];
    if (session === undefined) {
      throw invalidToken();
    }
    return {
      sessionId: session.session_id,
      userId: session.user_id,
    };
  }

  public async logout(sessionId: string): Promise<void> {
    const now = this.clock();
    await this.transactions.run(async (client) => {
      await client.query(
        `
          UPDATE sessions
          SET revoked_at = COALESCE(revoked_at, $2), updated_at = $2
          WHERE id = $1
        `,
        [sessionId, now],
      );
    });
  }

  public async getAccount(userId: string): Promise<AccountView> {
    const account = await this.transactions.run((client) =>
      loadAccount(client, userId),
    );
    if (account === undefined) {
      throw new IdentityError(
        "account_unavailable",
        "This account is unavailable",
        404,
      );
    }
    return toAccount(account);
  }

  public async getPublicProfile(userId: string): Promise<PublicProfile> {
    const account = await this.transactions.run((client) =>
      loadAccount(client, userId),
    );
    if (account === undefined || account.status !== "active") {
      throw new IdentityError(
        "account_unavailable",
        "This profile is unavailable",
        404,
      );
    }
    return toPublicProfile(account);
  }

  public async updateProfile(
    userId: string,
    displayName: string,
  ): Promise<PublicProfile> {
    const normalized = normalizeDisplayName(displayName);
    const now = this.clock();
    const account = await this.transactions.run(async (client) => {
      const updated = await client.query(
        `
          UPDATE profiles
          SET display_name = $2, updated_at = $3
          FROM users
          WHERE
            profiles.user_id = $1
            AND users.id = profiles.user_id
            AND users.status = 'active'
        `,
        [userId, normalized, now],
      );
      if (updated.rowCount !== 1) {
        return undefined;
      }
      return loadAccount(client, userId);
    });
    if (account === undefined) {
      throw new IdentityError(
        "account_unavailable",
        "This account is unavailable",
        403,
      );
    }
    return toPublicProfile(account);
  }

  public async requestAccountDeletion(
    userId: string,
  ): Promise<{ readonly status: "completed" | "pending" }> {
    const now = this.clock();
    return this.transactions.run(async (client) => {
      const user = await client.query<{ status: string }>(
        "SELECT status FROM users WHERE id = $1 FOR UPDATE",
        [userId],
      );
      const status = user.rows[0]?.status;
      if (status === undefined) {
        throw new IdentityError(
          "account_unavailable",
          "This account is unavailable",
          404,
        );
      }
      if (status === "deleted") {
        return { status: "completed" as const };
      }
      await client.query(
        `
          UPDATE users
          SET
            status = 'deletion_pending',
            deletion_requested_at = COALESCE(deletion_requested_at, $2)
          WHERE id = $1
        `,
        [userId, now],
      );
      await client.query(
        `
          UPDATE sessions
          SET revoked_at = COALESCE(revoked_at, $2), updated_at = $2
          WHERE user_id = $1
        `,
        [userId, now],
      );
      await client.query(
        `
          INSERT INTO account_deletion_requests (
            user_id,
            status,
            requested_at
          )
          VALUES ($1, 'pending', $2)
          ON CONFLICT (user_id) DO NOTHING
        `,
        [userId, now],
      );
      const jobId = randomUUID();
      await client.query(
        `
          INSERT INTO scheduled_jobs (
            id,
            kind,
            deduplication_key,
            payload,
            run_at,
            created_at,
            updated_at
          )
          VALUES (
            $1,
            $2,
            $3,
            jsonb_build_object('userId', $4::text),
            $5,
            $6,
            $6
          )
          ON CONFLICT (deduplication_key) DO NOTHING
        `,
        [
          jobId,
          ACCOUNT_DELETION_JOB_KIND,
          `account-deletion:${userId}`,
          userId,
          addSeconds(now, this.config.accountDeletionDelaySeconds),
          now,
        ],
      );
      return { status: "pending" as const };
    });
  }

  public async isMatchmakingEligible(userId: string): Promise<boolean> {
    return this.transactions.run(async (client) => {
      const result = await client.query(
        "SELECT id FROM users WHERE id = $1 AND status = 'active'",
        [userId],
      );
      return result.rowCount === 1;
    });
  }
}

export const ACCOUNT_DELETION_JOB_KIND = "account.deletion";

export class AccountDeletionHandler {
  public async handle(
    client: PoolClient,
    job: ClaimedScheduledJob,
    occurredAt: string,
  ): Promise<void> {
    if (job.kind !== ACCOUNT_DELETION_JOB_KIND) {
      throw new Error(`Unsupported scheduled job kind: ${job.kind}`);
    }
    const { userId } = job.payload;
    if (typeof userId !== "string") {
      throw new Error("Account deletion job has an invalid userId");
    }

    const request = await client.query<{ status: string }>(
      `
        UPDATE account_deletion_requests
        SET status = 'processing'
        WHERE user_id = $1 AND status = 'pending'
        RETURNING status
      `,
      [userId],
    );
    if (request.rowCount === 0) {
      return;
    }
    await client.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM devices WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM user_identities WHERE user_id = $1", [
      userId,
    ]);
    await client.query("DELETE FROM profiles WHERE user_id = $1", [userId]);
    await client.query(
      `
        UPDATE users
        SET status = 'deleted', deleted_at = $2
        WHERE id = $1 AND status = 'deletion_pending'
      `,
      [userId, occurredAt],
    );
    await client.query(
      `
        UPDATE account_deletion_requests
        SET status = 'completed', completed_at = $2
        WHERE user_id = $1
      `,
      [userId, occurredAt],
    );
  }
}
