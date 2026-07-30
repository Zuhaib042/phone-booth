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
  CompletedRound,
  EliminationVoteTotal,
  FinalPlea,
  JuryBallot,
  JuryResolutionMethod,
  JuryResult,
  MatchState,
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

export type FinaleCommand =
  | {
      readonly type: "elimination_reveal_timed_out";
      readonly occurredAt: UtcTimestamp;
    }
  | {
      readonly type: "final_plea_submitted";
      readonly playerId: UserId;
      readonly text: string;
      readonly occurredAt: UtcTimestamp;
    }
  | {
      readonly type: "final_plea_timed_out";
      readonly occurredAt: UtcTimestamp;
    }
  | {
      readonly type: "jury_ballot_submitted";
      readonly jurorId: UserId;
      readonly finalistId: UserId;
      readonly occurredAt: UtcTimestamp;
    }
  | ({ readonly type: "jury_tallied" } & ResolutionInput);

export type FinaleEvent =
  | {
      readonly type: "match.phase_changed";
      readonly phase: "negotiation" | "final_plea" | "jury_voting" | "complete";
      readonly deadline: UtcTimestamp | null;
    }
  | {
      readonly type: "final_plea.acknowledged";
      readonly recipientUserId: UserId;
    }
  | {
      readonly type: "jury_ballot.acknowledged";
      readonly recipientUserId: UserId;
      readonly ballotTargetId: UserId;
      readonly revision: number;
    }
  | {
      readonly type: "jury.resolved";
      readonly voteTotals: readonly EliminationVoteTotal[];
      readonly resolutionCandidatePlayerIds: readonly UserId[];
      readonly winnerPlayerId: UserId;
      readonly method: JuryResolutionMethod;
      readonly randomSample: number | null;
    };

export type FinaleTransition = MatchTransition<FinaleEvent>;

type InvalidFinaleReason =
  | "deadline_not_reached"
  | "deadline_out_of_range"
  | "deadline_passed"
  | "finalist_not_eligible"
  | "invalid_finale_state"
  | "invalid_random_sample"
  | "juror_not_eligible"
  | "plea_empty"
  | "plea_too_long"
  | "random_sample_required"
  | "voting_incomplete"
  | "wrong_phase";

export type InvalidFinaleCommandError = DomainError<
  "invalid_finale_command",
  { readonly reason: InvalidFinaleReason }
>;

const NO_EVENTS: readonly FinaleEvent[] = Object.freeze([]);

function invalid(reason: InvalidFinaleReason): InvalidFinaleCommandError {
  return domainError("invalid_finale_command", "Finale command is not valid", {
    reason,
  });
}

function playersWithStatus(
  state: MatchState,
  status: "active" | "eliminated",
): readonly UserId[] {
  return state.roster.flatMap((entry) =>
    entry.status === status ? [entry.playerId] : [],
  );
}

function archiveRound(
  state: MatchState,
): Result<CompletedRound, InvalidFinaleCommandError> {
  const eliminatedPlayerId =
    state.normalTally?.eliminatedPlayerId ??
    state.tieResolution?.eliminatedPlayerId;
  if (
    state.normalTally === null ||
    eliminatedPlayerId === undefined ||
    state.roster.find(({ playerId }) => playerId === eliminatedPlayerId)
      ?.status !== "eliminated"
  ) {
    return err(invalid("invalid_finale_state"));
  }
  return ok(
    Object.freeze({
      normalBallots: state.normalBallots,
      automaticSelfVotes: state.normalTally.automaticSelfVotes,
      normalVoteTotals: state.normalTally.voteTotals,
      runoffPlayerIds: state.runoffPlayerIds,
      runoffBallots: state.runoffBallots,
      runoffVoteTotals:
        state.tieResolution?.runoffVoteTotals ?? Object.freeze([]),
      eliminatedPlayerId,
      tieResolutionMethod: state.tieResolution?.method ?? null,
    }),
  );
}

function startJuryVoting(
  state: MatchState,
  occurredAt: UtcTimestamp,
  finalPleas: readonly FinalPlea[],
  events: readonly FinaleEvent[],
): Result<FinaleTransition, InvalidFinaleCommandError> {
  const deadline = deadlineAfterSeconds(
    occurredAt,
    state.rulesetSnapshot.phaseDurationsSeconds.juryVoting,
  );
  if (!deadline.ok) {
    return err(invalid("deadline_out_of_range"));
  }
  return ok(
    createMatchTransition(
      state,
      {
        phase: "jury_voting",
        phaseDeadline: deadline.value,
        finalPleas,
        juryBallots: Object.freeze([]),
        juryResult: null,
        winnerPlayerId: null,
      },
      [
        ...events,
        {
          type: "match.phase_changed",
          phase: "jury_voting",
          deadline: deadline.value,
        },
      ],
    ),
  );
}

