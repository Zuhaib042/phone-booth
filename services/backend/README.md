# Backend

The backend package currently contains the Project Booth Fastify API process.

## Environment

| Variable | Default | Accepted values |
|---|---:|---|
| `HOST` | `0.0.0.0` | Any non-empty bind host |
| `PORT` | `3000` | Integer from `0` to `65535`; use `0` only for ephemeral test ports |
| `NODE_ENV` | `development` | `development`, `test`, or `production` |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent` |

## Commands

Run from the repository root:

```sh
pnpm --filter @project-booth/backend build
pnpm --filter @project-booth/backend start:api
pnpm --filter @project-booth/backend test
```

The liveness endpoint is `GET /health/live`. `SIGINT` and `SIGTERM` stop the
HTTP listener gracefully.
