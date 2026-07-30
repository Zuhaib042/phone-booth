import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign as signPayload,
  type KeyObject,
} from "node:crypto";
import test from "node:test";

import {
  AppleIdentityProvider,
  DevelopmentIdentityProvider,
  IdentityError,
  RemoteAppleKeySource,
  type AppleJsonWebKey,
} from "../src/identity/provider.js";
import {
  defaultDisplayName,
  normalizeDisplayName,
} from "../src/identity/profile.js";

const CLIENT_ID = "com.example.project-booth";
const NOW = new Date("2026-07-30T12:00:00.000Z");
const KEY_ID = "test-key";
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2_048,
});
const publicJwk = {
  ...publicKey.export({ format: "jwk" }),
  alg: "RS256",
  kid: KEY_ID,
  use: "sig",
} as AppleJsonWebKey;

function appleToken(
  key: KeyObject,
  claims: Readonly<Record<string, unknown>> = {},
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: KEY_ID, typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      aud: CLIENT_ID,
      exp: Math.floor(NOW.getTime() / 1_000) + 300,
      iat: Math.floor(NOW.getTime() / 1_000),
      iss: "https://appleid.apple.com",
      nonce: "expected-nonce",
      sub: "apple-subject",
      ...claims,
    }),
  ).toString("base64url");
  const signature = signPayload(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    key,
  ).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

const apple = new AppleIdentityProvider(CLIENT_ID, {
  async getKey(keyId) {
    return keyId === KEY_ID ? publicJwk : undefined;
  },
});

test("Apple credentials verify signature, issuer, audience, expiry, and nonce", async () => {
  const credential = appleToken(privateKey);
  const verified = await apple.verify({
    credential,
    nonce: "expected-nonce",
    now: NOW,
  });
  assert.equal(verified.provider, "apple");
  assert.equal(verified.subject, "apple-subject");
  assert.match(verified.credentialHash ?? "", /^[0-9a-f]{64}$/);

  await assert.rejects(
    apple.verify({
      credential: appleToken(privateKey, { exp: 1 }),
      now: NOW,
    }),
    (error: unknown) =>
      error instanceof IdentityError && error.code === "credential_expired",
  );
  await assert.rejects(
    apple.verify({
      credential: appleToken(privateKey, { aud: "another-app" }),
      now: NOW,
    }),
    (error: unknown) =>
      error instanceof IdentityError && error.code === "wrong_audience",
  );
  await assert.rejects(
    apple.verify({
      credential,
      nonce: "wrong-nonce",
      now: NOW,
    }),
    (error: unknown) =>
      error instanceof IdentityError && error.code === "invalid_credential",
  );
});

test("Apple credentials reject forged signatures", async () => {
  const forgedKey = generateKeyPairSync("rsa", { modulusLength: 2_048 });
  await assert.rejects(
    apple.verify({ credential: appleToken(forgedKey.privateKey), now: NOW }),
    (error: unknown) =>
      error instanceof IdentityError && error.code === "invalid_credential",
  );
});

test("Apple signing-key rotation refreshes a warm JWKS cache", async () => {
  let requests = 0;
  const rotatedKey = { ...publicJwk, kid: "rotated-key" };
  const source = new RemoteAppleKeySource(async () => {
    requests += 1;
    const keys = requests === 1 ? [publicJwk] : [rotatedKey];
    return new Response(JSON.stringify({ keys }), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  });

  assert.equal((await source.getKey(KEY_ID))?.kid, KEY_ID);
  assert.equal((await source.getKey("rotated-key"))?.kid, "rotated-key");
  assert.equal(requests, 2);
});

test("development credentials are explicit and deterministic", async () => {
  const development = new DevelopmentIdentityProvider();
  assert.deepEqual(
    await development.verify({
      credential: "dev:reviewer-1",
      now: NOW,
    }),
    { provider: "development", subject: "reviewer-1" },
  );
  await assert.rejects(
    development.verify({ credential: "reviewer-1", now: NOW }),
    (error: unknown) =>
      error instanceof IdentityError && error.code === "invalid_credential",
  );
});

test("display names normalize safely and reject unsafe identity data", () => {
  assert.equal(normalizeDisplayName("  River   Fox  "), "River Fox");
  assert.throws(
    () => normalizeDisplayName("admin"),
    (error: unknown) =>
      error instanceof IdentityError && error.code === "invalid_display_name",
  );
  assert.throws(() => normalizeDisplayName("a d m 1 n"), IdentityError);
  assert.throws(() => normalizeDisplayName("me@example.com"), IdentityError);
  assert.throws(
    () => normalizeDisplayName("https://example.com"),
    IdentityError,
  );
  assert.match(
    defaultDisplayName("019824d0-7c1a-7a91-8c4a-3fe0f1b51e22"),
    /^Player-[A-F0-9]{6}$/,
  );
});
