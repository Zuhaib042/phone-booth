# Backend

The backend package contains the Project Booth Fastify API and worker processes.

## Environment

| Variable                  |                           Default | Accepted values                                                    |
| ------------------------- | --------------------------------: | ------------------------------------------------------------------ |
| `HOST`                    |                         `0.0.0.0` | Any non-empty bind host                                            |
| `PORT`                    |                            `3000` | Integer from `0` to `65535`; use `0` only for ephemeral test ports |
| `NODE_ENV`                |                     `development` | `development`, `test`, or `production`                             |
| `LOG_LEVEL`               |                            `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent`    |
| `DATABASE_URL`            |   Required for datastore commands | `postgres:` or `postgresql:` connection URL                        |
| `VALKEY_URL`              |   Required for datastore commands | `redis:` or `rediss:` connection URL                               |
| `WORKER_READY_FILE`       | `/tmp/project-booth-worker-ready` | Any non-empty worker-writable path                                 |
| `WORKER_BATCH_SIZE`       |                              `25` | Integer from `1` to `100`                                          |
| `WORKER_LEASE_MS`         |                           `30000` | Integer from `1000` to `300000`                                    |
| `WORKER_POLL_INTERVAL_MS` |                             `250` | Integer from `25` to `60000`                                       |
| `OUTBOX_CHANNEL`          |            `project-booth:events` | Any non-empty Valkey publish channel                               |

## Commands

Run from the repository root:

```sh
pnpm --filter @project-booth/backend build
pnpm --filter @project-booth/backend db:migrate
pnpm --filter @project-booth/backend db:status
pnpm --filter @project-booth/backend health:datastores
pnpm --filter @project-booth/backend start:api
pnpm --filter @project-booth/backend start:worker
pnpm --filter @project-booth/backend test
```

The liveness endpoint is `GET /health/live`. `SIGINT` and `SIGTERM` stop the
HTTP listener gracefully.

## PostgreSQL persistence

Migrations are forward-only SQL files in `services/backend/migrations`.
`db:migrate` takes a PostgreSQL advisory lock, verifies the SHA-256 checksum of
every migration already recorded in `schema_migrations`, and applies pending
files transactionally. `db:status` performs the same checksum validation
without changing application tables. `DATABASE_URL` may point at the Compose
database from the host with:

```sh
DATABASE_URL=postgresql://phone_booth:phone_booth_dev@127.0.0.1:5432/phone_booth \
  pnpm db:migrate
```

Do not edit a migration after it has been applied. Production rollback is a
forward compensating migration or a database restore taken before deployment.
For an unused local M4 schema only, the development database can be reset by
removing the Compose PostgreSQL volume and applying migrations again; this
destroys that local database and is intentionally not automated.

The worker applies pending migrations at startup, restores a unique scheduled
deadline for every active match version, and then claims transactional outbox
events and scheduled jobs. Outbox delivery is at least once, so consumers
deduplicate by event ID. Scheduled transitions lock both their claim and match
state and commit the transition, replacement deadline, outbox records, and job
completion atomically.

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
