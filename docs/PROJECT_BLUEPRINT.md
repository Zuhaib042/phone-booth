# Project Booth — Milestone Blueprint

**Status:** Active execution plan  
**Version:** 0.3<br>
**Framework decision:** Direct Fastify locked for the MVP  
**Product source:** [MVP Product Specification](MVP_PRODUCT_SPEC.md)  
**Architecture source:** [Technical Architecture](TECHNICAL_ARCHITECTURE.md)

## 1. Purpose

This blueprint converts the product and architecture into small, sequential implementation chunks. Each chunk must produce one coherent change, include its own verification, and leave the repository in a usable state.

Only one chunk is active at a time. Finishing a milestone does not authorize starting the next one without reviewing its exit gate.

### Current execution status

- Completed: M0.1–M0.3 and M1.1–M1.6
- Active: none
- Next: M1.7 — Provider-neutral CI
- Last verified: 2026-07-23 with Node.js 24 LTS and pnpm 11

## 2. Chunk rules

Every implementation chunk follows these rules:

1. **One outcome.** A chunk changes one behavior or establishes one narrow foundation.
2. **Reviewable size.** Aim for fewer than 400 handwritten changed lines. Generated code, lockfiles, and schema migrations are excluded. Split a chunk when its purpose becomes difficult to summarize in one sentence.
3. **Tests travel with behavior.** A chunk is incomplete until its focused tests or verification command pass.
4. **No speculative abstractions.** Add interfaces when a current boundary requires them, not for imagined future services.
5. **Contracts before consumers.** Change OpenAPI or real-time schemas before implementing server and client consumers.
6. **Additive migrations.** Database changes are forward migrations with explicit rollback or compensating instructions.
7. **Feature flags for incomplete flows.** Unfinished user-facing functionality stays inaccessible in production configurations.
8. **No mixed cleanup.** Refactors unrelated to the chunk become separate backlog entries.
9. **Document decisions once.** Any changed product or architecture decision updates the source document in the same chunk.
10. **Stop on green.** Commit or hand off after verification rather than silently beginning the next chunk.

Each chunk handoff reports:

- Outcome
- Files changed
- Verification performed
- Known limitation
- Exact next chunk

## 3. Locked and deferred decisions

### Locked for the MVP

- Native SwiftUI iPhone client
- TypeScript backend on current Node.js LTS
- Direct Fastify application framework
- Modular monolith with API and worker processes
- OCI containers for backend runtime processes; native iOS builds remain outside Docker
- PostgreSQL as the durable source of truth
- Valkey only for ephemeral coordination
- HTTPS for commands and WebSockets for server events
- OpenAPI plus versioned JSON event contracts
- Server-authoritative match, timer, vote, moderation, and economy state
- Append-only double-entry Booth Coin ledger
- Platform-neutral backend contracts for later Android development

### Deliberately deferred

- Production hosting provider and region
- Final Booth Coin denomination
- Starter grants, recurring rewards, offer increments, and match cap
- Coin-pack sizes and prices
- Cosmetic prices and progression pacing
- Final moderation vendor and thresholds
- Final product name, identity, and store artwork

Deferred values must enter through configuration. They must not be embedded in game-engine code.

## 4. Milestone sequence

```mermaid
flowchart LR
    M0["M0 Planning"] --> M1["M1 Workspace"]
    M1 --> M2["M2 Contracts"]
    M2 --> M3["M3 Game engine"]
    M3 --> M4["M4 Persistence"]
    M4 --> M5["M5 Identity"]
    M5 --> M6["M6 Multiplayer"]
    M6 --> M7["M7 Safe chat"]
    M7 --> M8["M8 Ledger and bribes"]
    M8 --> M9["M9 iOS foundation"]
    M9 --> M10["M10 Match UI"]
    M10 --> M11["M11 Economy and StoreKit"]
    M11 --> M12["M12 Moderation operations"]
    M12 --> M13["M13 Product completion"]
    M13 --> M14["M14 Deployment and hardening"]
    M14 --> M15["M15 App Store launch"]
    M15 -.-> M16["M16 Android readiness"]
```

## 5. M0 — Product and architecture baseline

**Status:** Complete when this blueprint is accepted.

