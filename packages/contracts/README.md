# API contracts

`openapi.yaml` is the source of truth for the platform-neutral HTTPS API.
Product endpoints use a `/v1` path prefix; operational liveness remains at
`/health/live`.

The baseline defines:

- the existing live-health operation;
- bearer authentication metadata without authentication behavior;
- a stable error envelope and common error responses;
- cursor pagination parameters and metadata;
- UUID idempotency keys and replay metadata.

Run `pnpm test` in this package to lint the document, generate and compile a
typed TypeScript client, and generate and compile an Apple Swift OpenAPI client.
Generated code stays in build output and is not committed.

The TypeScript generator uses its tested TypeScript 6 compiler API internally.
Its generated Fetch SDK is compiled with the workspace-pinned TypeScript 7
binary. The generated transport is checked with strict type checking while
`exactOptionalPropertyTypes` remains disabled because the current generator
emits explicit `undefined` values for some optional Fetch fields.
