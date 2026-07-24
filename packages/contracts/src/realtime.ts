import type { ErrorObject } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";

import {
  parseUtcTimestamp,
  RFC_9562_UUID_PATTERN,
} from "@project-booth/domain";

export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export const REALTIME_AUDIENCES = [
  "player",
  "participants",
  "active",
  "moderator",
] as const;

export type RealtimeAudience = (typeof REALTIME_AUDIENCES)[number];

export const CLIENT_INTERNAL_FIELD_NAMES = [
  "deviceId",
  "deviceInformation",
  "deviceRiskSignals",
  "enforcementDetails",
  "moderationData",
  "moderationNotes",
  "reportId",
] as const;

export const PLAYER_PRIVATE_FIELD_NAMES = [
  "ballotTargetId",
  "coinBalance",
  "conversation",
  "conversations",
  "messageBody",
  "offer",
  "offerAmount",
  "offers",
  "outflowAllowance",
  "pendingFunds",
  "privateMessage",
  "privateMessages",
  "submittedBallot",
  "wallet",
  "walletBalance",
] as const;

export interface ServerEventEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly matchId: string;
  readonly matchVersion: number;
  readonly recipientCursor: number;
  readonly audience: RealtimeAudience;
  readonly recipientUserId?: string;
  readonly payload: JsonObject;
}

export const PROTOCOL_ERROR_CODES = [
  "malformed_message",
  "unsupported_schema_version",
  "authentication_required",
  "forbidden",
  "rate_limited",
  "resync_required",
  "internal_error",
] as const;

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

export interface ProtocolErrorV1 {
  readonly schemaVersion: 1;
  readonly type: "protocol.error";
  readonly errorId: string;
  readonly occurredAt: string;
  readonly code: ProtocolErrorCode;
  readonly retryable: boolean;
  readonly correlationId?: string;
  readonly expectedSchemaVersion?: number;
  readonly retryAfterSeconds?: number;
  readonly resumeFromCursor?: number;
}

export interface RealtimeValidationIssue {
  readonly path: string;
  readonly rule: string;
  readonly message: string;
}

export type RealtimeContractValidation<Value> =
  | { readonly valid: true; readonly value: Value }
  | {
      readonly valid: false;
      readonly issues: readonly RealtimeValidationIssue[];
    };

const MAX_SAFE_INTEGER = 9_007_199_254_740_991;
const CANONICAL_UTC_FORMAT = "canonical-utc-milliseconds";
const IDENTIFIER_SCHEMA = {
  type: "string",
  pattern: RFC_9562_UUID_PATTERN,
} as const;
const TIMESTAMP_SCHEMA = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
  format: CANONICAL_UTC_FORMAT,
} as const;
const SEQUENCE_SCHEMA = {
  type: "integer",
  minimum: 1,
  maximum: MAX_SAFE_INTEGER,
} as const;

function safeJsonValueSchema(
  selfReference: string,
  forbiddenNames: readonly string[],
): JsonObject {
  return {
    anyOf: [
      { type: "null" },
      { type: "boolean" },
      { type: "number" },
      { type: "string", maxLength: 8_192 },
      {
        type: "array",
        maxItems: 256,
        items: { $ref: selfReference },
      },
      {
        type: "object",
        maxProperties: 128,
        propertyNames: { not: { enum: forbiddenNames } },
        additionalProperties: { $ref: selfReference },
      },
    ],
  };
}

const SHARED_FORBIDDEN_FIELD_NAMES = [
  ...CLIENT_INTERNAL_FIELD_NAMES,
  ...PLAYER_PRIVATE_FIELD_NAMES,
] as const;

export const SERVER_EVENT_ENVELOPE_V1_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:project-booth:schema:server-event-envelope:v1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "eventId",
    "type",
    "occurredAt",
    "matchId",
    "matchVersion",
    "recipientCursor",
    "audience",
    "payload",
  ],
  properties: {
    schemaVersion: { const: 1 },
    eventId: IDENTIFIER_SCHEMA,
    type: {
      type: "string",
      pattern: "^[a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*){2,}$",
      maxLength: 128,
    },
    occurredAt: TIMESTAMP_SCHEMA,
    matchId: IDENTIFIER_SCHEMA,
    matchVersion: SEQUENCE_SCHEMA,
    recipientCursor: SEQUENCE_SCHEMA,
    audience: { enum: REALTIME_AUDIENCES },
    recipientUserId: IDENTIFIER_SCHEMA,
    payload: {
      type: "object",
      maxProperties: 128,
    },
  },
  allOf: [
    {
      if: {
        type: "object",
        required: ["audience"],
        properties: { audience: { const: "player" } },
      },
      // biome-ignore lint/suspicious/noThenProperty: Draft 2020-12 requires the `then` keyword.
      then: {
        type: "object",
        required: ["recipientUserId"],
        properties: {
          recipientUserId: IDENTIFIER_SCHEMA,
          payload: { $ref: "#/$defs/playerSafeValue" },
        },
      },
      else: {
        type: "object",
        properties: { recipientUserId: false },
      },
    },
    {
      if: {
        type: "object",
        required: ["audience"],
        properties: {
          audience: { enum: ["participants", "active"] },
        },
      },
      // biome-ignore lint/suspicious/noThenProperty: Draft 2020-12 requires the `then` keyword.
      then: {
        type: "object",
        properties: {
          payload: { $ref: "#/$defs/sharedSafeValue" },
        },
      },
    },
  ],
  $defs: {
    playerSafeValue: safeJsonValueSchema(
      "#/$defs/playerSafeValue",
      CLIENT_INTERNAL_FIELD_NAMES,
    ),
    sharedSafeValue: safeJsonValueSchema(
      "#/$defs/sharedSafeValue",
      SHARED_FORBIDDEN_FIELD_NAMES,
    ),
  },
} as const;