| Chunk | Concise change                                                                      | Verification                                                                                  |
| ----- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| M0.1  | Define the MVP rules, safety boundaries, economy behavior, and acceptance criteria. | Product specification is internally consistent and contains no real-money path.               |
| M0.2  | Define the platform-neutral system architecture and failure guarantees.             | Architecture covers transactions, reconnects, moderation, purchases, and Android portability. |
| M0.3  | Lock direct Fastify and publish the sequential implementation blueprint.            | The framework and all deferred decisions are explicit in the planning documents.              |

**Exit gate:** Product spec, architecture, and blueprint agree on the core rules and ownership boundaries.

## 6. M1 — Workspace and backend skeleton

**Status:** In progress — M1.1–M1.6 complete.

| Chunk           | Concise change                                                                                                                                 | Verification                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| M1.1 — Complete | Create the pnpm workspace, root scripts, pinned Node version, TypeScript base config, and documented directory skeleton.                       | `pnpm verify` passes from the repository root.                                                                                                  |
| M1.2 — Complete | Add a Fastify API process with configuration validation, structured logging, `/health/live`, and graceful shutdown.                            | API unit test uses Fastify injection; process exits cleanly on a shutdown signal.                                                               |
| M1.3 — Complete | Package the API in a provider-neutral, multi-stage OCI image with a minimal non-root runtime, `.dockerignore`, and API-only Compose lifecycle. | Compose builds and starts a healthy `phone-booth` project; the image serves `/health/live` and stops cleanly on a container termination signal. |
| M1.4 — Complete | Add a worker process using the same configuration and logging packages and the same backend image.                                             | Worker starts through the image's worker command, reports readiness, handles a no-op job, and shuts down cleanly.                               |
| M1.5 — Complete | Extend the Compose stack with local PostgreSQL and Valkey services, named development volumes, health checks, and environment examples.        | Compose waits for healthy dependencies; API and worker reach both datastores without storing application state yet.                             |
| M1.6 — Complete | Add formatting, linting, typechecking, unit-test, and build commands.                                                                          | One root verification command runs every check successfully.                                                                                    |
| M1.7            | Add provider-neutral CI for verification and backend image builds.                                                                             | CI runs the same root verification command as local development and builds the production image.                                                |

**Exit gate:** A new developer can clone the repository, start the complete local stack with Compose, run both backend processes as containers, and pass every check from documented commands.

## 7. M2 — Contracts and domain foundations

| Chunk | Concise change                                                                                                           | Verification                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| M2.1  | Define shared identifiers, UTC timestamp rules, domain errors, result types, injected clock, and injected random source. | Unit tests prove deterministic time and random behavior.                         |
| M2.2  | Define the versioned ruleset schema with symbolic economy configuration and no launch coin values.                       | Invalid phases, durations, roster sizes, and economy relationships are rejected. |
| M2.3  | Create the OpenAPI 3.1 document with health, error, pagination, idempotency, and authentication conventions.             | OpenAPI lint passes and generated sample clients compile.                        |
| M2.4  | Define the WebSocket event envelope, audiences, cursor, match version, and protocol error schema.                        | JSON Schema accepts valid fixtures and rejects hidden or malformed fields.       |
| M2.5  | Add contract compatibility checks that detect breaking changes.                                                          | A deliberately breaking fixture fails the compatibility check.                   |

**Exit gate:** HTTP and real-time conventions exist before feature endpoints, and domain code has no wall-clock or random global dependency.

## 8. M3 — Deterministic match engine

| Chunk | Concise change                                                                     | Verification                                                                        |
| ----- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| M3.1  | Model roster, player status, match version, phase, and immutable ruleset snapshot. | State construction and invalid-roster tests pass.                                   |
| M3.2  | Implement lobby readiness and transition into the first negotiation phase.         | Ready, timeout, insufficient-roster, and duplicate-command cases pass.              |
| M3.3  | Implement negotiation and normal ballot validation without persistence.            | Eligibility, self-vote, revision, deadline, and missing-ballot tests pass.          |
| M3.4  | Implement tally and single-player elimination.                                     | Majority, plurality, automatic self-vote, and hidden-ballot projections pass.       |
| M3.5  | Implement runoff phases and cumulative-vote/random tie fallback.                   | Every documented tie path is deterministic under an injected random value.          |
| M3.6  | Implement eliminated jurors, finalist pleas, jury ballots, and winner fallback.    | Jury majority, missing jurors, ties, and no-juror cases pass.                       |
| M3.7  | Build the post-match dossier projection.                                           | Fixtures reveal votes and deals only after completion and only to eligible viewers. |
| M3.8  | Add a headless six-player match simulator.                                         | Seeded simulations complete with exactly one winner and no illegal transition.      |

