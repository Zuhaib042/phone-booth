# Backend

The backend package contains the Project Booth Fastify API and worker processes.

## Environment

| Variable            |                           Default | Accepted values                                                    |
| ------------------- | --------------------------------: | ------------------------------------------------------------------ |
| `HOST`              |                         `0.0.0.0` | Any non-empty bind host                                            |
| `PORT`              |                            `3000` | Integer from `0` to `65535`; use `0` only for ephemeral test ports |
| `NODE_ENV`          |                     `development` | `development`, `test`, or `production`                             |
| `LOG_LEVEL`         |                            `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent`    |
| `DATABASE_URL`      |   Required for datastore commands | `postgres:` or `postgresql:` connection URL                        |
| `VALKEY_URL`        |   Required for datastore commands | `redis:` or `rediss:` connection URL                               |
| `WORKER_READY_FILE` | `/tmp/project-booth-worker-ready` | Any non-empty worker-writable path                                 |

## Commands

Run from the repository root:

```sh
pnpm --filter @project-booth/backend build
pnpm --filter @project-booth/backend health:datastores
pnpm --filter @project-booth/backend start:api
pnpm --filter @project-booth/backend start:worker
pnpm --filter @project-booth/backend test
```

The liveness endpoint is `GET /health/live`. `SIGINT` and `SIGTERM` stop the
HTTP listener gracefully.

## Docker Desktop project

The root `compose.yaml` creates a Docker Desktop project named `phone-booth`
with API, worker, PostgreSQL, and Valkey services. Run its lifecycle commands
from the repository root:

```sh
pnpm container:start
pnpm container:status
pnpm container:health
pnpm container:logs
pnpm container:stop
pnpm container:down
```

`container:start` builds the image, starts the project in the background, and
waits for all four health checks. `container:health` executes `SELECT 1` and
`PING` from both backend containers without writing application state.
`container:stop` stops the project but preserves it in Docker Desktop.
`container:down` removes its containers and network while retaining the named
datastore volumes. PostgreSQL remains the durable source of truth; the Valkey
volume is a local development convenience and application correctness must not
depend on its contents. To build the image without starting a container, run:

```sh
pnpm container:build
```

The image contains production dependencies and compiled backend output only.
Both services run as the unprivileged `node` user. The API health check uses
`GET /health/live`; the worker health check uses its readiness file. Set
`PHONE_BOOTH_API_PORT` before starting Compose when host port `3000` is
unavailable.
