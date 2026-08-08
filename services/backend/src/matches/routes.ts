import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  authenticatedSession,
  identityErrorResponse,
} from "../identity/routes.js";
import { IdentityError } from "../identity/provider.js";
import { IdempotencyConflictError } from "../persistence/idempotency.js";
import {
  MatchApplicationError,
  type PostgresMatchApplication,
} from "./service.js";

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
    if (error instanceof MatchApplicationError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          traceId: request.id,
        },
      });
    }
    if (error instanceof IdempotencyConflictError) {
      return reply.status(409).send({
        error: {
          code: "idempotency_conflict",
          message: "The Idempotency-Key was already used for another request",
          traceId: request.id,
        },
      });
    }
    throw error;
  }
}

export function registerMatchRoutes(
  api: FastifyInstance,
  identityService: Parameters<typeof authenticatedSession>[1],
  service?: PostgresMatchApplication,
): void {
  api.post<{
    Headers: { readonly "idempotency-key": string };
    Params: { readonly matchId: string };
  }>(
    "/v1/matches/:matchId/ready",
    {
      schema: {
        headers: {
          type: "object",
          required: ["idempotency-key"],
          properties: {
            "idempotency-key": { type: "string", format: "uuid" },
          },
        },
        params: {
          type: "object",
          additionalProperties: false,
          required: ["matchId"],
          properties: { matchId: { type: "string", format: "uuid" } },
        },
      },
    },
    (request, reply) =>
      handle(request, reply, async () => {
        const session = await authenticatedSession(request, identityService);
        if (service === undefined) {
          throw new IdentityError(
            "identity_unavailable",
            "Match services are not configured",
            503,
          );
        }
        return service.confirmBoothReady(
          session.userId,
          request.params.matchId,
          request.headers["idempotency-key"],
        );
      }),
  );

  api.post<{
    Body: { readonly targetUserId: string };
    Headers: { readonly "idempotency-key": string };
    Params: { readonly matchId: string };
  }>(
    "/v1/matches/:matchId/ballot",
    {
      schema: {
        headers: {
          type: "object",
          required: ["idempotency-key"],
          properties: {
            "idempotency-key": { type: "string", format: "uuid" },
          },
        },
        params: {
          type: "object",
          additionalProperties: false,
          required: ["matchId"],
          properties: { matchId: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["targetUserId"],
          properties: {
            targetUserId: { type: "string", format: "uuid" },
          },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["matchId", "matchVersion", "revision", "submitted"],
            properties: {
              matchId: { type: "string", format: "uuid" },
              matchVersion: { type: "integer", minimum: 1 },
              revision: { type: "integer", minimum: 1 },
              submitted: { type: "boolean", const: true },
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
            "Match services are not configured",
            503,
          );
        }
        return service.submitNormalBallot(
          session.userId,
          request.params.matchId,
          request.body.targetUserId,
          request.headers["idempotency-key"],
        );
      }),
  );

  api.post<{
    Body: { readonly targetUserId: string };
    Headers: { readonly "idempotency-key": string };
    Params: { readonly matchId: string };
  }>(
    "/v1/matches/:matchId/runoff-ballot",
    {
      schema: {
        headers: {
          type: "object",
          required: ["idempotency-key"],
          properties: { "idempotency-key": { type: "string", format: "uuid" } },
        },
        params: {
          type: "object",
          additionalProperties: false,
          required: ["matchId"],
          properties: { matchId: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["targetUserId"],
          properties: { targetUserId: { type: "string", format: "uuid" } },
        },
      },
    },
    (request, reply) =>
      handle(request, reply, async () => {
        const session = await authenticatedSession(request, identityService);
        if (service === undefined) {
          throw new IdentityError(
            "identity_unavailable",
            "Match services are not configured",
            503,
          );
        }
        return service.submitRunoffBallot(
          session.userId,
          request.params.matchId,
          request.body.targetUserId,
          request.headers["idempotency-key"],
        );
      }),
  );

  api.post<{
    Body: { readonly text: string };
    Headers: { readonly "idempotency-key": string };
    Params: { readonly matchId: string };
  }>(
    "/v1/matches/:matchId/final-plea",
    {
      schema: {
        headers: {
          type: "object",
          required: ["idempotency-key"],
          properties: { "idempotency-key": { type: "string", format: "uuid" } },
        },
        params: {
          type: "object",
          additionalProperties: false,
          required: ["matchId"],
          properties: { matchId: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["text"],
          properties: {
            text: { type: "string", minLength: 1, maxLength: 240 },
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
            "Match services are not configured",
            503,
          );
        }
        return service.submitFinalPlea(
          session.userId,
          request.params.matchId,
          request.body.text,
          request.headers["idempotency-key"],
        );
      }),
  );

  api.post<{
    Body: { readonly finalistUserId: string };
    Headers: { readonly "idempotency-key": string };
    Params: { readonly matchId: string };
  }>(
    "/v1/matches/:matchId/jury-ballot",
    {
      schema: {
        headers: {
          type: "object",
          required: ["idempotency-key"],
          properties: { "idempotency-key": { type: "string", format: "uuid" } },
        },
        params: {
          type: "object",
          additionalProperties: false,
          required: ["matchId"],
          properties: { matchId: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["finalistUserId"],
          properties: { finalistUserId: { type: "string", format: "uuid" } },
        },
      },
    },
    (request, reply) =>
      handle(request, reply, async () => {
        const session = await authenticatedSession(request, identityService);
        if (service === undefined) {
          throw new IdentityError(
            "identity_unavailable",
            "Match services are not configured",
            503,
          );
        }
        return service.submitJuryBallot(
          session.userId,
          request.params.matchId,
          request.body.finalistUserId,
          request.headers["idempotency-key"],
        );
      }),
  );

  api.get<{ Params: { readonly matchId: string } }>(
    "/v1/matches/:matchId/dossier",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["matchId"],
          properties: { matchId: { type: "string", format: "uuid" } },
        },
      },
    },
    (request, reply) =>
      handle(request, reply, async () => {
        const session = await authenticatedSession(request, identityService);
        if (service === undefined) {
          throw new IdentityError(
            "identity_unavailable",
            "Match services are not configured",
            503,
          );
        }
        return service.dossier(session.userId, request.params.matchId);
      }),
  );
}