**Exit gate:** Thousands of seeded headless matches complete deterministically without HTTP, databases, sockets, or iOS code.

## 9. M4 — PostgreSQL persistence and reliable jobs

| Chunk | Concise change                                                                                     | Verification                                                           |
| ----- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| M4.1  | Add migration tooling and initial user, match, round, roster, and ruleset tables.                  | Migrations apply to an empty database and schema checks pass.          |
| M4.2  | Add repository interfaces and PostgreSQL implementations for match snapshots and events.           | Save/load round-trip reconstructs identical engine state.              |
| M4.3  | Implement the transaction runner with stable row-lock ordering and retryable serialization errors. | Concurrent test demonstrates one committed transition.                 |
| M4.4  | Add account-scoped idempotency records and original-response replay.                               | Duplicate requests return the first result without a second mutation.  |
| M4.5  | Add the transactional outbox and worker claim loop.                                                | Crash-after-commit test republishes safely without losing the event.   |
| M4.6  | Add PostgreSQL-backed scheduled deadlines with `SKIP LOCKED` claiming.                             | Two workers cannot advance the same phase twice.                       |
| M4.7  | Add restart recovery for active matches.                                                           | API and worker restarts preserve phase, deadline, version, and roster. |

**Exit gate:** PostgreSQL can reconstruct every durable match fact, and worker retries cannot duplicate transitions.

## 10. M5 — Identity, accounts, and profiles

| Chunk | Concise change                                                             | Verification                                                                 |
| ----- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| M5.1  | Add a development-only identity provider behind an environment guard.      | Production configuration cannot enable development authentication.           |
| M5.2  | Add users, provider identities, sessions, and device records.              | Identity linking cannot create duplicate internal users.                     |
| M5.3  | Implement Sign in with Apple credential verification and account creation. | Valid, expired, wrong-audience, and replayed credential tests pass.          |
| M5.4  | Issue short-lived access tokens and rotating refresh tokens.               | Rotation, revocation, reuse detection, and logout tests pass.                |
| M5.5  | Add pseudonymous profiles and display-name filtering.                      | Unsafe names are rejected; public projection excludes private identity data. |
| M5.6  | Add account deletion request and asynchronous cleanup state.               | Deleted accounts lose sessions and no longer enter matchmaking.              |

**Exit gate:** Every player has one platform-neutral account, and no game endpoint trusts an Apple identifier directly.

## 11. M6 — Matchmaking and real-time delivery

| Chunk | Concise change                                                                                   | Verification                                                                            |
| ----- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| M6.1  | Add create, inspect, and cancel matchmaking-ticket commands.                                     | Duplicate tickets and cancel races are idempotent.                                      |
| M6.2  | Add Valkey queue grouping by ruleset, region, language, compatibility, restrictions, and blocks. | Ineligible or mutually blocked players never share a proposed roster.                   |
| M6.3  | Add ready confirmation and durable match creation.                                               | Failed readiness releases tickets without creating partial matches.                     |
| M6.4  | Add authenticated WebSocket connection, heartbeat, and connection registry.                      | Invalid tokens fail; stale connections close; reconnect succeeds.                       |
| M6.5  | Add recipient-safe outbox fan-out through Valkey.                                                | Private events reach only their intended account across two API instances.              |
| M6.6  | Add snapshot plus cursor-based event resume.                                                     | Disconnect/reconnect to another instance produces no lost or duplicated visible effect. |
| M6.7  | Extend the simulator into six networked test clients.                                            | Six clients match, enter a booth, and observe synchronized phase deadlines.             |

**Exit gate:** Six test clients form a match and survive API reconnection without sticky sessions.

## 12. M7 — Private text chat and safety foundation

