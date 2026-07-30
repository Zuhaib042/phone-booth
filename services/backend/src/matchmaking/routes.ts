import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  authenticatedSession,
  identityErrorResponse,
} from "../identity/routes.js";
import { IdentityError } from "../identity/provider.js";
import { IdempotencyConflictError } from "../persistence/idempotency.js";
import {
  MatchmakingError,
  type CreateTicketInput,
  type MatchmakingApplication,
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

const TICKET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "compatibilityVersion",
    "createdAt",
    "language",
    "readyConfirmed",
    "region",
    "rulesetId",
    "rulesetVersion",
    "status",
    "ticketId",
    "updatedAt",
  ],
  properties: {
    compatibilityVersion: { type: "integer", minimum: 1 },
    createdAt: { type: "string", format: "date-time" },
    language: { type: "string" },
    matchId: { type: "string", format: "uuid" },
    proposalId: { type: "string", format: "uuid" },
    readyConfirmed: { type: "boolean" },
    readyDeadline: { type: "string", format: "date-time" },
    region: { type: "string" },
    rulesetId: { type: "string", format: "uuid" },
    rulesetVersion: { type: "integer", minimum: 1 },
    status: {
      type: "string",
      enum: ["queued", "proposed", "matched", "cancelled"],
    },
    ticketId: { type: "string", format: "uuid" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

const TICKET_PARAMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ticketId"],
  properties: {
    ticketId: { type: "string", format: "uuid" },
  },
} as const;

const IDEMPOTENCY_HEADERS_SCHEMA = {
  type: "object",
  required: ["idempotency-key"],
  properties: {
    "idempotency-key": { type: "string", format: "uuid" },
  },
} as const;

const ERROR_RESPONSES = {
  400: ERROR_RESPONSE_SCHEMA,
  401: ERROR_RESPONSE_SCHEMA,
  403: ERROR_RESPONSE_SCHEMA,
  404: ERROR_RESPONSE_SCHEMA,
  409: ERROR_RESPONSE_SCHEMA,
  503: ERROR_RESPONSE_SCHEMA,
} as const;

function matchmakingUnavailable(): MatchmakingError {
  return new MatchmakingError(
    "matchmaking_conflict",
    "Matchmaking services are not configured",
    503,
  );
}

function matchmakingErrorResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  error: MatchmakingError,
): FastifyReply {
  return reply.status(error.statusCode).send({
    error: {
      code: error.code,
      message: error.message,
      traceId: request.id,
    },
  });
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
    if (error instanceof MatchmakingError) {
      return matchmakingErrorResponse(request, reply, error);
    }
    if (error instanceof IdempotencyConflictError) {
      return matchmakingErrorResponse(
        request,
        reply,
        new MatchmakingError(
          "matchmaking_conflict",
          "The Idempotency-Key was already used for another request",
          409,
        ),
      );
    }
    throw error;
  }
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string") {
    throw new MatchmakingError(
      "matchmaking_conflict",
      "An Idempotency-Key header is required",
      400,
    );
  }
  return value;
}

function serviceOrThrow(
  service: MatchmakingApplication | undefined,
): MatchmakingApplication {
  if (service === undefined) {
    throw matchmakingUnavailable();
  }
  return service;
}

export function registerMatchmakingRoutes(
  api: FastifyInstance,
  identityService: Parameters<typeof authenticatedSession>[1],
  service?: MatchmakingApplication,
): void {
  api.post<{
    Body: CreateTicketInput;
    Headers: { readonly "idempotency-key": string };
  }>(
    "/v1/matchmaking/tickets",
    {
      schema: {
        headers: IDEMPOTENCY_HEADERS_SCHEMA,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["compatibilityVersion", "language", "region"],
          properties: {
            compatibilityVersion: {
              type: "integer",
              minimum: 1,
              maximum: 2_147_483_647,
            },
            language: {
              type: "string",
              pattern: "^[a-z]{2,3}(?:-[A-Z]{2})?$",
            },
            region: {
              type: "string",
              pattern: "^[a-z0-9][a-z0-9-]{0,31}$",
            },
          },
        },
        response: {
          200: TICKET_SCHEMA,
          201: TICKET_SCHEMA,
          ...ERROR_RESPONSES,
        },
      },
    },
    (request, reply) =>
      handle(request, reply, async () => {
        const session = await authenticatedSession(request, identityService);
        const result = await serviceOrThrow(service).createTicket(
          session.userId,
          idempotencyKey(request),
          request.body,
        );
        void reply.header("Idempotency-Replayed", result.replayed);
        return reply.status(result.responseStatus).send(result.ticket);
      }),
  );

  api.get<{ Params: { readonly ticketId: string } }>(
    "/v1/matchmaking/tickets/:ticketId",
    {
      schema: {
        params: TICKET_PARAMS_SCHEMA,
        response: { 200: TICKET_SCHEMA, ...ERROR_RESPONSES },
      },
    },
    (request, reply) =>
      handle(request, reply, async () => {
        const session = await authenticatedSession(request, identityService);
        return serviceOrThrow(service).getTicket(
          session.userId,
          request.params.ticketId,
        );
      }),
  );

  for (const command of ["cancel", "ready"] as const) {
    api.post<{
      Headers: { readonly "idempotency-key": string };
      Params: { readonly ticketId: string };
    }>(
      `/v1/matchmaking/tickets/:ticketId/${command}`,
      {
        schema: {
          headers: IDEMPOTENCY_HEADERS_SCHEMA,
          params: TICKET_PARAMS_SCHEMA,
          response: { 200: TICKET_SCHEMA, ...ERROR_RESPONSES },
        },
      },
      (request, reply) =>
        handle(request, reply, async () => {
          const session = await authenticatedSession(request, identityService);
          const application = serviceOrThrow(service);
          const result =
            command === "cancel"
              ? await application.cancelTicket(
                  session.userId,
                  request.params.ticketId,
                  idempotencyKey(request),
                )
              : await application.confirmReady(
                  session.userId,
                  request.params.ticketId,
                  idempotencyKey(request),
                );
          void reply.header("Idempotency-Replayed", result.replayed);
          return reply.status(result.responseStatus).send(result.ticket);
        }),
    );
  }
}
