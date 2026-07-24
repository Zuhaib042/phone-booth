const MATCH_ID = "019b1000-0000-7000-8000-000000000100";
const USER_ID = "019b1000-0000-7000-8000-000000000200";

const EVENT_BASE = {
  schemaVersion: 1,
  type: "contract.fixture.delivered",
  occurredAt: "2026-07-24T12:34:56.789Z",
  matchId: MATCH_ID,
  matchVersion: 42,
  recipientCursor: 815,
} as const;

export const VALID_PLAYER_EVENT = {
  ...EVENT_BASE,
  eventId: "019b1000-0000-7000-8000-000000000001",
  audience: "player",
  recipientUserId: USER_ID,
  payload: {
    privateMessage: { body: "fixture only" },
    walletBalance: 1,
  },
} as const;

export const VALID_SHARED_EVENT = {
  ...EVENT_BASE,
  eventId: "019b1000-0000-7000-8000-000000000002",
  audience: "participants",
  payload: { fixtureVisibility: "match participants" },
} as const;

export const VALID_ACTIVE_EVENT = {
  ...EVENT_BASE,
  eventId: "019b1000-0000-7000-8000-000000000003",
  audience: "active",
  payload: { fixtureVisibility: "active contestants" },
} as const;

export const VALID_MODERATOR_EVENT = {
  ...EVENT_BASE,
  eventId: "019b1000-0000-7000-8000-000000000004",
  audience: "moderator",
  payload: {
    deviceInformation: { fixture: true },
    moderationData: { fixture: true },
  },
} as const;

export const VALID_EVENT_ENVELOPES = [
  VALID_PLAYER_EVENT,
  VALID_SHARED_EVENT,
  VALID_ACTIVE_EVENT,
  VALID_MODERATOR_EVENT,
] as const;

const PROTOCOL_ERROR_BASE = {
  schemaVersion: 1,
  type: "protocol.error",
  errorId: "019b1000-0000-7000-8000-000000000300",
  occurredAt: "2026-07-24T12:34:56.789Z",
} as const;

export const VALID_PROTOCOL_ERRORS = [
  {
    ...PROTOCOL_ERROR_BASE,
    code: "malformed_message",
    retryable: false,
  },
  {
    ...PROTOCOL_ERROR_BASE,
    code: "unsupported_schema_version",
    retryable: false,
    expectedSchemaVersion: 1,
  },
  {
    ...PROTOCOL_ERROR_BASE,
    code: "authentication_required",
    retryable: false,
  },
  {
    ...PROTOCOL_ERROR_BASE,
    code: "forbidden",
    retryable: false,
  },
  {
    ...PROTOCOL_ERROR_BASE,
    code: "rate_limited",
    retryable: true,
    retryAfterSeconds: 3,
  },
  {
    ...PROTOCOL_ERROR_BASE,
    code: "resync_required",
    retryable: true,
    resumeFromCursor: 0,
  },
  {
    ...PROTOCOL_ERROR_BASE,
    code: "internal_error",
    retryable: true,
  },
] as const;
