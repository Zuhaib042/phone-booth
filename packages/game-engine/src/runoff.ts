import {
  domainError,
  drawRandomIndex,
  err,
  ok,
  type DomainError,
  type Result,
  type UserId,
  type UtcTimestamp,
} from "@project-booth/domain";

import type {
  EliminationVoteTotal,
  MatchState,
  RunoffBallot,
  TieResolution,
  TieResolutionMethod,
} from "./match-state.js";
import {
  createMatchTransition,
  deadlineAfterSeconds,
  type MatchTransition,
} from "./transition.js";

type ResolutionInput = {
  readonly occurredAt: UtcTimestamp;
  readonly randomSample?: number;
};

export type RunoffCommand =
  | ({ readonly type: "runoff_started" } & ResolutionInput)
  | {
      readonly type: "runoff_negotiation_timed_out";
      readonly occurredAt: UtcTimestamp;
    }
  | {
      readonly type: "runoff_ballot_submitted";
      readonly voterId: UserId;
      readonly targetId: UserId;
      readonly occurredAt: UtcTimestamp;
    }
  | ({ readonly type: "runoff_tallied" } & ResolutionInput);

export type RunoffEvent =
  | {
      readonly type: "match.phase_changed";
      readonly phase: "runoff_negotiation" | "runoff_voting" | "elimination";
      readonly deadline: UtcTimestamp;
    }
  | {
      readonly type: "runoff_ballot.acknowledged";
      readonly recipientUserId: UserId;
      readonly ballotTargetId: UserId;
      readonly revision: number;
    }
  | {
      readonly type: "runoff.resolved";
      readonly runoffVoteTotals: readonly EliminationVoteTotal[];
      readonly resolutionCandidatePlayerIds: readonly UserId[];
      readonly eliminatedPlayerId: UserId;
      readonly method: TieResolutionMethod;
      readonly randomSample: number | null;
    };

export type RunoffTransition = MatchTransition<RunoffEvent>;

type InvalidRunoffReason =
  | "deadline_not_reached"
  | "deadline_out_of_range"
  | "deadline_passed"
  | "invalid_random_sample"
  | "invalid_runoff_state"
  | "random_sample_required"
  | "target_not_eligible"
  | "voter_not_eligible"
  | "voting_incomplete"
  | "wrong_phase";

export type InvalidRunoffCommandError = DomainError<
  "invalid_runoff_command",
  { readonly reason: InvalidRunoffReason }
>;

const NO_EVENTS: readonly RunoffEvent[] = Object.freeze([]);

function invalid(reason: InvalidRunoffReason): InvalidRunoffCommandError {
  return domainError("invalid_runoff_command", "Runoff command is not valid", {
    reason,
  });
}

function activePlayerIds(state: MatchState): readonly UserId[] {
  return state.roster.flatMap(({ playerId, status }) =>
    status === "active" ? [playerId] : [],
  );
}

function leaders(
  voteTotals: readonly EliminationVoteTotal[],
): readonly UserId[] {
  const highest = Math.max(...voteTotals.map(({ votes }) => votes));
  return Object.freeze(
    voteTotals.flatMap(({ playerId, votes }) =>
      votes === highest ? [playerId] : [],
    ),
  );
}

