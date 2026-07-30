import assert from "node:assert/strict";
import test from "node:test";

import { buildApi } from "../src/app.js";
import type { ApiConfig } from "../src/config.js";
import type {
  AccountView,
  IdentityApplication,
  PublicProfile,
} from "../src/identity/service.js";

const TEST_CONFIG: ApiConfig = {
  host: "127.0.0.1",
  logLevel: "silent",
  nodeEnvironment: "test",
  port: 0,
};

test("GET /health/live reports that the API process is alive", async (context) => {
  const api = buildApi(TEST_CONFIG, { logger: false });
  context.after(async () => api.close());

  const response = await api.inject({
    method: "GET",
    url: "/health/live",
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] ?? "", /^application\/json/);
  assert.deepEqual(response.json(), { status: "ok" });
});

const PROFILE: PublicProfile = {
  avatarKey: "avatar.default",
  displayName: "River Fox",
  progressionLevel: 1,
  userId: "019824d0-7c1a-7a91-8c4a-3fe0f1b51e22",
};
const ACCOUNT: AccountView = {
  deletionStatus: "none",
  profile: PROFILE,
  status: "active",
  userId: PROFILE.userId,
};
const fakeIdentity: IdentityApplication = {
  async authenticate(accessToken) {
    assert.equal(accessToken, "pb_at_test");
    return { sessionId: "session-1", userId: PROFILE.userId };
  },
  async exchangeCredential() {
    return {
      account: ACCOUNT,
      tokens: {
        accessToken: "pb_at_test",
        accessTokenExpiresAt: "2026-07-30T12:15:00.000Z",
        refreshToken: "pb_rt_test",
        refreshTokenExpiresAt: "2026-08-29T12:00:00.000Z",
        tokenType: "Bearer",
      },
    };
  },
  async getAccount() {
    return ACCOUNT;
  },
  async getPublicProfile() {
    return PROFILE;
  },
  async logout() {},
  async refresh() {
    throw new Error("not used");
  },
  async requestAccountDeletion() {
    return { status: "pending" };
  },
  async updateProfile() {
    return PROFILE;
  },
};

test("identity routes expose account-safe projections", async (context) => {
  const api = buildApi(TEST_CONFIG, {
    identityService: fakeIdentity,
    logger: false,
  });
  context.after(async () => api.close());

  const exchange = await api.inject({
    method: "POST",
    url: "/v1/auth/exchange",
    payload: {
      credential: "dev:reviewer",
      device: {
        installationId: "019824d0-7c1a-7a91-8c4a-3fe0f1b51e23",
        platform: "test",
      },
    },
  });
  assert.equal(exchange.statusCode, 201);
  assert.deepEqual(exchange.json().account, ACCOUNT);

  const profile = await api.inject({
    method: "GET",
    url: `/v1/profiles/${PROFILE.userId}`,
    headers: { authorization: "Bearer pb_at_test" },
  });
  assert.equal(profile.statusCode, 200);
  assert.deepEqual(profile.json(), PROFILE);
  assert.equal("provider" in profile.json(), false);
  assert.equal("credential" in profile.json(), false);
});

test("identity routes fail closed when identity is disabled", async (context) => {
  const api = buildApi(TEST_CONFIG, { logger: false });
  context.after(async () => api.close());

  const response = await api.inject({
    method: "POST",
    url: "/v1/auth/refresh",
    payload: { refreshToken: "pb_rt_test" },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "identity_unavailable");
});

test("identity validation failures use the safe error contract", async (context) => {
  const api = buildApi(TEST_CONFIG, {
    identityService: fakeIdentity,
    logger: false,
  });
  context.after(async () => api.close());

  const response = await api.inject({
    method: "POST",
    url: "/v1/auth/exchange",
    payload: {
      credential: "dev:reviewer",
      device: { installationId: "not-a-uuid", platform: "test" },
    },
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: {
      code: "invalid_request",
      message: "The request is malformed or fails validation",
      traceId: response.json().error.traceId,
    },
  });
});