const PROTOCOL_CONTEXT_FIELDS = [
  "expectedSchemaVersion",
  "retryAfterSeconds",
  "resumeFromCursor",
] as const;

type ProtocolContextField = (typeof PROTOCOL_CONTEXT_FIELDS)[number];

function protocolErrorVariant(
  code: ProtocolErrorCode,
  retryable: boolean,
  requiredContext?: ProtocolContextField,
): JsonObject {
  return {
    type: "object",
    ...(requiredContext === undefined ? {} : { required: [requiredContext] }),
    properties: {
      code: { const: code },
      retryable: { const: retryable },
      ...Object.fromEntries(
        PROTOCOL_CONTEXT_FIELDS.map((field) => [
          field,
          field === requiredContext,
        ]),
      ),
    },
  };
}

export const PROTOCOL_ERROR_V1_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:project-booth:schema:protocol-error:v1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "type",
    "errorId",
    "occurredAt",
    "code",
    "retryable",
  ],
  properties: {
    schemaVersion: { const: 1 },
    type: { const: "protocol.error" },
    errorId: IDENTIFIER_SCHEMA,
    occurredAt: TIMESTAMP_SCHEMA,
    code: { enum: PROTOCOL_ERROR_CODES },
    retryable: { type: "boolean" },
    correlationId: IDENTIFIER_SCHEMA,
    expectedSchemaVersion: {
      type: "integer",
      minimum: 1,
      maximum: MAX_SAFE_INTEGER,
    },
    retryAfterSeconds: {
      type: "integer",
      minimum: 1,
      maximum: 3_600,
    },
    resumeFromCursor: {
      type: "integer",
      minimum: 0,
      maximum: MAX_SAFE_INTEGER,
    },
  },
  oneOf: [
    protocolErrorVariant("malformed_message", false),
    protocolErrorVariant(
      "unsupported_schema_version",
      false,
      "expectedSchemaVersion",
    ),
    protocolErrorVariant("authentication_required", false),
    protocolErrorVariant("forbidden", false),
    protocolErrorVariant("rate_limited", true, "retryAfterSeconds"),
    protocolErrorVariant("resync_required", true, "resumeFromCursor"),
    protocolErrorVariant("internal_error", true),
  ],
} as const;

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat(CANONICAL_UTC_FORMAT, {
  type: "string",
  validate: (value: string) => parseUtcTimestamp(value).ok,
});

const validateEventSchema = ajv.compile<ServerEventEnvelopeV1>(
  SERVER_EVENT_ENVELOPE_V1_SCHEMA,
);
const validateProtocolErrorSchema = ajv.compile<ProtocolErrorV1>(
  PROTOCOL_ERROR_V1_SCHEMA,
);

function escapedPointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function validationIssues(
  errors: readonly ErrorObject[] | null | undefined,
): RealtimeValidationIssue[] {
  return (errors ?? []).map((error) => {
    const params = error.params as {
      readonly additionalProperty?: unknown;
      readonly propertyName?: unknown;
    };
    const namedProperty =
      error.keyword === "additionalProperties"
        ? params.additionalProperty
        : error.keyword === "propertyNames"
          ? params.propertyName
          : undefined;
    const path =
      typeof namedProperty === "string"
        ? `${error.instancePath}/${escapedPointerSegment(namedProperty)}`
        : error.instancePath || "/";

    return {
      path,
      rule: `schema.${error.keyword}`,
      message: error.message ?? "Schema validation failed",
    };
  });
}

export function validateServerEventEnvelopeV1(
  value: unknown,
): RealtimeContractValidation<ServerEventEnvelopeV1> {
  return validateEventSchema(value)
    ? { valid: true, value }
    : { valid: false, issues: validationIssues(validateEventSchema.errors) };
}

export function validateProtocolErrorV1(
  value: unknown,
): RealtimeContractValidation<ProtocolErrorV1> {
  return validateProtocolErrorSchema(value)
    ? { valid: true, value }
    : {
        valid: false,
        issues: validationIssues(validateProtocolErrorSchema.errors),
      };
}
