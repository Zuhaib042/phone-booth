import {
  domainError,
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
  NormalTallyResult,
} from "./match-state.js";
import {
  createMatchTransition,
  deadlineAfterSeconds,
  type MatchTransition,
} from "./transition.js";

export interface TallyCommand {
  readonly type: "normal_ballots_tallied";
  readonly occurredAt: UtcTimestamp;
}

export type TallyEvent =
  | {
      readonly type: "normal_tally.completed";
      readonly outcome: "elimination";
      readonly voteTotals: readonly EliminationVoteTotal[];
      readonly eliminatedPlayerId: UserId;
    }
  | {
      readonly type: "normal_tally.completed";
      readonly outcome: "tie";
      readonly voteTotals: readonly EliminationVoteTotal[];
      readonly tiedPlayerIds: readonly UserId[];
    }
  | {
      readonly type: "match.phase_changed";
      readonly phase: "elimination";
      readonly deadline: UtcTimestamp;
    };

export type TallyTransition = MatchTransition<TallyEvent>;

type InvalidTallyReason =
  "deadline_out_of_range" | "invalid_tally_state" | "wrong_phase";

export type InvalidTallyCommandError = DomainError<
  "invalid_tally_command",
  { readonly reason: InvalidTallyReason }
>;

const NO_EVENTS: readonly TallyEvent[] = Object.freeze([]);

function invalid(reason: InvalidTallyReason): InvalidTallyCommandError {
  return domainError("invalid_tally_command", "Tally command is not valid", {
    reason,
  });
}

function validTallyState(
  state: MatchState,
  activePlayerIds: readonly UserId[],
): boolean {
  const active = new Set(activePlayerIds);
  const voters = new Set<UserId>();
  for (const ballot of state.normalBallots) {
    if (
      !active.has(ballot.voterId) ||
      !active.has(ballot.targetId) ||
      ballot.voterId === ballot.targetId ||
      voters.has(ballot.voterId)
    ) {
      return false;
    }
    voters.add(ballot.voterId);
  }

  const missing = new Set<UserId>();
  for (const playerId of state.missingNormalBallotPlayerIds) {
    if (!active.has(playerId) || missing.has(playerId)) {
      return false;
    }
    missing.add(playerId);
  }

  return activePlayerIds.every(
    (playerId) => voters.has(playerId) !== missing.has(playerId),
  );
}

export function applyTallyCommand(
  state: MatchState,
  command: TallyCommand,
): Result<TallyTransition, InvalidTallyCommandError> {
  if (
    state.normalTally !== null &&
    (state.phase === "tally" || state.phase === "elimination")
  ) {
    return ok(Object.freeze({ state, events: NO_EVENTS }));
  }
  if (state.phase !== "tally" || state.normalTally !== null) {
    return err(invalid("wrong_phase"));
  }

  const activePlayerIds = state.roster.flatMap(({ playerId, status }) =>
    status === "active" ? [playerId] : [],
  );
  if (!validTallyState(state, activePlayerIds)) {
    return err(invalid("invalid_tally_state"));
  }

  const votes = new Map(activePlayerIds.map((playerId) => [playerId, 0]));
  for (const { targetId } of state.normalBallots) {
    votes.set(targetId, (votes.get(targetId) as number) + 1);
  }
  const automaticSelfVotes = Object.freeze(
    activePlayerIds.flatMap((playerId) =>
      state.missingNormalBallotPlayerIds.includes(playerId)
        ? [Object.freeze({ playerId, reason: "missed_normal_ballot" as const })]
        : [],
    ),
  );
  for (const { playerId } of automaticSelfVotes) {
    votes.set(playerId, (votes.get(playerId) as number) + 1);
  }

  const voteTotals = Object.freeze(
    activePlayerIds.map((playerId) =>
      Object.freeze({ playerId, votes: votes.get(playerId) as number }),
    ),
  );
  const highestVoteTotal = Math.max(...voteTotals.map(({ votes }) => votes));
  const leaderPlayerIds = Object.freeze(
    voteTotals.flatMap(({ playerId, votes }) =>
      votes === highestVoteTotal ? [playerId] : [],
    ),
  );
  const eliminatedPlayerId =
    leaderPlayerIds.length === 1 ? (leaderPlayerIds[0] as UserId) : null;
  const normalTally: NormalTallyResult = Object.freeze({
    automaticSelfVotes,
    voteTotals,
    leaderPlayerIds,
    eliminatedPlayerId,
  });
  const roundVotes = new Map(
    voteTotals.map(({ playerId, votes }) => [playerId, votes]),
  );
  const cumulativeEliminationVoteTotals = Object.freeze(
    state.cumulativeEliminationVoteTotals.map(({ playerId, votes }) =>
      Object.freeze({
        playerId,
        votes: votes + (roundVotes.get(playerId) ?? 0),
      }),
    ),
  );

  if (eliminatedPlayerId === null) {
    return ok(
      createMatchTransition(
        state,
        { normalTally, cumulativeEliminationVoteTotals },
        [
          {
            type: "normal_tally.completed",
            outcome: "tie",
            voteTotals,
            tiedPlayerIds: leaderPlayerIds,
          },
        ],
      ),
    );
  }

  const deadline = deadlineAfterSeconds(
    command.occurredAt,
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

  return ok(
    createMatchTransition(
      state,
      {
        phase: "elimination",
        phaseDeadline: deadline.value,
        roster,
        normalTally,
        cumulativeEliminationVoteTotals,
      },
      [
        {
          type: "normal_tally.completed",
          outcome: "elimination",
          voteTotals,
          eliminatedPlayerId,
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