| Chunk | Concise change                                                                                            | Verification                                                                           |
| ----- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| M7.1  | Add match-private one-to-one threads and message persistence.                                             | Only active contestants in the same match can address each other.                      |
| M7.2  | Add Unicode normalization, length limits, contact/link detection, spam limits, and prohibited-term rules. | Obfuscation and bypass fixture suite produces expected outcomes.                       |
| M7.3  | Add a replaceable moderation-provider interface with a deterministic test provider.                       | Allow, block, urgent-review, timeout, and provider-failure paths pass.                 |
| M7.4  | Deliver permitted messages through recipient-safe events.                                                 | Sender acknowledgement and recipient delivery reference the same message ID.           |
| M7.5  | Add quick phrases and fail-closed free text during moderation outages.                                    | Voting and structured offers continue while free text is unavailable.                  |
| M7.6  | Add mute, message report, user report, and block commands.                                                | Mute affects the current match; block prevents future pairings without changing votes. |

**Exit gate:** Gameplay chat is scoped, filtered, reportable, blockable, and nonessential to voting availability.

## 13. M8 — Coin ledger and psychological bribes

Launch quantities remain test fixtures until M11.

| Chunk | Concise change                                                                         | Verification                                                                       |
| ----- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| M8.1  | Add coin accounts, immutable ledger transactions, and balanced ledger entries.         | Property tests prove every transaction sums to zero.                               |
| M8.2  | Add spendable, reserved, and pending balance buckets.                                  | Invalid negative transitions fail atomically.                                      |
| M8.3  | Add configurable grants and cosmetic sinks using non-launch fixture values.            | Duplicate grants and purchases cannot mint or burn twice.                          |
| M8.4  | Add formal bribe creation, replacement, decline, and expiry.                           | Invalid sender, recipient, target, phase, amount, and expiry cases fail.           |
| M8.5  | Add atomic bribe acceptance with pending recipient funds and match outflow accounting. | Simultaneous accept attempts transfer value once.                                  |
| M8.6  | Settle pending funds after any valid ballot without enforcing the promised target.     | Honored and betrayed ballots settle identically.                                   |
| M8.7  | Reverse pending funds and restore sender allowance after a missed ballot.              | AFK and deadline races preserve balances and cap invariants.                       |
| M8.8  | Add conflicting offers and dossier classifications.                                    | One recipient can accept conflicting promises; final ballots label each correctly. |
| M8.9  | Add ledger, offer, refund-race, and concurrency property tests.                        | Long randomized command sequences preserve all economy invariants.                 |

**Exit gate:** The server proves that betrayal is permitted, abandonment cannot launder coins, and no concurrency path duplicates value.

## 14. M9 — Native iOS foundation

| Chunk | Concise change                                                                                                       | Verification                                                           |
| ----- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| M9.1  | Create the SwiftUI iOS project, environments, app entry point, and feature folders.                                  | App builds and launches on the minimum supported simulator.            |
| M9.2  | Add semantic design tokens, typography, navigation shell, accessibility defaults, and reusable loading/error states. | Dynamic Type, dark mode, and VoiceOver smoke checks pass.              |
| M9.3  | Generate the Swift HTTP client from OpenAPI and wrap authentication middleware.                                      | Generated client compiles and calls the health endpoint.               |
| M9.4  | Add Keychain session storage and sign-in state restoration.                                                          | Fresh install, login, restart, logout, and revoked-session flows pass. |
| M9.5  | Add the WebSocket client, heartbeat, backoff, snapshot reconciliation, and event deduplication.                      | Simulated interruption restores the correct cursor and match version.  |
| M9.6  | Add a single observable match store that applies snapshots and ordered events.                                       | Out-of-order and duplicate event fixtures cannot corrupt UI state.     |

**Exit gate:** The iOS shell authenticates, consumes generated contracts, reconnects, and renders server state without owning game rules.

## 15. M10 — Complete iOS match experience

