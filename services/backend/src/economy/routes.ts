import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  authenticatedSession,
  identityErrorResponse,
} from "../identity/routes.js";
import { IdentityError } from "../identity/provider.js";
import { IdempotencyConflictError } from "../persistence/idempotency.js";
import {
  EconomyError,
  type CreateBribeOfferInput,
  type PostgresEconomyService,
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

const OFFER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "amount",
    "createdAt",
    "expiresAt",
    "matchId",
    "offerId",
    "recipientUserId",
    "requestedTargetUserId",
    "roundNumber",
    "senderUserId",
    "state",
  ],
  properties: {
    amount: { type: "integer", minimum: 1 },
    createdAt: { type: "string", format: "date-time" },
    expiresAt: { type: "string", format: "date-time" },
    filteredMessage: { type: "string", minLength: 1, maxLength: 240 },
    matchId: { type: "string", format: "uuid" },
    offerId: { type: "string", format: "uuid" },
    recipientUserId: { type: "string", format: "uuid" },
    requestedTargetUserId: { type: "string", format: "uuid" },
    roundNumber: { type: "integer", minimum: 1 },
    senderUserId: { type: "string", format: "uuid" },
    state: {
      type: "string",
      enum: [
        "accepted",
        "declined",
        "expired",
        "pending",
        "reversed",
        "settled",
      ],
    },
  },
} as const;

const WALLET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pending", "reserved", "restricted", "spendable"],
  properties: {
    matchAllowance: {
      type: "object",
      additionalProperties: false,
      required: ["acceptedOutflow", "cap", "remaining"],
      properties: {
        acceptedOutflow: { type: "integer", minimum: 0 },
        cap: { type: "integer", minimum: 1 },
        remaining: { type: "integer", minimum: 0 },
      },
    },
    pending: { type: "integer", minimum: 0 },
    reserved: { type: "integer", minimum: 0 },
    restricted: { type: "boolean" },
    spendable: { type: "integer", minimum: 0 },
  },
} as const;

function serviceOrThrow(
  service: PostgresEconomyService | undefined,
): PostgresEconomyService {
  if (service === undefined) {
    throw new EconomyError(
      "economy_forbidden",
      "Economy fixture values are disabled",
      503,
    );
  }
  return service;
}

function idempotencyKey(request: FastifyRequest): string {
  const key = request.headers["idempotency-key"];
  if (typeof key !== "string") {
    throw new EconomyError(
      "invalid_offer",
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
    const economyError =
      error instanceof IdempotencyConflictError
        ? new EconomyError(
            "invalid_offer",
            "The Idempotency-Key was already used for another request",
            409,
          )
        : error;
    if (economyError instanceof EconomyError) {
      return reply.status(economyError.statusCode).send({
        error: {
          code: economyError.code,
          message: economyError.message,
          traceId: request.id,
        },
      });
    }
    throw error;
  }
}

export function registerEconomyRoutes(
  api: FastifyInstance,
  identityService: Parameters<typeof authenticatedSession>[1],
  service?: PostgresEconomyService,
): void {
  api.get<{ Querystring: { readonly matchId?: string } }>(
    "/v1/economy/wallet",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            matchId: { type: "string", format: "uuid" },
          },
        },
        response: {
          200: WALLET_SCHEMA,
          400: ERROR_SCHEMA,
          401: ERROR_SCHEMA,
          403: ERROR_SCHEMA,
          404: ERROR_SCHEMA,
          503: ERROR_SCHEMA,
        },
      },
    },
    (request, reply) =>
      handle(request, reply, async () => {
        const session = await authenticatedSession(request, identityService);
        return serviceOrThrow(service).wallet(
          session.userId,
          request.query.matchId,
        );
      }),
  );

  api.get<{ Params: { readonly matchId: string } }>(
    "/v1/matches/:matchId/bribes",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["matchId"],
          properties: { matchId: { type: "string", format: "uuid" } },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["offers"],
            properties: { offers: { type: "array", items: OFFER_SCHEMA } },
          },
          400: ERROR_SCHEMA,
          401: ERROR_SCHEMA,
          403: ERROR_SCHEMA,
          404: ERROR_SCHEMA,
          503: ERROR_SCHEMA,
        },
      },
    },
    (request, reply) =>
      handle(request, reply, async () => {
        const session = await authenticatedSession(request, identityService);
        return {
          offers: await serviceOrThrow(service).listBribeOffers(
            session.userId,
            request.params.matchId,
          ),
        };
      }),
  );

  api.post<{
    Body: CreateBribeOfferInput;
    Headers: { readonly "idempotency-key": string };
    Params: { readonly matchId: string };
  }>(
    "/v1/matches/:matchId/bribes",
    {
      schema: {
        headers: IDEMPOTENCY_HEADERS_SCHEMA,
        params: {
          type: "object",
          additionalProperties: false,
          required: ["matchId"],
          properties: { matchId: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["amount", "recipientUserId", "requestedTargetUserId"],
          properties: {
            amount: { type: "integer", minimum: 1 },
            message: { type: "string", minLength: 1, maxLength: 2_048 },
            recipientUserId: { type: "string", format: "uuid" },
            requestedTargetUserId: { type: "string", format: "uuid" },
          },
        },
        response: {
          200: OFFER_SCHEMA,
          201: OFFER_SCHEMA,
          400: ERROR_SCHEMA,
          401: ERROR_SCHEMA,
          403: ERROR_SCHEMA,
          404: ERROR_SCHEMA,
          409: ERROR_SCHEMA,
          422: ERROR_SCHEMA,
          503: ERROR_SCHEMA,
        },
      },
    },
    (request, reply) =>
      handle(request, reply, async () => {
        const session = await authenticatedSession(request, identityService);
        const result = await serviceOrThrow(service).createBribeOffer(
          session.userId,
          request.params.matchId,
          idempotencyKey(request),
          request.body,
        );
        void reply.header("Idempotency-Replayed", result.replayed);
        return reply.status(result.responseStatus).send(result.value);
      }),
  );

  for (const command of ["accept", "decline"] as const) {
    api.post<{
      Headers: { readonly "idempotency-key": string };
      Params: { readonly offerId: string };
    }>(
      `/v1/bribes/:offerId/${command}`,
      {
        schema: {
          headers: IDEMPOTENCY_HEADERS_SCHEMA,
          params: {
            type: "object",
            additionalProperties: false,
            required: ["offerId"],
            properties: { offerId: { type: "string", format: "uuid" } },
          },
          response: {
            200: OFFER_SCHEMA,
            400: ERROR_SCHEMA,
            401: ERROR_SCHEMA,
            403: ERROR_SCHEMA,
            404: ERROR_SCHEMA,
            409: ERROR_SCHEMA,
            503: ERROR_SCHEMA,
          },
        },
      },
      (request, reply) =>
        handle(request, reply, async () => {
          const session = await authenticatedSession(request, identityService);
          const application = serviceOrThrow(service);
          const result =
            command === "accept"
              ? await application.acceptBribeOffer(
                  session.userId,
                  request.params.offerId,
                  idempotencyKey(request),
                )
              : await application.declineBribeOffer(
                  session.userId,
                  request.params.offerId,
                  idempotencyKey(request),
                );
          void reply.header("Idempotency-Replayed", result.replayed);
          return reply.status(result.responseStatus).send(result.value);
        }),
    );
  }
}
