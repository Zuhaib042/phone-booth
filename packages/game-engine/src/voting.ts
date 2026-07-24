import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
  type UserId,
  type UtcTimestamp,
} from "@project-booth/domain";

import type { MatchState, NormalBallot } from "./match-state.js";
import {
  createMatchTransition,
  deadlineAfterSeconds,
  type MatchTransition,
} from "./transition.js";

export type RoundCommand =
  | {
      readonly type: "negotiation_timed_out";
      readonly occurredAt: UtcTimestamp;
    }
  | {
      readonly type: "normal_ballot_submitted";
      readonly voterId: UserId;
      readonly targetId: UserId;
      readonly occurredAt: UtcTimestamp;
    }
  | {
      readonly type: "voting_timed_out";
      readonly occurredAt: UtcTimestamp;
    };

export type RoundEvent =
  | {
      readonly type: "match.phase_changed";
      readonly phase: "voting" | "tally";
      readonly deadline: UtcTimestamp | null;
    }
  | {
      readonly type: "normal_ballot.acknowledged";
      readonly recipientUserId: UserId;
      readonly ballotTargetId: UserId;
      readonly revision: number;
    };

export type RoundTransition = MatchTransition<RoundEvent>;

type InvalidRoundReason =
  | "deadline_not_reached"
  | "deadline_out_of_range"
  | "deadline_passed"
  | "self_vote"
  | "target_not_eligible"
  | "voter_not_eligible"
  | "wrong_phase";

export type InvalidRoundCommandError = DomainError<
  "invalid_round_command",
  { readonly reason: InvalidRoundReason }
>;

const NO_EVENTS: readonly RoundEvent[] = Object.freeze([]);

function invalid(reason: InvalidRoundReason): InvalidRoundCommandError {
  return domainError("invalid_round_command", "Round command is not valid", {
    reason,
  });
}

function activePlayerIds(state: MatchState): readonly UserId[] {
  return state.roster
    .filter(({ status }) => status === "active")
    .map(({ playerId }) => playerId);
}

function closeVoting(
  state: MatchState,
  normalBallots: readonly NormalBallot[],
  events: readonly RoundEvent[],
): RoundTransition {
  const voters = new Set(normalBallots.map(({ voterId }) => voterId));
  const missingNormalBallotPlayerIds = Object.freeze(
    activePlayerIds(state).filter((playerId) => !voters.has(playerId)),
  );

  return createMatchTransition(
    state,
    {
      phase: "tally",
      phaseDeadline: null,
      normalBallots,
      missingNormalBallotPlayerIds,
    },
    [
      ...events,
      { type: "match.phase_changed", phase: "tally", deadline: null },
    ],
  );
}

export function applyRoundCommand(
  state: MatchState,
  command: RoundCommand,
): Result<RoundTransition, InvalidRoundCommandError> {
  if (command.type === "negotiation_timed_out") {
    if (state.phase !== "negotiation" || state.phaseDeadline === null) {
      return err(invalid("wrong_phase"));
    }
    if (command.occurredAt < state.phaseDeadline) {
      return err(invalid("deadline_not_reached"));
    }

    const deadline = deadlineAfterSeconds(
      command.occurredAt,
      state.rulesetSnapshot.phaseDurationsSeconds.voting,
    );
    if (!deadline.ok) {
      return err(invalid("deadline_out_of_range"));
    }
    return ok(
      createMatchTransition(
        state,
        {
          phase: "voting",
          phaseDeadline: deadline.value,
          normalBallots: Object.freeze([]),
          missingNormalBallotPlayerIds: Object.freeze([]),
        },
        [
          {
            type: "match.phase_changed",
            phase: "voting",
            deadline: deadline.value,
          },
        ],
      ),
    );
  }

  if (state.phase !== "voting" || state.phaseDeadline === null) {
    return err(invalid("wrong_phase"));
  }
  if (command.type === "voting_timed_out") {
    return command.occurredAt < state.phaseDeadline
      ? err(invalid("deadline_not_reached"))
      : ok(closeVoting(state, state.normalBallots, NO_EVENTS));
  }
  if (command.occurredAt >= state.phaseDeadline) {
    return err(invalid("deadline_passed"));
  }

  const activeIds = activePlayerIds(state);
  if (!activeIds.includes(command.voterId)) {
    return err(invalid("voter_not_eligible"));
  }
  if (!activeIds.includes(command.targetId)) {
    return err(invalid("target_not_eligible"));
  }
  if (command.voterId === command.targetId) {
    return err(invalid("self_vote"));
  }

  const existing = state.normalBallots.find(
    ({ voterId }) => voterId === command.voterId,
  );
  if (existing?.targetId === command.targetId) {
    return ok(Object.freeze({ state, events: NO_EVENTS }));
  }

  const ballot = Object.freeze({
    voterId: command.voterId,
    targetId: command.targetId,
    revision: (existing?.revision ?? 0) + 1,
    submittedAt: command.occurredAt,
  });
  const ballotsByVoter = new Map(
    state.normalBallots.map((current) => [current.voterId, current]),
  );
  ballotsByVoter.set(command.voterId, ballot);
  const normalBallots = Object.freeze(
    activeIds.flatMap((playerId) => {
      const current = ballotsByVoter.get(playerId);
      return current === undefined ? [] : [current];
    }),
  );
  const events = [
    {
      type: "normal_ballot.acknowledged",
      recipientUserId: command.voterId,
      ballotTargetId: command.targetId,
      revision: ballot.revision,
    },
  ] as const;

  return ok(
    normalBallots.length === activeIds.length
      ? closeVoting(state, normalBallots, events)
      : createMatchTransition(state, { normalBallots }, events),
  );
}