| Chunk | Concise change                                                                          | Verification                                                                  |
| ----- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| M10.1 | Add home, profile summary, Play action, and match-preparation explanation.              | UI clearly distinguishes wallet balance from configured match allowance.      |
| M10.2 | Add matchmaking, cancellation, ready confirmation, and failure recovery.                | UI tests cover timeout, cancellation, readiness, and match entry.             |
| M10.3 | Add the booth shell with phase, server timer, roster, status, and red-phone navigation. | Background/foreground does not extend or reset deadlines.                     |
| M10.4 | Add private thread UI, quick phrases, mute, report, and block entry points.             | Filtered and failed messages display safe actionable states.                  |
| M10.5 | Add bribe composer, pending/accepted cards, and explicit betrayal disclosure.           | Sender and recipient confirmations match the product rules.                   |
| M10.6 | Add secret vote, revision, deadline, runoff, and elimination views.                     | Other players' ballots never enter the client projection before completion.   |
| M10.7 | Add eliminated spectator state, final pleas, jury vote, and return notification.        | Juror can leave and resume into the correct final state.                      |
| M10.8 | Add dossier and basic results presentation.                                             | Honored, betrayed, reversed, declined, and expired offers render distinctly.  |
| M10.9 | Run the six-client end-to-end match suite.                                              | Six simulators complete the full loop and produce one server-selected winner. |

**Exit gate:** A production-like match can be played end to end on iOS without StoreKit purchases.

## 16. M11 — Economy design and StoreKit

Do not implement product quantities until the economy document is approved.

| Chunk | Concise change                                                                                                    | Verification                                                                            |
| ----- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| M11.1 | Benchmark comparable game economies and define denomination, ratios, sources, sinks, packs, caps, and guardrails. | Economy simulation shows free viability, capped payer advantage, and sustainable sinks. |
| M11.2 | Encode approved values in versioned remote configuration rather than source code.                                 | A new ruleset changes values without rebuilding backend or iOS binaries.                |
| M11.3 | Configure consumable StoreKit products and build the shop presentation.                                           | Local StoreKit test covers success, cancellation, pending, and duplicate delivery.      |
| M11.4 | Verify signed transactions on the backend and credit the ledger idempotently.                                     | Replayed and wrong-app transactions cannot mint coins.                                  |
| M11.5 | Process App Store Server Notifications V2.                                                                        | Test notifications and duplicate delivery are acknowledged safely.                      |
| M11.6 | Add refunds, revocations, negative-balance restriction, and support evidence.                                     | Purchase-to-bribe-to-refund flow preserves ledger invariants.                           |
| M11.7 | Add circular-transfer, repeated-pairing, and alternate-account risk signals.                                      | Fraud fixtures are flagged without blocking ordinary one-off betrayal.                  |

**Exit gate:** Approved economy values are remotely configurable, and every StoreKit lifecycle path reconciles against the ledger.

## 17. M12 — Moderation and support operations

| Chunk | Concise change                                                             | Verification                                                                        |
| ----- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| M12.1 | Add moderator roles, multifactor requirement, and separate admin sessions. | Player credentials cannot access moderator APIs.                                    |
| M12.2 | Build the severity-ordered report queue.                                   | Reports appear with limited relevant context and no unrelated private data.         |
| M12.3 | Add warning, chat restriction, suspension, ban, and unblock actions.       | Every action changes eligibility and writes an audit record.                        |
| M12.4 | Add account, message, match, transaction, and device-risk evidence views.  | Access is role-checked and every evidence view is audited.                          |
| M12.5 | Add appeal and support status workflow.                                    | Player can submit and receive an appeal outcome without direct moderator contact.   |
| M12.6 | Add chat-retention, evidence-preservation, and deletion jobs.              | Retention expiry deletes eligible content but preserves required audit metadata.    |
| M12.7 | Run the complete safety and App Review walkthrough.                        | Filtering, reporting, blocking, response, and contact information are demonstrable. |

**Exit gate:** A real operator can investigate and act on abuse within the published response targets.

## 18. M13 — Product completion

| Chunk | Concise change                                                                            | Verification                                                                           |
| ----- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| M13.1 | Add interactive bot onboarding and an App Review demo ruleset.                            | One reviewer account demonstrates every core and safety action alone.                  |
| M13.2 | Add XP, levels, achievements, daily rewards, and placement results.                       | Rewards are idempotent and cannot be farmed by replaying completion.                   |
| M13.3 | Add cosmetic inventory, equipping, and original booth presentation.                       | Cosmetic ownership affects appearance only and survives reinstall.                     |
| M13.4 | Add match-ready, reconnect, jury, moderation, and optional reward notifications.          | Preferences and APNs failure handling are tested.                                      |
| M13.5 | Add privacy-safe analytics events and balance dashboards.                                 | No raw message or private ballot content enters analytics.                             |
| M13.6 | Add in-app privacy policy, terms, community guidelines, support, and account deletion UX. | Every legal/safety surface is reachable without joining a match.                       |
| M13.7 | Complete localization foundation and accessibility audit.                                 | Pseudolocalization, VoiceOver, Dynamic Type, contrast, and reduced-motion checks pass. |

