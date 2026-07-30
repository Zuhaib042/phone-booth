# Backend

The backend package contains the Project Booth Fastify API and worker processes.

## Environment

| Variable                             |                           Default | Accepted values                                                    |
| ------------------------------------ | --------------------------------: | ------------------------------------------------------------------ |
| `HOST`                               |                         `0.0.0.0` | Any non-empty bind host                                            |
| `PORT`                               |                            `3000` | Integer from `0` to `65535`; use `0` only for ephemeral test ports |
| `NODE_ENV`                           |                     `development` | `development`, `test`, or `production`                             |
| `LOG_LEVEL`                          |                            `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent`    |
| `DATABASE_URL`                       |   Required for datastore commands | `postgres:` or `postgresql:` connection URL                        |
| `VALKEY_URL`                         |   Required for datastore commands | `redis:` or `rediss:` connection URL                               |
| `WORKER_READY_FILE`                  | `/tmp/project-booth-worker-ready` | Any non-empty worker-writable path                                 |
| `WORKER_BATCH_SIZE`                  |                              `25` | Integer from `1` to `100`                                          |
| `WORKER_LEASE_MS`                    |                           `30000` | Integer from `1000` to `300000`                                    |
| `WORKER_POLL_INTERVAL_MS`            |                             `250` | Integer from `25` to `60000`                                       |
| `OUTBOX_CHANNEL`                     |            `project-booth:events` | Any non-empty Valkey publish channel                               |
| `IDENTITY_PROVIDER`                  |                        `disabled` | `disabled`, `development`, or `apple`                              |
| `APPLE_CLIENT_ID`                    |           Required for Apple auth | Sign in with Apple service identifier / token audience             |
| `ACCESS_TOKEN_TTL_SECONDS`           |                             `900` | Integer from `60` to `3600`                                        |
| `REFRESH_TOKEN_TTL_SECONDS`          |                         `2592000` | Integer from `3600` to `7776000`                                   |
| `ACCOUNT_DELETION_DELAY_SECONDS`     |                               `0` | Integer from `0` to `604800`                                       |
| `MATCHMAKING_READY_TIMEOUT_SECONDS`  |                              `15` | Integer from `5` to `120`                                          |
| `MATCH_LOBBY_READY_TIMEOUT_SECONDS`  |                              `30` | Integer from `5` to `300`                                          |
| `MATCHMAKING_RECENT_PAIRING_SECONDS` |                           `86400` | Integer from `0` to `2592000`                                      |
| `REALTIME_HEARTBEAT_INTERVAL_MS`     |                           `10000` | Integer from `1000` to `60000`                                     |
| `REALTIME_HEARTBEAT_TIMEOUT_MS`      |                           `30000` | Greater than the heartbeat interval, up to `180000`                |
| `REALTIME_RESUME_LIMIT`              |                             `100` | Integer from `1` to `500`                                          |

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

## Identity and profiles

`IDENTITY_PROVIDER=development` accepts explicit `dev:<subject>` credentials
only when `NODE_ENV` is `development` or `test`; startup rejects that provider
in production. `IDENTITY_PROVIDER=apple` requires `APPLE_CLIENT_ID` and verifies
RS256 identity tokens against Apple's published keys, issuer, audience,
lifetime, and optional nonce.

The API stores only hashes of opaque access and refresh tokens. Refresh tokens
rotate on every use; reuse of an already rotated token revokes every session for
the account. Public profiles expose only the internal user ID, filtered display
name, avatar key, and progression level.

`DELETE /v1/account` immediately marks the account ineligible, revokes its
sessions, and schedules worker cleanup. Cleanup removes provider identities,
devices, sessions, and the profile while retaining a deleted user tombstone for
durable match-history references.

## Matchmaking and real-time delivery

Authenticated clients create one durable ticket through
`POST /v1/matchmaking/tickets`. Queue groups are separated by immutable
ruleset, region, language, compatibility version, and safety restriction pool;
every proposed roster is revalidated against account eligibility and mutual
blocks in a serializable PostgreSQL transaction. Ready confirmation creates
the match, roster, deadline job, recent-pairing records, and initial
recipient-safe events atomically.

The WebSocket endpoint is `/v1/realtime`. Clients authenticate with the
`Authorization: Bearer` header or the `bearer.<access-token>` subprotocol,
respond to heartbeat pings, fetch `/v1/matches/{matchId}/snapshot` after
reconnecting, and then resume from `/v1/realtime/events` or a
`connection.resume` WebSocket message. Recipient cursors are durable per
account. Valkey carries disposable queue membership, connection presence, and
cross-instance fan-out; PostgreSQL retains tickets, matches, and resumable
events.

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
