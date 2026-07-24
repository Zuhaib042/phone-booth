import assert from "node:assert/strict";
import test from "node:test";

import {
  validateProtocolErrorV1,
  validateServerEventEnvelopeV1,
  type RealtimeContractValidation,
} from "../src/index.js";
import {
  VALID_EVENT_ENVELOPES,
  VALID_PLAYER_EVENT,
  VALID_PROTOCOL_ERRORS,
  VALID_SHARED_EVENT,
} from "./fixtures/realtime-v1.js";

function assertInvalid(
  result: RealtimeContractValidation<unknown>,
  expectedRule?: string,
  expectedPath?: string,
): void {
  assert.equal(result.valid, false);
  if (result.valid) {
    return;
  }

  if (expectedRule !== undefined) {
    assert.equal(
      result.issues.some((issue) => issue.rule === expectedRule),
      true,
    );
  }
  if (expectedPath !== undefined) {
    assert.equal(
      result.issues.some((issue) => issue.path === expectedPath),
      true,
    );
  }
}

test("all four audiences accept valid version-one event fixtures", () => {
  for (const fixture of VALID_EVENT_ENVELOPES) {
    const result = validateServerEventEnvelopeV1(fixture);
    assert.equal(result.valid, true);
  }
});

test("the event envelope rejects malformed routing and sequence fields", () => {
  const missingRecipient = {
    ...VALID_PLAYER_EVENT,
  } as Record<string, unknown>;
  Reflect.deleteProperty(missingRecipient, "recipientUserId");

  const cases: readonly [unknown, string?][] = [
    [{ ...VALID_SHARED_EVENT, schemaVersion: 2 }, "schema.const"],
    [
      { ...VALID_SHARED_EVENT, eventId: "01J00000000000000000000000" },
      "schema.pattern",
    ],
    [
      { ...VALID_SHARED_EVENT, occurredAt: "2026-07-24T12:34:56Z" },
      "schema.pattern",
    ],
    [
      { ...VALID_SHARED_EVENT, occurredAt: "2026-02-30T12:34:56.789Z" },
      "schema.format",
    ],
    [{ ...VALID_SHARED_EVENT, matchVersion: 0 }, "schema.minimum"],
    [{ ...VALID_SHARED_EVENT, recipientCursor: 0 }, "schema.minimum"],
    [{ ...VALID_SHARED_EVENT, type: "fixture.delivered" }, "schema.pattern"],
    [{ ...VALID_SHARED_EVENT, audience: "everyone" }, "schema.enum"],
    [
      {
        ...VALID_SHARED_EVENT,
        recipientUserId: VALID_PLAYER_EVENT.recipientUserId,
      },
    ],
    [
      { ...VALID_SHARED_EVENT, transportDebug: true },
      "schema.additionalProperties",
    ],
    [missingRecipient, "schema.required"],
  ];

  for (const [fixture, expectedRule] of cases) {
    assertInvalid(validateServerEventEnvelopeV1(fixture), expectedRule);
  }
});

test("broader audiences reject private fields recursively", () => {
  const leakageCases = [
    ["ballotTargetId", { ballotTargetId: VALID_PLAYER_EVENT.recipientUserId }],
    ["privateMessage", { nested: { privateMessage: "secret" } }],
    ["offerAmount", { offerAmount: 1 }],
    ["walletBalance", { walletBalance: 1 }],
    ["deviceInformation", { deviceInformation: { model: "fixture" } }],
    ["moderationData", { moderationData: { reason: "fixture" } }],
  ] as const;

  for (const [field, payload] of leakageCases) {
    assertInvalid(
      validateServerEventEnvelopeV1({
        ...VALID_SHARED_EVENT,
        payload,
      }),
      "schema.propertyNames",
      field === "privateMessage"
        ? "/payload/nested/privateMessage"
        : `/payload/${field}`,
    );
  }

  assertInvalid(
    validateServerEventEnvelopeV1({
      ...VALID_PLAYER_EVENT,
      payload: { deviceInformation: { model: "fixture" } },
    }),
    "schema.propertyNames",
    "/payload/deviceInformation",
  );
});

test("every client-safe protocol error variant accepts its required context", () => {
  for (const fixture of VALID_PROTOCOL_ERRORS) {
    const result = validateProtocolErrorV1(fixture);
    assert.equal(result.valid, true);
  }
});

test("protocol errors reject unsafe details and inconsistent recovery fields", () => {
  const rateLimited = VALID_PROTOCOL_ERRORS[4];
  const unsupportedVersion = VALID_PROTOCOL_ERRORS[1];
  const internalError = VALID_PROTOCOL_ERRORS[6];

  const cases: readonly [unknown, string?][] = [
    [
      { ...internalError, stack: "private server stack" },
      "schema.additionalProperties",
    ],
    [
      { ...internalError, message: "database connection failed" },
      "schema.additionalProperties",
    ],
    [{ ...internalError, errorId: "not-a-uuid" }, "schema.pattern"],
    [
      { ...internalError, occurredAt: "2026-07-24T12:34:56Z" },
      "schema.pattern",
    ],
    [{ ...rateLimited, retryable: false }, "schema.oneOf"],
    [{ ...rateLimited, retryAfterSeconds: undefined }, "schema.oneOf"],
    [
      { ...unsupportedVersion, expectedSchemaVersion: undefined },
      "schema.oneOf",
    ],
    [{ ...unsupportedVersion, retryAfterSeconds: 1 }, "schema.oneOf"],
  ];

  for (const [fixture, expectedRule] of cases) {
    assertInvalid(validateProtocolErrorV1(fixture), expectedRule);
  }
});