function resolveTie(
  state: MatchState,
  runoffPlayerIds: readonly UserId[],
  runoffVoteTotals: readonly EliminationVoteTotal[],
  candidates: readonly UserId[],
  input: ResolutionInput,
): Result<RunoffTransition, InvalidRunoffCommandError> {
  const runoffVotes = new Map(
    runoffVoteTotals.map(({ playerId, votes }) => [playerId, votes]),
  );
  const cumulativeEliminationVoteTotals = Object.freeze(
    state.cumulativeEliminationVoteTotals.map(({ playerId, votes }) =>
      Object.freeze({
        playerId,
        votes: votes + (runoffVotes.get(playerId) ?? 0),
      }),
    ),
  );
  const cumulative = new Map(
    cumulativeEliminationVoteTotals.map(({ playerId, votes }) => [
      playerId,
      votes,
    ]),
  );
  if (
    cumulative.size !== state.roster.length ||
    candidates.some((playerId) => !cumulative.has(playerId))
  ) {
    return err(invalid("invalid_runoff_state"));
  }

  let method: TieResolutionMethod = "runoff_vote";
  let resolutionCandidatePlayerIds = candidates;
  let randomSample: number | null = null;
  if (candidates.length > 1) {
    method = "cumulative_votes";
    const highestCumulative = Math.max(
      ...candidates.map((playerId) => cumulative.get(playerId) as number),
    );
    resolutionCandidatePlayerIds = Object.freeze(
      candidates.filter(
        (playerId) => cumulative.get(playerId) === highestCumulative,
      ),
    );
  }

  let eliminatedPlayerId = resolutionCandidatePlayerIds[0] as UserId;
  if (resolutionCandidatePlayerIds.length > 1) {
    if (input.randomSample === undefined) {
      return err(invalid("random_sample_required"));
    }
    const draw = drawRandomIndex(
      { nextUnitInterval: () => input.randomSample as number },
      resolutionCandidatePlayerIds.length,
    );
    if (!draw.ok) {
      return err(invalid("invalid_random_sample"));
    }
    method = "random_draw";
    randomSample = input.randomSample;
    eliminatedPlayerId = resolutionCandidatePlayerIds[draw.value] as UserId;
  }

  const deadline = deadlineAfterSeconds(
    input.occurredAt,
    state.rulesetSnapshot.phaseDurationsSeconds.eliminationReveal,
  );
  if (!deadline.ok) {
    return err(invalid("deadline_out_of_range"));
  }
  const roster = Object.freeze(
    state.roster.map((entry) =>
      entry.playerId === eliminatedPlayerId
        ? Object.freeze({ ...entry, status: "eliminated" as const })
        : entry,
    ),
  );
  const tieResolution: TieResolution = Object.freeze({
    runoffVoteTotals,
    resolutionCandidatePlayerIds,
    eliminatedPlayerId,
    method,
    randomSample,
  });

  return ok(
    createMatchTransition(
      state,
      {
        phase: "elimination",
        phaseDeadline: deadline.value,
        roster,
        runoffPlayerIds,
        tieResolution,
        cumulativeEliminationVoteTotals,
      },
      [
        {
          type: "runoff.resolved",
          runoffVoteTotals,
          resolutionCandidatePlayerIds,
          eliminatedPlayerId,
          method,
          randomSample,
        },
        {
          type: "match.phase_changed",
          phase: "elimination",
          deadline: deadline.value,
        },
      ],
    ),
  );
}

function validRunoffBallots(
  ballots: readonly RunoffBallot[],
  voters: readonly UserId[],
  targets: readonly UserId[],
): boolean {
  const seen = new Set<UserId>();
  return ballots.every(({ voterId, targetId }) => {
    if (
      !voters.includes(voterId) ||
      !targets.includes(targetId) ||
      seen.has(voterId)
    ) {
      return false;
    }
    seen.add(voterId);
    return true;
  });
}