function resolveJury(
  state: MatchState,
  voteTotals: readonly EliminationVoteTotal[],
  input: ResolutionInput,
): Result<FinaleTransition, InvalidFinaleCommandError> {
  const cumulative = new Map(
    state.cumulativeEliminationVoteTotals.map(({ playerId, votes }) => [
      playerId,
      votes,
    ]),
  );
  if (cumulative.size !== state.roster.length) {
    return err(invalid("invalid_finale_state"));
  }
  const highestVotes = Math.max(...voteTotals.map(({ votes }) => votes));
  let candidates = Object.freeze(
    voteTotals.flatMap(({ playerId, votes }) =>
      votes === highestVotes ? [playerId] : [],
    ),
  );
  let method: JuryResolutionMethod = "jury_vote";
  if (candidates.length > 1) {
    method = "cumulative_votes";
    const fewest = Math.min(
      ...candidates.map((playerId) => cumulative.get(playerId) as number),
    );
    candidates = Object.freeze(
      candidates.filter((playerId) => cumulative.get(playerId) === fewest),
    );
  }
  if (candidates.length > 1) {
    method = "missed_ballots";
    const missed = new Map<UserId, number>();
    for (const round of state.completedRounds) {
      for (const { playerId } of round.automaticSelfVotes) {
        missed.set(playerId, (missed.get(playerId) ?? 0) + 1);
      }
    }
    const fewest = Math.min(
      ...candidates.map((playerId) => missed.get(playerId) ?? 0),
    );
    candidates = Object.freeze(
      candidates.filter((playerId) => (missed.get(playerId) ?? 0) === fewest),
    );
  }

  let winnerPlayerId = candidates[0] as UserId;
  let randomSample: number | null = null;
  if (candidates.length > 1) {
    if (input.randomSample === undefined) {
      return err(invalid("random_sample_required"));
    }
    const draw = drawRandomIndex(
      { nextUnitInterval: () => input.randomSample as number },
      candidates.length,
    );
    if (!draw.ok) {
      return err(invalid("invalid_random_sample"));
    }
    method = "random_draw";
    randomSample = input.randomSample;
    winnerPlayerId = candidates[draw.value] as UserId;
  }
  const juryResult: JuryResult = Object.freeze({
    voteTotals,
    resolutionCandidatePlayerIds: candidates,
    winnerPlayerId,
    method,
    randomSample,
  });
  return ok(
    createMatchTransition(
      state,
      {
        phase: "complete",
        phaseDeadline: null,
        juryResult,
        winnerPlayerId,
      },
      [
        { type: "jury.resolved", ...juryResult },
        { type: "match.phase_changed", phase: "complete", deadline: null },
      ],
    ),
  );
}

