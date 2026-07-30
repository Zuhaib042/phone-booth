import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  authenticatedSession,
  identityErrorResponse,
} from "../identity/routes.js";
import { IdentityError } from "../identity/provider.js";
import { IdempotencyConflictError } from "../persistence/idempotency.js";
import {
  ChatError,
  type ChatApplication,
  type ReportCategory,
  type SendMessageInput,
} from "./service.js";

const ERROR_SCHEMA = {
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

const IDEMPOTENCY_HEADERS_SCHEMA = {
  type: "object",
  required: ["idempotency-key"],
  properties: {
    "idempotency-key": { type: "string", format: "uuid" },
  },
} as const;

const MATCH_PARAMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["matchId"],
  properties: { matchId: { type: "string", format: "uuid" } },
} as const;

const THREAD_PARAMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["matchId", "threadId"],
  properties: {
    matchId: { type: "string", format: "uuid" },
    threadId: { type: "string", format: "uuid" },
  },
} as const;

const USER_PARAMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["matchId", "subjectUserId"],
  properties: {
    matchId: { type: "string", format: "uuid" },
    subjectUserId: { type: "string", format: "uuid" },
  },
} as const;

const MESSAGE_PARAMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["matchId", "messageId"],
  properties: {
    matchId: { type: "string", format: "uuid" },
    messageId: { type: "string", format: "uuid" },
  },
} as const;

const MESSAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "body",
    "kind",
    "messageId",
    "recipientUserId",
    "senderUserId",
    "sentAt",
    "threadId",
  ],
  properties: {
    body: { type: "string" },
    kind: { type: "string", enum: ["typed", "quick_phrase"] },
    messageId: { type: "string", format: "uuid" },
    quickPhraseKey: { type: "string" },
    recipientUserId: { type: "string", format: "uuid" },
    senderUserId: { type: "string", format: "uuid" },
    sentAt: { type: "string", format: "date-time" },
    threadId: { type: "string", format: "uuid" },
  },
} as const;

const ATTEMPT_SCHEMA = {
  ...MESSAGE_SCHEMA,
  required: [...MESSAGE_SCHEMA.required, "deliveryStatus"],
  properties: {
    ...MESSAGE_SCHEMA.properties,
    deliveryStatus: {
      type: "string",
      enum: [
        "blocked",
        "delivered",
        "provider_unavailable",
        "rate_limited",
        "recipient_unavailable",
      ],
    },
  },
} as const;

const THREAD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "blocked",
    "createdAt",
    "matchId",
    "muted",
    "otherUser",
    "threadId",
  ],
  properties: {
    blocked: { type: "boolean" },
    createdAt: { type: "string", format: "date-time" },
    matchId: { type: "string", format: "uuid" },
    muted: { type: "boolean" },
    otherUser: {
      type: "object",
      additionalProperties: false,
      required: ["avatarKey", "displayName", "userId"],
      properties: {
        avatarKey: { type: "string" },
        displayName: { type: "string" },
        userId: { type: "string", format: "uuid" },
      },
    },
    threadId: { type: "string", format: "uuid" },
  },
} as const;

const SAFETY_COMMAND_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["active", "matchId", "subjectUserId"],
  properties: {
    active: { type: "boolean" },
    matchId: { type: "string", format: "uuid" },
    subjectUserId: { type: "string", format: "uuid" },
  },
} as const;

const REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "category",
    "kind",
    "matchId",
    "reportId",
    "status",
    "subjectUserId",
  ],
  properties: {
    category: { type: "string" },
    kind: { type: "string", enum: ["message", "user"] },
    matchId: { type: "string", format: "uuid" },
    reportId: { type: "string", format: "uuid" },
    status: { type: "string", const: "queued" },
    subjectUserId: { type: "string", format: "uuid" },
  },
} as const;

const ERROR_RESPONSES = {
  400: ERROR_SCHEMA,
  401: ERROR_SCHEMA,
  403: ERROR_SCHEMA,
  404: ERROR_SCHEMA,
  409: ERROR_SCHEMA,
} as const;

function serviceOrThrow(service: ChatApplication | undefined): ChatApplication {
  if (service === undefined) {
    throw new ChatError("chat_closed", "Chat services are not configured", 503);
  }
  return service;
}