export function applyRunoffCommand(
  state: MatchState,
  command: RunoffCommand,
): Result<RunoffTransition, InvalidRunoffCommandError> {
  if (
    state.phase === "elimination" &&
    state.tieResolution !== null &&
    (command.type === "runoff_started" || command.type === "runoff_tallied")
  ) {
    return ok(Object.freeze({ state, events: NO_EVENTS }));
  }

  if (command.type === "runoff_started") {
    const tiedPlayerIds = state.normalTally?.leaderPlayerIds;
    if (
      state.phase !== "tally" ||
      state.normalTally?.eliminatedPlayerId !== null ||
      tiedPlayerIds === undefined ||
      tiedPlayerIds.length < 2
    ) {
      return err(invalid("wrong_phase"));
    }
    const activeIds = activePlayerIds(state);
    if (tiedPlayerIds.some((playerId) => !activeIds.includes(playerId))) {
      return err(invalid("invalid_runoff_state"));
    }
    if (tiedPlayerIds.length === activeIds.length) {
      return resolveTie(
        state,
        tiedPlayerIds,
        Object.freeze([]),
        tiedPlayerIds,
        command,
      );
    }

    const deadline = deadlineAfterSeconds(
      command.occurredAt,
      state.rulesetSnapshot.phaseDurationsSeconds.runoffNegotiation,
    );
    if (!deadline.ok) {
      return err(invalid("deadline_out_of_range"));
    }
    return ok(
      createMatchTransition(
        state,
        {
          phase: "runoff_negotiation",
          phaseDeadline: deadline.value,
          runoffPlayerIds: tiedPlayerIds,
          runoffBallots: Object.freeze([]),
          tieResolution: null,
        },
        [
          {
            type: "match.phase_changed",
            phase: "runoff_negotiation",
            deadline: deadline.value,
          },
        ],
      ),
    );
  }

  if (command.type === "runoff_negotiation_timed_out") {
    if (state.phase !== "runoff_negotiation" || state.phaseDeadline === null) {
      return err(invalid("wrong_phase"));
    }
    if (command.occurredAt < state.phaseDeadline) {
      return err(invalid("deadline_not_reached"));
    }
    const deadline = deadlineAfterSeconds(
      command.occurredAt,
      state.rulesetSnapshot.phaseDurationsSeconds.runoffVoting,
    );
    if (!deadline.ok) {
      return err(invalid("deadline_out_of_range"));
    }
    return ok(
      createMatchTransition(
        state,
        { phase: "runoff_voting", phaseDeadline: deadline.value },
        [
          {
            type: "match.phase_changed",
            phase: "runoff_voting",
            deadline: deadline.value,
          },
        ],
      ),
    );
  }

  if (state.phase !== "runoff_voting" || state.phaseDeadline === null) {
    return err(invalid("wrong_phase"));
  }
  const voters = activePlayerIds(state).filter(
    (playerId) => !state.runoffPlayerIds.includes(playerId),
  );
  if (!validRunoffBallots(state.runoffBallots, voters, state.runoffPlayerIds)) {
    return err(invalid("invalid_runoff_state"));
  }

  if (command.type === "runoff_ballot_submitted") {
    if (command.occurredAt >= state.phaseDeadline) {
      return err(invalid("deadline_passed"));
    }
    if (!voters.includes(command.voterId)) {
      return err(invalid("voter_not_eligible"));
    }
    if (!state.runoffPlayerIds.includes(command.targetId)) {
      return err(invalid("target_not_eligible"));
    }
    const existing = state.runoffBallots.find(
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
    const ballots = new Map(
      state.runoffBallots.map((current) => [current.voterId, current]),
    );
    ballots.set(command.voterId, ballot);
    const runoffBallots = Object.freeze(
      voters.flatMap((playerId) => {
        const current = ballots.get(playerId);
        return current === undefined ? [] : [current];
      }),
    );
    return ok(
      createMatchTransition(state, { runoffBallots }, [
        {
          type: "runoff_ballot.acknowledged",
          recipientUserId: command.voterId,
          ballotTargetId: command.targetId,
          revision: ballot.revision,
        },
      ]),
    );
  }

  if (
    command.occurredAt < state.phaseDeadline &&
    state.runoffBallots.length < voters.length
  ) {
    return err(invalid("voting_incomplete"));
  }
  const counts = new Map(
    state.runoffPlayerIds.map((playerId) => [playerId, 0]),
  );
  for (const { targetId } of state.runoffBallots) {
    counts.set(targetId, (counts.get(targetId) as number) + 1);
  }
  const runoffVoteTotals = Object.freeze(
    state.runoffPlayerIds.map((playerId) =>
      Object.freeze({ playerId, votes: counts.get(playerId) as number }),
    ),
  );
  return resolveTie(
    state,
    state.runoffPlayerIds,
    runoffVoteTotals,
    leaders(runoffVoteTotals),
    command,
  );
}
