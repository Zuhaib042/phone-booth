import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { IdentityError, type IdentityErrorCode } from "./provider.js";
import type {
  AuthenticatedSession,
  DeviceInput,
  IdentityApplication,
} from "./service.js";

const ERROR_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["error"],
  properties: {
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message", "traceId"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        traceId: { type: "string" },
      },
    },
  },
} as const;

const PUBLIC_PROFILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["avatarKey", "displayName", "progressionLevel", "userId"],
  properties: {
    avatarKey: { type: "string" },
    displayName: { type: "string" },
    progressionLevel: { type: "integer" },
    userId: { type: "string", format: "uuid" },
  },
} as const;

const ACCOUNT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["deletionStatus", "profile", "status", "userId"],
  properties: {
    deletionStatus: {
      type: "string",
      enum: ["none", "pending", "completed"],
    },
    profile: PUBLIC_PROFILE_SCHEMA,
    status: {
      type: "string",
      enum: ["active", "deletion_pending", "deleted"],
    },
    userId: { type: "string", format: "uuid" },
  },
} as const;

const TOKEN_PAIR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "accessToken",
    "accessTokenExpiresAt",
    "refreshToken",
    "refreshTokenExpiresAt",
    "tokenType",
  ],
  properties: {
    accessToken: { type: "string" },
    accessTokenExpiresAt: { type: "string", format: "date-time" },
    refreshToken: { type: "string" },
    refreshTokenExpiresAt: { type: "string", format: "date-time" },
    tokenType: { type: "string", const: "Bearer" },
  },
} as const;

function identityUnavailable(): IdentityError {
  return new IdentityError(
    "identity_unavailable",
    "Identity services are not configured",
    503,
  );
}

export function identityErrorResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  error: IdentityError,
): FastifyReply {
  if (error.statusCode === 401) {
    void reply.header("WWW-Authenticate", "Bearer");
  }
  return reply.status(error.statusCode).send({
    error: {
      code: error.code,
      message: error.message,
      traceId: request.id,
    },
  });
}

function bearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  const match =
    typeof authorization === "string"
      ? /^Bearer ([^\s]+)$/.exec(authorization)
      : null;
  if (match?.[1] === undefined) {
    throw new IdentityError(
      "invalid_token",
      "A valid Bearer access token is required",
      401,
    );
  }
  return match[1];
}

export async function authenticatedSession(
  request: FastifyRequest,
  service: IdentityApplication | undefined,
): Promise<AuthenticatedSession> {
  if (service === undefined) {
    throw identityUnavailable();
  }
  return service.authenticate(bearerToken(request));
}

async function handle<Result>(
  request: FastifyRequest,
  reply: FastifyReply,
  action: () => Promise<Result>,
): Promise<Result | FastifyReply> {
  try {
    return await action();
  } catch (error: unknown) {
    if (error instanceof IdentityError) {
      return identityErrorResponse(request, reply, error);
    }
    throw error;
  }
}

const ERROR_RESPONSES = {
  400: ERROR_RESPONSE_SCHEMA,
  401: ERROR_RESPONSE_SCHEMA,
  403: ERROR_RESPONSE_SCHEMA,
  404: ERROR_RESPONSE_SCHEMA,
  409: ERROR_RESPONSE_SCHEMA,
  503: ERROR_RESPONSE_SCHEMA,
} as const;

export function registerIdentityRoutes(
  api: FastifyInstance,
  service?: IdentityApplication,
): void {
  api.post<{
    Body: {
      readonly credential: string;
      readonly device: DeviceInput;
      readonly nonce?: string;
    };
  }>(
    "/v1/auth/exchange",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["credential", "device"],
          properties: {
            credential: { type: "string", minLength: 1, maxLength: 8_192 },
            nonce: { type: "string", minLength: 1, maxLength: 128 },
            device: {
              type: "object",
              additionalProperties: false,
              required: ["installationId", "platform"],
              properties: {
                installationId: { type: "string", format: "uuid" },
                platform: { type: "string", enum: ["ios", "test"] },
                appVersion: { type: "string", minLength: 1, maxLength: 64 },
              },
            },
          },
        },
        response: {
          201: {
            type: "object",
            additionalProperties: false,
            required: ["account", "tokens"],
            properties: {
              account: ACCOUNT_SCHEMA,
              tokens: TOKEN_PAIR_SCHEMA,
            },
          },
          ...ERROR_RESPONSES,
        },
      },
    },
    (request, reply) =>
      handle(request, reply, async () => {
        if (service === undefined) {
          throw identityUnavailable();
        }
        const input =
          request.body.nonce === undefined
            ? {
                credential: request.body.credential,
                device: request.body.device,
              }
            : request.body;
        const result = await service.exchangeCredential(input);
        return reply.status(201).send(result);
      }),
  );

  api.post<{ Body: { readonly refreshToken: string } }>(
    "/v1/auth/refresh",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["refreshToken"],
          properties: {
            refreshToken: { type: "string", minLength: 1, maxLength: 256 },
          },
        },
        response: { 200: TOKEN_PAIR_SCHEMA, ...ERROR_RESPONSES },
      },
    },
    (request, reply) =>
      handle(request, reply, async () => {
        if (service === undefined) {
          throw identityUnavailable();
        }
        return service.refresh(request.body.refreshToken);
      }),
  );

  api.post(
    "/v1/auth/logout",
    {
      schema: {
        response: { 204: { type: "null" }, ...ERROR_RESPONSES },
      },
    },
    (request, reply) =>
      handle(request, reply, async () => {
        const session = await authenticatedSession(request, service);
        await service?.logout(session.sessionId);
        return reply.status(204).send();
      }),
  );

  api.get(
    "/v1/account",
    {
      schema: {
        response: { 200: ACCOUNT_SCHEMA, ...ERROR_RESPONSES },
      },
    },
    (request, reply) =>
      handle(request, reply, async () => {
        const session = await authenticatedSession(request, service);
        return service?.getAccount(session.userId);
      }),
  );

  api.delete(
    "/v1/account",
    {
      schema: {
        response: {
          202: {
            type: "object",
            additionalProperties: false,
            required: ["status"],
            properties: {
              status: { type: "string", enum: ["pending", "completed"] },
            },
          },
          ...ERROR_RESPONSES,
        },
      },
    },
    (request, reply) =>
      handle(request, reply, async () => {
        const session = await authenticatedSession(request, service);
        const result = await service?.requestAccountDeletion(session.userId);
        return reply.status(202).send(result);
      }),
  );

  api.patch<{ Body: { readonly displayName: string } }>(
    "/v1/profile",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["displayName"],
          properties: {
            displayName: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
        response: { 200: PUBLIC_PROFILE_SCHEMA, ...ERROR_RESPONSES },
      },
    },
    (request, reply) =>
      handle(request, reply, async () => {
        const session = await authenticatedSession(request, service);
        return service?.updateProfile(session.userId, request.body.displayName);
      }),
  );

  api.get<{ Params: { readonly userId: string } }>(
    "/v1/profiles/:userId",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["userId"],
          properties: {
            userId: { type: "string", format: "uuid" },
          },
        },
        response: { 200: PUBLIC_PROFILE_SCHEMA, ...ERROR_RESPONSES },
      },
    },
    (request, reply) =>
      handle(request, reply, async () => {
        await authenticatedSession(request, service);
        return service?.getPublicProfile(request.params.userId);
      }),
  );
}

export function identityErrorCode(
  error: unknown,
): IdentityErrorCode | undefined {
  return error instanceof IdentityError ? error.code : undefined;
}
