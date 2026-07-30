import { createHash } from "node:crypto";

import {
  parseEntityId,
  type MatchId,
  type UtcTimestamp,
} from "@project-booth/domain";
import {
  applyFinaleCommand,
  applyLobbyCommand,
  applyRoundCommand,
  applyRunoffCommand,
  applyTallyCommand,
  type MatchState,
} from "@project-booth/game-engine";
import type { PoolClient } from "pg";

import { PostgresRealtimeEventRepository } from "../realtime/events.js";
import { PostgresMatchRepository } from "./match-repository.js";
import { PostgresOutboxRepository } from "./outbox.js";
import {
  type ClaimedScheduledJob,
  MATCH_DEADLINE_JOB_KIND,
  PostgresScheduledJobRepository,
} from "./scheduled-jobs.js";

interface DeadlinePayload {
  readonly matchId: MatchId;
  readonly expectedVersion: number;
  readonly expectedPhase: string;
  readonly expectedDeadline: string | null;
}

interface TransitionStep {
  readonly state: MatchState;
  readonly events: readonly unknown[];
}

export class InvalidScheduledJobError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidScheduledJobError";
  }
}

function parsePayload(job: ClaimedScheduledJob): DeadlinePayload {
  if (job.kind !== MATCH_DEADLINE_JOB_KIND) {
    throw new InvalidScheduledJobError(`Unsupported job kind: ${job.kind}`);
  }
  const {
    payload: {
      expectedDeadline: deadline,
      expectedPhase: phase,
      expectedVersion: version,
      matchId,
    },
  } = job;
  const parsedMatchId =
    typeof matchId === "string" ? parseEntityId("match", matchId) : null;
  if (parsedMatchId === null || !parsedMatchId.ok) {
    throw new InvalidScheduledJobError("Deadline job matchId is invalid");
  }
  if (
    !Number.isSafeInteger(version) ||
    (version as number) < 1 ||
    typeof phase !== "string" ||
    (deadline !== null && typeof deadline !== "string")
  ) {
    throw new InvalidScheduledJobError("Deadline job expectation is invalid");
  }
  return {
    matchId: parsedMatchId.value as MatchId,
    expectedVersion: version as number,
    expectedPhase: phase,
    expectedDeadline: deadline as string | null,
  };
}

function unwrapTransition(
  result:
    | ReturnType<typeof applyLobbyCommand>
    | ReturnType<typeof applyRoundCommand>
    | ReturnType<typeof applyTallyCommand>
    | ReturnType<typeof applyRunoffCommand>
    | ReturnType<typeof applyFinaleCommand>,
): TransitionStep {
  if (!result.ok) {
    throw new InvalidScheduledJobError(
      `${result.error.code}: ${result.error.message}`,
    );
  }
  return result.value;
}

function stableRandomSample(jobId: string): number {
  const prefix = createHash("sha256").update(jobId).digest("hex").slice(0, 13);
  return Number.parseInt(prefix, 16) / 0x10_0000_0000_0000;
}

function advanceDeadline(
  initial: MatchState,
  occurredAt: UtcTimestamp,
  randomSample: number,
): readonly TransitionStep[] {
  const steps: TransitionStep[] = [];
  let state = initial;

  const apply = (step: TransitionStep): void => {
    steps.push(step);
    state = step.state;
  };

  switch (state.phase) {
    case "lobby":
      apply(
        unwrapTransition(
          applyLobbyCommand(state, { type: "lobby_timed_out", occurredAt }),
        ),
      );
      break;
    case "negotiation":
      apply(
        unwrapTransition(
          applyRoundCommand(state, {
            type: "negotiation_timed_out",
            occurredAt,
          }),
        ),
      );
      break;
    case "voting":
      apply(
        unwrapTransition(
          applyRoundCommand(state, { type: "voting_timed_out", occurredAt }),
        ),
      );
      break;
    case "tally":
      break;
    case "runoff_negotiation":
      apply(
        unwrapTransition(
          applyRunoffCommand(state, {
            type: "runoff_negotiation_timed_out",
            occurredAt,
          }),
        ),
      );
      break;
    case "runoff_voting":
      apply(
        unwrapTransition(
          applyRunoffCommand(state, {
            type: "runoff_tallied",
            occurredAt,
            randomSample,
          }),
        ),
      );
      break;
    case "elimination":
      apply(
        unwrapTransition(
          applyFinaleCommand(state, {
            type: "elimination_reveal_timed_out",
            occurredAt,
          }),
        ),
      );
      break;
    case "final_plea":
      apply(
        unwrapTransition(
          applyFinaleCommand(state, {
            type: "final_plea_timed_out",
            occurredAt,
          }),
        ),
      );
      break;
    case "jury_voting":
      apply(
        unwrapTransition(
          applyFinaleCommand(state, {
            type: "jury_tallied",
            occurredAt,
            randomSample,
          }),
        ),
      );
      break;
    case "complete":
    case "cancelled":
      return steps;
  }

  if (state.phase === "tally" && state.normalTally === null) {
    apply(
      unwrapTransition(
        applyTallyCommand(state, {
          type: "normal_ballots_tallied",
          occurredAt,
        }),
      ),
    );
  }
  if (state.phase === "tally" && state.normalTally !== null) {
    apply(
      unwrapTransition(
        applyRunoffCommand(state, {
          type: "runoff_started",
          occurredAt,
          randomSample,
        }),
      ),
    );
  }

  return steps;
}

export class MatchDeadlineHandler {
  public constructor(
    private readonly matches = new PostgresMatchRepository(),
    private readonly outbox = new PostgresOutboxRepository(),
    private readonly scheduledJobs = new PostgresScheduledJobRepository(),
    private readonly realtimeEvents = new PostgresRealtimeEventRepository(),
  ) {}

  public async handle(
    client: PoolClient,
    job: ClaimedScheduledJob,
    occurredAt: UtcTimestamp,
  ): Promise<void> {
    const expected = parsePayload(job);
    const current = await this.matches.load(client, expected.matchId, {
      forUpdate: true,
    });
    if (
      current === null ||
      current.version !== expected.expectedVersion ||
      current.phase !== expected.expectedPhase ||
      current.phaseDeadline !== expected.expectedDeadline
    ) {
      return;
    }

    const steps = advanceDeadline(
      current,
      occurredAt,
      stableRandomSample(job.jobId),
    );
    const finalState = steps.at(-1)?.state;
    if (finalState === undefined || finalState.version === current.version) {
      return;
    }

    await this.matches.save(client, current.version, finalState, occurredAt);
    const events = await this.realtimeEvents.appendProjectedEvents(
      client,
      finalState,
      steps.flatMap((step) =>
        step.events.map((event) => {
          if (
            event === null ||
            typeof event !== "object" ||
            !("type" in event) ||
            typeof event.type !== "string"
          ) {
            throw new TypeError("Scheduled transition event type is invalid");
          }
          return {
            audience: "participants" as const,
            event,
            eventType: event.type,
            matchVersion: step.state.version,
          };
        }),
      ),
      occurredAt,
    );
    await this.matches.appendEvents(client, events.matchEvents);
    await this.outbox.enqueue(client, events.outboxEvents);
    await this.scheduledJobs.synchronizeMatchDeadline(
      client,
      finalState,
      occurredAt,
    );
  }
}
