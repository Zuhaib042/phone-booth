import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";

import type { IdentityConfig } from "../config.js";

export type IdentityProviderKind = "apple" | "development";

export interface VerifyCredentialInput {
  readonly credential: string;
  readonly nonce?: string;
  readonly now: Date;
}

export interface VerifiedIdentity {
  readonly credentialHash?: string;
  readonly provider: IdentityProviderKind;
  readonly subject: string;
}

export interface IdentityProvider {
  readonly kind: IdentityProviderKind;
  verify(input: VerifyCredentialInput): Promise<VerifiedIdentity>;
}

export type IdentityErrorCode =
  | "account_unavailable"
  | "credential_expired"
  | "credential_replayed"
  | "identity_unavailable"
  | "invalid_credential"
  | "invalid_display_name"
  | "invalid_token"
  | "refresh_token_reused"
  | "wrong_audience";

export class IdentityError extends Error {
  public constructor(
    public readonly code: IdentityErrorCode,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "IdentityError";
  }
}

function invalidCredential(message = "The identity credential is invalid") {
  return new IdentityError("invalid_credential", message, 401);
}

function parseJsonSegment(segment: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(segment, "base64url").toString("utf8"),
    );
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("JWT segment is not an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw invalidCredential();
  }
}

function stringClaim(payload: Record<string, unknown>, name: string): string {
  const value = payload[name];
  if (typeof value !== "string" || value.length === 0) {
    throw invalidCredential();
  }
  return value;
}

export interface AppleJsonWebKey extends JsonWebKey {
  readonly alg?: string;
  readonly kid: string;
  readonly use?: string;
}

export interface AppleKeySource {
  getKey(keyId: string): Promise<AppleJsonWebKey | undefined>;
}

interface AppleKeysResponse {
  readonly keys: readonly AppleJsonWebKey[];
}

function isAppleKey(value: unknown): value is AppleJsonWebKey {
  return (
    value !== null &&
    typeof value === "object" &&
    "kid" in value &&
    typeof value.kid === "string" &&
    value.kid.length > 0 &&
    "kty" in value &&
    typeof value.kty === "string"
  );
}

export class RemoteAppleKeySource implements AppleKeySource {
  private cachedAt = 0;
  private keys: readonly AppleJsonWebKey[] = [];

  public constructor(
    private readonly fetchKeys: typeof fetch = fetch,
    private readonly cacheMilliseconds = 3_600_000,
  ) {}

  public async getKey(keyId: string): Promise<AppleJsonWebKey | undefined> {
    const now = Date.now();
    let refreshed = false;
    if (now - this.cachedAt >= this.cacheMilliseconds) {
      await this.refresh(now);
      refreshed = true;
    }
    let key = this.keys.find(({ kid }) => kid === keyId);
    if (key === undefined && !refreshed) {
      await this.refresh(now);
      key = this.keys.find(({ kid }) => kid === keyId);
    }
    return key;
  }

  private async refresh(now: number): Promise<void> {
    try {
      const response = await this.fetchKeys(
        "https://appleid.apple.com/auth/keys",
        { signal: AbortSignal.timeout(5_000) },
      );
      if (!response.ok) {
        throw new Error(`Apple JWKS returned HTTP ${response.status}`);
      }
      const body = (await response.json()) as Partial<AppleKeysResponse>;
      if (!Array.isArray(body.keys) || !body.keys.every(isAppleKey)) {
        throw new TypeError("Apple JWKS response is malformed");
      }
      this.keys = body.keys;
      this.cachedAt = now;
    } catch (error: unknown) {
      if (error instanceof IdentityError) {
        throw error;
      }
      throw new IdentityError(
        "identity_unavailable",
        "Apple identity verification is temporarily unavailable",
        503,
      );
    }
  }
}

export class AppleIdentityProvider implements IdentityProvider {
  public readonly kind = "apple" as const;

  public constructor(
    private readonly clientId: string,
    private readonly keys: AppleKeySource = new RemoteAppleKeySource(),
  ) {}

  public async verify(input: VerifyCredentialInput): Promise<VerifiedIdentity> {
    const segments = input.credential.split(".");
    if (segments.length !== 3) {
      throw invalidCredential();
    }
    const [encodedHeader, encodedPayload, encodedSignature] = segments;
    if (
      encodedHeader === undefined ||
      encodedPayload === undefined ||
      encodedSignature === undefined
    ) {
      throw invalidCredential();
    }

    const header = parseJsonSegment(encodedHeader);
    const payload = parseJsonSegment(encodedPayload);
    const { alg } = header;
    const {
      aud: audience,
      exp: expiresAt,
      iat: issuedAt,
      iss,
      nonce,
    } = payload;
    if (alg !== "RS256") {
      throw invalidCredential();
    }
    const keyId = stringClaim(header, "kid");
    const key = await this.keys.getKey(keyId);
    if (
      key === undefined ||
      key.kty !== "RSA" ||
      (key.alg !== undefined && key.alg !== "RS256") ||
      (key.use !== undefined && key.use !== "sig")
    ) {
      throw invalidCredential();
    }

    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey({ format: "jwk", key });
    } catch {
      throw invalidCredential();
    }
    const validSignature = verifySignature(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      publicKey,
      Buffer.from(encodedSignature, "base64url"),
    );
    if (!validSignature || iss !== "https://appleid.apple.com") {
      throw invalidCredential();
    }

    const audienceMatches =
      audience === this.clientId ||
      (Array.isArray(audience) && audience.includes(this.clientId));
    if (!audienceMatches) {
      throw new IdentityError(
        "wrong_audience",
        "The Apple credential was issued for another application",
        401,
      );
    }

    const nowSeconds = Math.floor(input.now.getTime() / 1_000);
    if (typeof expiresAt !== "number" || expiresAt <= nowSeconds) {
      throw new IdentityError(
        "credential_expired",
        "The Apple credential has expired",
        401,
      );
    }
    if (
      typeof issuedAt !== "number" ||
      issuedAt > nowSeconds + 60 ||
      expiresAt <= issuedAt
    ) {
      throw invalidCredential();
    }
    if (
      input.nonce !== undefined &&
      (nonce !== input.nonce || input.nonce.length === 0)
    ) {
      throw invalidCredential("The Apple credential nonce does not match");
    }

    const subject = stringClaim(payload, "sub");
    if (subject.length > 255) {
      throw invalidCredential();
    }
    return {
      credentialHash: createHash("sha256")
        .update(input.credential)
        .digest("hex"),
      provider: "apple",
      subject,
    };
  }
}

export class DevelopmentIdentityProvider implements IdentityProvider {
  public readonly kind = "development" as const;

  public async verify(input: VerifyCredentialInput): Promise<VerifiedIdentity> {
    const match = /^dev:([A-Za-z0-9._-]{1,128})$/.exec(input.credential);
    if (match?.[1] === undefined) {
      throw invalidCredential(
        "Development credentials must use the dev:<subject> format",
      );
    }
    return {
      provider: "development",
      subject: match[1],
    };
  }
}

export function createIdentityProvider(
  config: Exclude<IdentityConfig, { readonly provider: "disabled" }>,
  appleKeys?: AppleKeySource,
): IdentityProvider {
  if (config.provider === "development") {
    return new DevelopmentIdentityProvider();
  }
  return new AppleIdentityProvider(config.appleClientId, appleKeys);
}
