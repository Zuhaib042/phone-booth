import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

import { registerChatRoutes } from "./chat/routes.js";
import type { ChatApplication } from "./chat/service.js";
import type { ApiConfig } from "./config.js";
import { registerEconomyRoutes } from "./economy/routes.js";
import type { PostgresEconomyService } from "./economy/service.js";
import { registerIdentityRoutes } from "./identity/routes.js";
import type { IdentityApplication } from "./identity/service.js";
import { createLoggerOptions } from "./logger.js";
import { registerMatchRoutes } from "./matches/routes.js";
import type { PostgresMatchApplication } from "./matches/service.js";
import { registerMatchmakingRoutes } from "./matchmaking/routes.js";
import type { MatchmakingApplication } from "./matchmaking/service.js";
import type { PostgresRealtimeQueryService } from "./realtime/events.js";
import { registerRealtimeRoutes } from "./realtime/routes.js";
import type { RealtimeGateway } from "./realtime/websocket.js";

export interface BuildApiOptions {
  readonly chatService?: ChatApplication;
  readonly economyService?: PostgresEconomyService;
  readonly identityService?: IdentityApplication;
  readonly logger?: FastifyServerOptions["logger"];
  readonly matchmakingService?: MatchmakingApplication;
  readonly matchService?: PostgresMatchApplication;
  readonly realtimeGateway?: RealtimeGateway;
  readonly realtimeQueryService?: PostgresRealtimeQueryService;
  readonly realtimeResumeLimit?: number;
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
  registerEconomyRoutes(api, options.identityService, options.economyService);
  registerChatRoutes(api, options.identityService, options.chatService);
  registerMatchmakingRoutes(
    api,
    options.identityService,
    options.matchmakingService,
  );
  registerMatchRoutes(api, options.identityService, options.matchService);
  registerRealtimeRoutes(
    api,
    options.identityService,
    options.realtimeQueryService,
    options.realtimeResumeLimit,
  );
  options.realtimeGateway?.attach(api.server);

  return api;
}
