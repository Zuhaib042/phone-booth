import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

import type { ApiConfig } from "./config.js";

export interface BuildApiOptions {
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
      ? {
          level: config.logLevel,
          base: {
            environment: config.nodeEnvironment,
            service: "backend-api",
          },
        }
      : options.logger;

  const api = Fastify({ logger });

  api.get(
    "/health/live",
    {
      schema: {
        response: { 200: LIVE_RESPONSE_SCHEMA },
      },
    },
    async () => ({ status: "ok" as const }),
  );

  return api;
}
