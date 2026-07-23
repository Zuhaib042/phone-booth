# Project Booth

Project Booth is the working title for an iOS-first, live multiplayer social strategy game built around private negotiation, secret elimination votes, limited virtual-currency bribes, and permitted betrayal.

Planning artifacts:

- [MVP product specification](docs/MVP_PRODUCT_SPEC.md)
- [Technical architecture and delivery roadmap](docs/TECHNICAL_ARCHITECTURE.md)
- [Milestone blueprint with concise implementation chunks](docs/PROJECT_BLUEPRINT.md)

The final product name, branding, art, copy, and store metadata must be original and must not imply affiliation with *Beast Games* or any other third-party property.

## Workspace

The backend workspace uses Node.js 24 LTS and pnpm 11. Node 24.18.0 is pinned for version managers; the supported engine range remains within Node 24 LTS.

```sh
pnpm install
pnpm verify
```

Start or stop the API and worker as a Docker Desktop project named
`phone-booth`:

```sh
pnpm container:start
pnpm container:stop
```

`container:start` builds changed layers and waits for both services to become
healthy. `container:stop` keeps the stopped project visible in Docker Desktop;
use `pnpm container:down` when you want to remove its containers and network.

Current boundaries:

- `apps/` — iOS and moderator clients
- `services/backend/` — the Fastify API and, in a later chunk, worker process
- `packages/` — contracts, game engine, configuration, and shared fixtures
- `infra/` — provider-neutral infrastructure definitions
- `tests/` — cross-package integration, concurrency, load, and end-to-end tests

The current API exposes `GET /health/live`. Backend environment variables and
package commands are documented in [services/backend/README.md](services/backend/README.md).
