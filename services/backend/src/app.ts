import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

import type { ApiConfig } from "./config.js";
import { registerIdentityRoutes } from "./identity/routes.js";
import type { IdentityApplication } from "./identity/service.js";
import { createLoggerOptions } from "./logger.js";

export interface BuildApiOptions {
  readonly identityService?: IdentityApplication;
  readonly logger?: FastifyServerOptions["logger"];
}

const LIVE_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", const: "ok" },
  },
} as const;

export function buildApi(
  config: ApiConfig,
  options: BuildApiOptions = {},
): FastifyInstance {
  const logger =
    options.logger === undefined
      ? createLoggerOptions(config, "backend-api")
      : options.logger;
  const api = Fastify({ logger });

  api.setErrorHandler((error, request, reply) => {
    const validationFailure =
      error !== null &&
      typeof error === "object" &&
      "validation" in error &&
      error.validation !== undefined;
    if (!validationFailure) {
      request.log.error({ err: error }, "Request failed");
    }
    return reply.status(validationFailure ? 400 : 500).send({
      error: {
        code: validationFailure ? "invalid_request" : "internal_error",
        message: validationFailure
          ? "The request is malformed or fails validation"
          : "The server could not safely complete the request",
        traceId: request.id,
      },
    });
  });

  api.get(
    "/health/live",
    {
      schema: {
        response: { 200: LIVE_RESPONSE_SCHEMA },
      },
    },
    async () => ({ status: "ok" as const }),
  );

  registerIdentityRoutes(api, options.identityService);

  return api;
}