export function applyFinaleCommand(
  state: MatchState,
  command: FinaleCommand,
): Result<FinaleTransition, InvalidFinaleCommandError> {
  if (
    state.phase === "complete" &&
    state.juryResult !== null &&
    command.type === "jury_tallied"
  ) {
    return ok(Object.freeze({ state, events: NO_EVENTS }));
  }

  if (command.type === "elimination_reveal_timed_out") {
    if (state.phase !== "elimination" || state.phaseDeadline === null) {
      return err(invalid("wrong_phase"));
    }
    if (command.occurredAt < state.phaseDeadline) {
      return err(invalid("deadline_not_reached"));
    }
    const archived = archiveRound(state);
    if (!archived.ok) {
      return archived;
    }
    const activePlayerIds = playersWithStatus(state, "active");
    if (activePlayerIds.length < 2) {
      return err(invalid("invalid_finale_state"));
    }
    const phase = activePlayerIds.length === 2 ? "final_plea" : "negotiation";
    const seconds =
      phase === "final_plea"
        ? state.rulesetSnapshot.phaseDurationsSeconds.finalPlea
        : state.rulesetSnapshot.phaseDurationsSeconds.laterNegotiation;
    const deadline = deadlineAfterSeconds(command.occurredAt, seconds);
    if (!deadline.ok) {
      return err(invalid("deadline_out_of_range"));
    }
    return ok(
      createMatchTransition(
        state,
        {
          phase,
          phaseDeadline: deadline.value,
          completedRounds: Object.freeze([
            ...state.completedRounds,
            archived.value,
          ]),
          finalPleas: Object.freeze([]),
          juryBallots: Object.freeze([]),
          juryResult: null,
          winnerPlayerId: null,
        },
        [{ type: "match.phase_changed", phase, deadline: deadline.value }],
      ),
    );
  }

  if (command.type === "final_plea_timed_out") {
    if (state.phase !== "final_plea" || state.phaseDeadline === null) {
      return err(invalid("wrong_phase"));
    }
    return command.occurredAt < state.phaseDeadline
      ? err(invalid("deadline_not_reached"))
      : startJuryVoting(state, command.occurredAt, state.finalPleas, NO_EVENTS);
  }

  if (command.type === "final_plea_submitted") {
    if (state.phase !== "final_plea" || state.phaseDeadline === null) {
      return err(invalid("wrong_phase"));
    }
    if (command.occurredAt >= state.phaseDeadline) {
      return err(invalid("deadline_passed"));
    }
    const finalists = playersWithStatus(state, "active");
    if (!finalists.includes(command.playerId)) {
      return err(invalid("finalist_not_eligible"));
    }
    if (command.text.trim().length === 0) {
      return err(invalid("plea_empty"));
    }
    if (
      command.text.length >
      state.rulesetSnapshot.communication.maximumTypedMessageCharacters
    ) {
      return err(invalid("plea_too_long"));
    }
    const existing = state.finalPleas.find(
      ({ playerId }) => playerId === command.playerId,
    );
    if (existing?.text === command.text) {
      return ok(Object.freeze({ state, events: NO_EVENTS }));
    }
    const pleas = new Map(
      state.finalPleas.map((plea) => [plea.playerId, plea]),
    );
    pleas.set(
      command.playerId,
      Object.freeze({
        playerId: command.playerId,
        text: command.text,
        submittedAt: command.occurredAt,
      }),
    );
    const finalPleas = Object.freeze(
      finalists.flatMap((playerId) => {
        const plea = pleas.get(playerId);
        return plea === undefined ? [] : [plea];
      }),
    );
    const events = [
      {
        type: "final_plea.acknowledged",
        recipientUserId: command.playerId,
      },
    ] as const;
    return finalPleas.length === finalists.length
      ? startJuryVoting(state, command.occurredAt, finalPleas, events)
      : ok(createMatchTransition(state, { finalPleas }, events));
  }

  if (state.phase !== "jury_voting" || state.phaseDeadline === null) {
    return err(invalid("wrong_phase"));
  }
  const jurors = playersWithStatus(state, "eliminated");
  const finalists = playersWithStatus(state, "active");
  if (finalists.length !== 2) {
    return err(invalid("invalid_finale_state"));
  }

  if (command.type === "jury_ballot_submitted") {
    if (command.occurredAt >= state.phaseDeadline) {
      return err(invalid("deadline_passed"));
    }
    if (!jurors.includes(command.jurorId)) {
      return err(invalid("juror_not_eligible"));
    }
    if (!finalists.includes(command.finalistId)) {
      return err(invalid("finalist_not_eligible"));
    }
    const existing = state.juryBallots.find(
      ({ jurorId }) => jurorId === command.jurorId,
    );
    if (existing?.finalistId === command.finalistId) {
      return ok(Object.freeze({ state, events: NO_EVENTS }));
    }
    const ballot: JuryBallot = Object.freeze({
      jurorId: command.jurorId,
      finalistId: command.finalistId,
      revision: (existing?.revision ?? 0) + 1,
      submittedAt: command.occurredAt,
    });
    const ballots = new Map(
      state.juryBallots.map((current) => [current.jurorId, current]),
    );
    ballots.set(command.jurorId, ballot);
    const juryBallots = Object.freeze(
      jurors.flatMap((jurorId) => {
        const current = ballots.get(jurorId);
        return current === undefined ? [] : [current];
      }),
    );
    return ok(
      createMatchTransition(state, { juryBallots }, [
        {
          type: "jury_ballot.acknowledged",
          recipientUserId: command.jurorId,
          ballotTargetId: command.finalistId,
          revision: ballot.revision,
        },
      ]),
    );
  }

  if (
    command.occurredAt < state.phaseDeadline &&
    state.juryBallots.length < jurors.length
  ) {
    return err(invalid("voting_incomplete"));
  }
  const counts = new Map(finalists.map((playerId) => [playerId, 0]));
  for (const { finalistId } of state.juryBallots) {
    counts.set(finalistId, (counts.get(finalistId) as number) + 1);
  }
  const voteTotals = Object.freeze(
    finalists.map((playerId) =>
      Object.freeze({ playerId, votes: counts.get(playerId) as number }),
    ),
  );
  return resolveJury(state, voteTotals, command);
}
