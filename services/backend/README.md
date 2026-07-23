# Backend

The backend package contains the Project Booth Fastify API and worker processes.

## Environment

| Variable | Default | Accepted values |
|---|---:|---|
| `HOST` | `0.0.0.0` | Any non-empty bind host |
| `PORT` | `3000` | Integer from `0` to `65535`; use `0` only for ephemeral test ports |
| `NODE_ENV` | `development` | `development`, `test`, or `production` |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent` |
| `WORKER_READY_FILE` | `/tmp/project-booth-worker-ready` | Any non-empty worker-writable path |

## Commands

Run from the repository root:

```sh
pnpm --filter @project-booth/backend build
pnpm --filter @project-booth/backend start:api
pnpm --filter @project-booth/backend start:worker
pnpm --filter @project-booth/backend test
```

The liveness endpoint is `GET /health/live`. `SIGINT` and `SIGTERM` stop the
HTTP listener gracefully.

## Docker Desktop project

The root `compose.yaml` creates a Docker Desktop project named `phone-booth`
with API and worker services. Run its lifecycle commands from the repository
root:

```sh
pnpm container:start
pnpm container:status
pnpm container:logs
pnpm container:stop
pnpm container:down
```

`container:start` builds the image, starts both services in the background, and
waits for both health checks. `container:stop` stops the project but preserves
it in Docker Desktop. `container:down` removes its containers and network. To
build the image without starting a container, run:

```sh
pnpm container:build
```

The image contains production dependencies and compiled backend output only.
Both services run as the unprivileged `node` user. The API health check uses
`GET /health/live`; the worker health check uses its readiness file. Set
`PHONE_BOOTH_API_PORT` before starting Compose when host port `3000` is
unavailable.
