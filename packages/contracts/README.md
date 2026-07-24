# Platform contracts

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

`src/realtime.ts` defines the Draft 2020-12 real-time contracts:

- `SERVER_EVENT_ENVELOPE_V1_SCHEMA` requires RFC 9562 identifiers, a canonical
  UTC timestamp, positive match and recipient sequences, and one of the
  `player`, `participants`, `active`, or `moderator` audiences.
- A `player` event requires `recipientUserId`; every broader event must omit it.
- The payload guard recursively blocks player-private fields from shared
  audiences and internal evidence from every non-moderator audience.
- `PROTOCOL_ERROR_V1_SCHEMA` exposes stable error codes and only the recovery
  metadata allowed for each code. Free-form server messages, stacks, and
  arbitrary details are rejected.

The payload guard is a defense-in-depth boundary, not permission to publish
arbitrary payloads. Later feature chunks must add event-specific projection
schemas and tests before producing those events.

`pnpm run test:realtime` compiles the reusable validators and runs valid,
malformed, routing, recovery, and recursive private-field leakage fixtures.