**Exit gate:** All product-spec acceptance criteria are implemented before infrastructure launch work begins.

## 19. M14 — Hosting selection, deployment, and hardening

| Chunk | Concise change                                                                                          | Verification                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| M14.1 | Compare hosting candidates using cost, region, WebSocket, database, recovery, and operational criteria. | Decision record selects one provider with migration risks stated.                                    |
| M14.2 | Harden and publish the existing backend image, then add selected-provider infrastructure configuration. | The same tested image digest runs locally and in staging without provider-specific application code. |
| M14.3 | Create isolated staging and production environments with managed secrets.                               | Environment and Apple sandbox/production credentials cannot cross.                                   |
| M14.4 | Add dashboards, alerts, tracing, error tracking, and administrative kill switches.                      | A staged incident triggers an actionable alert and documented control.                               |
| M14.5 | Run WebSocket, match, transaction, moderation, and outbox load tests.                                   | Target concurrency passes without violating phase-delay or ledger gates.                             |
| M14.6 | Add App Attest risk checks and sensitive-command enforcement.                                           | Genuine, unsupported, failed, replayed, and suspicious attestations follow policy.                   |
| M14.7 | Test database backup restoration and write incident runbooks.                                           | A fresh environment restores durable state within the recovery objective.                            |
| M14.8 | Complete security, privacy, dependency, and abuse review.                                               | No unresolved launch-blocking high-severity finding remains.                                         |

**Exit gate:** The selected production environment has measured capacity, recoverability, monitoring, and incident controls.

## 20. M15 — TestFlight and App Store launch

| Chunk | Concise change                                                                           | Verification                                                                   |
| ----- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| M15.1 | Finalize an original name, icon, screenshots, copy, and IP review.                       | Metadata contains no third-party affiliation or protected assets.              |
| M15.2 | Complete age rating, privacy labels, IAP metadata, reviewer notes, and demo credentials. | Submission checklist maps every non-obvious behavior to review guidance.       |
| M15.3 | Run internal TestFlight functional and purchase testing.                                 | All critical flows pass on supported physical devices and networks.            |
| M15.4 | Run a limited external TestFlight and resolve launch-blocking findings only.             | Crash, completion, safety, latency, and economy guardrails meet thresholds.    |
| M15.5 | Submit the release candidate and respond to review with evidence.                        | Approved build matches the tested commit and production configuration.         |
| M15.6 | Execute controlled launch and first-week monitoring.                                     | Rollback, kill switches, support coverage, and daily metric review are active. |

**Exit gate:** The app is approved, safely available, monitored, and supportable.

## 21. M16 — Android readiness and implementation

This is post-MVP and begins only after iOS retention validates further investment.

| Chunk | Concise change                                                           | Verification                                                                    |
| ----- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| M16.1 | Audit backend contracts for accidental iOS assumptions.                  | Android conformance client completes the full protocol suite.                   |
| M16.2 | Add Google identity, Play Billing, FCM, and Play Integrity adapters.     | Provider adapters pass the same account, economy, notification, and risk tests. |
| M16.3 | Build the Kotlin/Compose foundation and generated HTTP models.           | Android client authenticates and restores real-time state.                      |
| M16.4 | Implement feature parity in the same small-screen sequence used for iOS. | Cross-platform scripted matches produce identical server outcomes.              |

**Exit gate:** iOS and Android clients share backend behavior without platform-specific game rules.

## 22. Immediate next chunk

The next implementation chunk is **M1.5 — Local PostgreSQL and Valkey**.

It should create only:

- Pinned PostgreSQL and Valkey services in the existing Compose project
- Named development volumes for durable local datastore files
- Health checks and dependency-readiness ordering
- Validated datastore connection configuration and an environment example
- A narrow health command proving API and worker connectivity without storing application state
- Focused Compose lifecycle and datastore connectivity verification

It must not yet add migrations, application tables, durable jobs, authentication, game endpoints, WebSockets, SwiftUI code, or game behavior. Those belong to later chunks.
