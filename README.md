# Project Booth

Project Booth is the working title for an iOS-first, live multiplayer social strategy game built around private negotiation, secret elimination votes, limited virtual-currency bribes, and permitted betrayal.

Planning artifacts:

- [MVP product specification](docs/MVP_PRODUCT_SPEC.md)
- [Technical architecture and delivery roadmap](docs/TECHNICAL_ARCHITECTURE.md)
- [Milestone blueprint with concise implementation chunks](docs/PROJECT_BLUEPRINT.md)

The final product name, branding, art, copy, and store metadata must be original and must not imply affiliation with _Beast Games_ or any other third-party property.

## Workspace

The backend workspace uses Node.js 24 LTS and pnpm 11. Node 24.18.0 is pinned for version managers; the supported engine range remains within Node 24 LTS.

```sh
pnpm install
pnpm verify
```

`pnpm verify` checks formatting, linting, types, unit tests, generated HTTP
clients, and the production build. Contract verification requires Swift 6.1 or
newer in addition to Node and pnpm. Use `pnpm format` and `pnpm lint:fix` to
apply safe formatting and lint fixes before verification.

GitHub Actions runs the same verification command for pushes and pull requests,
then builds the backend production image. CI does not publish an image or
contain deployment-provider configuration.

Start or stop the API, worker, PostgreSQL, and Valkey as a Docker Desktop
project named `phone-booth`:

```sh
pnpm container:start
pnpm container:health
pnpm container:stop
```

`container:start` builds changed layers and waits for all four services to become
healthy. `container:stop` keeps the stopped project visible in Docker Desktop;
use `pnpm container:down` when you want to remove its containers and network.
Named datastore volumes are preserved by both commands. The checked-in
`.env.example` contains development-only connection defaults; copy it to
`.env` only when you need local overrides.

Current boundaries:

- `apps/` — iOS and moderator clients
- `services/backend/` — the Fastify API and worker processes
- `packages/` — domain foundations, contracts, game engine, configuration, and shared fixtures
- `infra/` — provider-neutral infrastructure definitions
- `tests/` — cross-package integration, concurrency, load, and end-to-end tests

The current API exposes `GET /health/live`. Backend environment variables and
package commands are documented in
[services/backend/README.md](services/backend/README.md). The versioned HTTP
contract and its generation checks are documented in
[packages/contracts/README.md](packages/contracts/README.md).