function idempotencyKey(request: FastifyRequest): string {
  const key = request.headers["idempotency-key"];
  if (typeof key !== "string") {
    throw new ChatError(
      "invalid_message",
      "An Idempotency-Key header is required",
      400,
    );
  }
  return key;
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
    const chatError =
      error instanceof IdempotencyConflictError
        ? new ChatError(
            "invalid_message",
            "The Idempotency-Key was already used for another request",
            409,
          )
        : error;
    if (chatError instanceof ChatError) {
      return reply.status(chatError.statusCode).send({
        error: {
          code: chatError.code,
          message: chatError.message,
          traceId: request.id,
        },
      });
    }
    throw error;
  }
}

function reportBodySchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["category"],
    properties: {
      category: {
        type: "string",
        enum: [
          "harassment",
          "hate",
          "other",
          "self_harm",
          "sexual",
          "spam",
          "threat",
        ],
      },
    },
  } as const;
}

export function registerChatRoutes(
  api: FastifyInstance,
  identityService: Parameters<typeof authenticatedSession>[1],
  service?: ChatApplication,
): void {
  api.get(
    "/v1/chat/quick-phrases",
    {
      schema: {
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["quickPhrases"],
            properties: {
              quickPhrases: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["key", "text"],
                  properties: {
                    key: { type: "string" },
                    text: { type: "string" },
                  },
                },
              },
            },
          },
          ...ERROR_RESPONSES,
          503: ERROR_SCHEMA,
        },
      },
    },
    (request, reply) =>
      handle(request, reply, async () => {
        await authenticatedSession(request, identityService);
        return {
          quickPhrases: serviceOrThrow(service).listQuickPhrases(),
        };
      }),
  );

  api.get<{ Params: { readonly matchId: string } }>(
    "/v1/matches/:matchId/chat/threads",
    {
      schema: {
        params: MATCH_PARAMS_SCHEMA,
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["threads"],
            properties: {
              threads: { type: "array", items: THREAD_SCHEMA },
            },
          },
          ...ERROR_RESPONSES,
          503: ERROR_SCHEMA,
        },
      },
    },
    (request, reply) =>
      handle(request, reply, async () => {
        const session = await authenticatedSession(request, identityService);
        return {
          threads: await serviceOrThrow(service).listThreads(
            session.userId,
            request.params.matchId,
          ),
        };
      }),
  );

  api.get<{
    Params: { readonly matchId: string; readonly threadId: string };
    Querystring: { readonly afterMessageId?: string; readonly limit?: number };
  }>(
    "/v1/matches/:matchId/chat/threads/:threadId/messages",
    {
      schema: {
        params: THREAD_PARAMS_SCHEMA,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            afterMessageId: { type: "string", format: "uuid" },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 100,
              default: 50,
            },
          },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["hasMore", "messages"],
            properties: {
              hasMore: { type: "boolean" },
              messages: { type: "array", items: MESSAGE_SCHEMA },
            },
          },
          ...ERROR_RESPONSES,
          503: ERROR_SCHEMA,
        },
      },
    },
    (request, reply) =>
      handle(request, reply, async () => {
        const session = await authenticatedSession(request, identityService);
        return serviceOrThrow(service).listMessages(
          session.userId,
          request.params.matchId,
          request.params.threadId,
          request.query.afterMessageId,
          request.query.limit,
        );
      }),
  );

  api.post<{
    Body: SendMessageInput;
    Headers: { readonly "idempotency-key": string };
    Params: { readonly matchId: string; readonly threadId: string };
  }>(
    "/v1/matches/:matchId/chat/threads/:threadId/messages",
    {
      schema: {
        headers: IDEMPOTENCY_HEADERS_SCHEMA,
        params: THREAD_PARAMS_SCHEMA,
        body: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["kind", "text"],
              properties: {
                kind: { type: "string", const: "typed" },
                text: { type: "string", minLength: 1, maxLength: 2_048 },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["kind", "quickPhraseKey"],
              properties: {
                kind: { type: "string", const: "quick_phrase" },
                quickPhraseKey: { type: "string", minLength: 1, maxLength: 64 },
              },
            },
          ],
        },
        response: {
          201: ATTEMPT_SCHEMA,
          422: ATTEMPT_SCHEMA,
          429: ATTEMPT_SCHEMA,
          503: { anyOf: [ATTEMPT_SCHEMA, ERROR_SCHEMA] },
          ...ERROR_RESPONSES,
          409: { anyOf: [ATTEMPT_SCHEMA, ERROR_SCHEMA] },
        },
      },
    },
    (request, reply) =>
      handle(request, reply, async () => {
        const session = await authenticatedSession(request, identityService);
        const result = await serviceOrThrow(service).sendMessage(
          session.userId,
          request.params.matchId,
          request.params.threadId,
          idempotencyKey(request),
          request.body,
        );
        void reply.header("Idempotency-Replayed", result.replayed);
        return reply.status(result.responseStatus).send(result.value);
      }),
  );

  for (const command of ["mute", "block"] as const) {
    api.post<{
      Headers: { readonly "idempotency-key": string };
      Params: { readonly matchId: string; readonly subjectUserId: string };
    }>(
      `/v1/matches/:matchId/chat/users/:subjectUserId/${command}`,
      {
        schema: {
          headers: IDEMPOTENCY_HEADERS_SCHEMA,
          params: USER_PARAMS_SCHEMA,
          response: {
            200: SAFETY_COMMAND_SCHEMA,
            ...ERROR_RESPONSES,
            503: ERROR_SCHEMA,
          },
        },
      },
      (request, reply) =>
        handle(request, reply, async () => {
          const session = await authenticatedSession(request, identityService);
          const application = serviceOrThrow(service);
          const result =
            command === "mute"
              ? await application.muteUser(
                  session.userId,
                  request.params.matchId,
                  request.params.subjectUserId,
                  idempotencyKey(request),
                )
              : await application.blockUser(
                  session.userId,
                  request.params.matchId,
                  request.params.subjectUserId,
                  idempotencyKey(request),
                );
          void reply.header("Idempotency-Replayed", result.replayed);
          return reply.status(result.responseStatus).send(result.value);
        }),
    );
  }

  api.post<{
    Body: { readonly category: ReportCategory };
    Headers: { readonly "idempotency-key": string };
    Params: { readonly matchId: string; readonly messageId: string };
  }>(
    "/v1/matches/:matchId/chat/messages/:messageId/report",
    {
      schema: {
        headers: IDEMPOTENCY_HEADERS_SCHEMA,
        params: MESSAGE_PARAMS_SCHEMA,
        body: reportBodySchema(),
        response: {
          201: REPORT_SCHEMA,
          ...ERROR_RESPONSES,
          503: ERROR_SCHEMA,
        },
      },
    },
    (request, reply) =>
      handle(request, reply, async () => {
        const session = await authenticatedSession(request, identityService);
        const result = await serviceOrThrow(service).reportMessage(
          session.userId,
          request.params.matchId,
          request.params.messageId,
          request.body.category,
          idempotencyKey(request),
        );
        void reply.header("Idempotency-Replayed", result.replayed);
        return reply.status(result.responseStatus).send(result.value);
      }),
  );

  api.post<{
    Body: { readonly category: ReportCategory };
    Headers: { readonly "idempotency-key": string };
    Params: { readonly matchId: string; readonly subjectUserId: string };
  }>(
    "/v1/matches/:matchId/chat/users/:subjectUserId/report",
    {
      schema: {
        headers: IDEMPOTENCY_HEADERS_SCHEMA,
        params: USER_PARAMS_SCHEMA,
        body: reportBodySchema(),
        response: {
          201: REPORT_SCHEMA,
          ...ERROR_RESPONSES,
          503: ERROR_SCHEMA,
        },
      },
    },
    (request, reply) =>
      handle(request, reply, async () => {
        const session = await authenticatedSession(request, identityService);
        const result = await serviceOrThrow(service).reportUser(
          session.userId,
          request.params.matchId,
          request.params.subjectUserId,
          request.body.category,
          idempotencyKey(request),
        );
        void reply.header("Idempotency-Replayed", result.replayed);
        return reply.status(result.responseStatus).send(result.value);
      }),
  );
}
