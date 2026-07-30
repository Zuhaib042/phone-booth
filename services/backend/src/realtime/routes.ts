import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  authenticatedSession,
  identityErrorResponse,
} from "../identity/routes.js";
import { IdentityError } from "../identity/provider.js";
import {
  RealtimeForbiddenError,
  RealtimeNotFoundError,
  type PostgresRealtimeQueryService,
} from "./events.js";

function realtimeErrorResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  error: RealtimeForbiddenError | RealtimeNotFoundError,
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
    if (
      error instanceof RealtimeForbiddenError ||
      error instanceof RealtimeNotFoundError
    ) {
      return realtimeErrorResponse(request, reply, error);
    }
    throw error;
  }
}

export function registerRealtimeRoutes(
  api: FastifyInstance,
  identityService: Parameters<typeof authenticatedSession>[1],
  service?: PostgresRealtimeQueryService,
  resumeLimit = 100,
): void {
  api.get<{
    Params: { readonly matchId: string };
  }>(
    "/v1/matches/:matchId/snapshot",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["matchId"],
          properties: {
            matchId: { type: "string", format: "uuid" },
          },
        },
      },
    },
    (request, reply) =>
      handle(request, reply, async () => {
        const session = await authenticatedSession(request, identityService);
        if (service === undefined) {
          throw new IdentityError(
            "identity_unavailable",
            "Real-time services are not configured",
            503,
          );
        }
        return service.getSnapshot(session.userId, request.params.matchId);
      }),
  );

  api.get<{
    Querystring: { readonly afterCursor?: number };
  }>(
    "/v1/realtime/events",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            afterCursor: {
              type: "integer",
              minimum: 0,
              maximum: 9_007_199_254_740_991,
              default: 0,
            },
          },
        },
      },
    },
    (request, reply) =>
      handle(request, reply, async () => {
        const session = await authenticatedSession(request, identityService);
        if (service === undefined) {
          throw new IdentityError(
            "identity_unavailable",
            "Real-time services are not configured",
            503,
          );
        }
        return service.listEvents(
          session.userId,
          request.query.afterCursor ?? 0,
          resumeLimit,
        );
      }),
  );
}
