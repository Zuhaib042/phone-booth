import assert from "node:assert/strict";
import test from "node:test";

import { parseRulesetV1, type RulesetV1 } from "@project-booth/config";
import {
  parseEntityId,
  parseUtcTimestamp,
  type EntityId,
  type MatchId,
  type Result,
  type UserId,
  type UtcTimestamp,
} from "@project-booth/domain";

import {
  applyFinaleCommand,
  applyLobbyCommand,
  applyRoundCommand,
  applyRunoffCommand,
  applyTallyCommand,
  createDossierProjection,
  createMatchState,
  simulateHeadlessMatch,
  INITIAL_MATCH_VERSION,
  type LobbyTransition,
  type MatchState,
  type FinaleTransition,
  type DossierDealRecord,
  type RoundTransition,
  type RunoffTransition,
  type TallyTransition,
} from "../src/index.js";

const RULESET_INPUT = {
  schemaVersion: 1,
  rulesetId: "019824d0-7c1a-7a91-8c4a-3fe0f1b51e22",
  rulesetVersion: 1,
  roster: { contestantCount: 6, minimumReadyCount: 4 },
  phaseDurationsSeconds: {
    firstNegotiation: 120,
    laterNegotiation: 90,
    voting: 20,
    eliminationReveal: 10,
    runoffNegotiation: 30,
    runoffVoting: 15,
    finalPlea: 60,
    juryVoting: 20,
    reconnectGrace: 30,
  },
  communication: { maximumTypedMessageCharacters: 240 },
  economy: {
    references: {
      matchOutflowCap: "economy.match_outflow_cap.standard",
      minimumOfferIncrement: "economy.minimum_offer_increment.standard",
      matchCompletionReward: "economy.reward.match_completion.standard",
      placementReward: "economy.reward.placement.standard",
      winnerReward: "economy.reward.winner.standard",
    },
    rules: {
      outgoingLimitBasis: "cumulative_outgoing",
      incomingTransfersRestoreAllowance: false,
      inMatchPurchasesAvailability: "next_match",
      reversalRestoresAllowance: true,
      acceptedOfferSettlement: "any_valid_ballot",
      promisedTargetEnforced: false,
      missedBallotSettlement: "reverse",
    },
  },
} as const;

function id<Entity extends string>(
  entity: Entity,
  suffix: number,
): EntityId<Entity> {
  const result = parseEntityId(
    entity,
    `019824d0-7c1a-7a91-8c4a-${suffix.toString().padStart(12, "0")}`,
  );
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error("test identifier must be valid");
  }
  return result.value;
}

function ruleset(): RulesetV1 {
  const result = parseRulesetV1(structuredClone(RULESET_INPUT));
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error("test ruleset must be valid");
  }
  return result.value;
}

const matchId = id("match", 100) as MatchId;
const playerIds = Array.from({ length: 6 }, (_, index) =>
  id("user", index + 1),
) as UserId[];
const lobbyDeadline = timestamp("2026-07-24T12:01:00.000Z");
const readyAt = timestamp("2026-07-24T12:00:10.000Z");

function timestamp(value: string): UtcTimestamp {
  const result = parseUtcTimestamp(value);
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error("test timestamp must be valid");
  }
  return result.value;
}

function initialState(): MatchState {
  return success(
    createMatchState({
      matchId,
      ruleset: ruleset(),
      playerIds,
      lobbyDeadline,
    }),
  );
}

function success<Value, ErrorValue>(result: Result<Value, ErrorValue>): Value {
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error("test command must succeed");
  }
  return result.value;
}

function ready(
  state: MatchState,
  playerId: UserId,
  occurredAt = readyAt,
): LobbyTransition {
  return success(
    applyLobbyCommand(state, {
      type: "contestant_ready",
      playerId,
      occurredAt,
    }),
  );
}

test("constructs the documented immutable initial match state", () => {
  const result = createMatchState({
    matchId,
    ruleset: ruleset(),
    playerIds,
    lobbyDeadline,
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.equal(result.value.version, INITIAL_MATCH_VERSION);
  assert.equal(result.value.phase, "lobby");
  assert.equal(result.value.phaseDeadline, lobbyDeadline);
  assert.deepEqual(result.value.readyPlayerIds, []);
  assert.deepEqual(result.value.normalBallots, []);
  assert.deepEqual(result.value.missingNormalBallotPlayerIds, []);
  assert.equal(result.value.normalTally, null);
  assert.deepEqual(
    result.value.cumulativeEliminationVoteTotals,
    playerIds.map((playerId) => ({ playerId, votes: 0 })),
  );
  assert.deepEqual(result.value.runoffPlayerIds, []);
  assert.deepEqual(result.value.runoffBallots, []);
  assert.equal(result.value.tieResolution, null);
  assert.deepEqual(result.value.completedRounds, []);
  assert.deepEqual(result.value.finalPleas, []);
  assert.deepEqual(result.value.juryBallots, []);
  assert.equal(result.value.juryResult, null);
  assert.equal(result.value.winnerPlayerId, null);
  assert.deepEqual(
    result.value.roster.map(({ playerId, status }) => ({ playerId, status })),
    playerIds.map((playerId) => ({ playerId, status: "active" })),
  );
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.roster), true);
  assert.equal(result.value.roster.every(Object.isFrozen), true);
});

test("rejects rosters smaller or larger than the ruleset", () => {
  for (const invalidPlayers of [
    playerIds.slice(0, 5),
    [...playerIds, id("user", 7)],
  ]) {
    assert.deepEqual(
      createMatchState({
        matchId,
        ruleset: ruleset(),
        playerIds: invalidPlayers,
        lobbyDeadline,
      }),
      {
        ok: false,
        error: {
          code: "invalid_roster_size",
          message: "Roster size must match the ruleset contestant count",
          details: { expected: 6, actual: invalidPlayers.length },
        },
      },
    );
  }
});

test("rejects a duplicate player without reordering the roster", () => {
  const duplicatePlayers = [...playerIds.slice(0, 5), playerIds[0] as UserId];

  assert.deepEqual(
    createMatchState({
      matchId,
      ruleset: ruleset(),
      playerIds: duplicatePlayers,
      lobbyDeadline,
    }),
    {
      ok: false,
      error: {
        code: "duplicate_roster_player",
        message: "Roster players must be unique",
        details: { playerId: playerIds[0] },
      },
    },
  );
});

test("snapshots ruleset values instead of retaining mutable input", () => {
  const source = ruleset();
  const result = createMatchState({
    matchId,
    ruleset: source,
    playerIds,
    lobbyDeadline,
  });
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  (source.roster as { contestantCount: number }).contestantCount = 8;

  assert.equal(result.value.rulesetSnapshot.roster.contestantCount, 6);
  assert.equal(Object.isFrozen(result.value.rulesetSnapshot), true);
  assert.equal(
    Object.isFrozen(result.value.rulesetSnapshot.economy.references),
    true,
  );
});

test("identical inputs construct structurally identical state", () => {
  const first = createMatchState({
    matchId,
    ruleset: ruleset(),
    playerIds,
    lobbyDeadline,
  });
  const second = createMatchState({
    matchId,
    ruleset: ruleset(),
    playerIds,
    lobbyDeadline,
  });

  assert.deepEqual(first, second);
});

test("records readiness in roster order with one versioned event", () => {
  const first = ready(initialState(), playerIds[2] as UserId);
  const second = ready(
    first.state,
    playerIds[0] as UserId,
    timestamp("2026-07-24T12:00:20.000Z"),
  );

  assert.equal(second.state.version, 3);
  assert.deepEqual(second.state.readyPlayerIds, [playerIds[0], playerIds[2]]);
  assert.deepEqual(second.events, [
    { type: "lobby.contestant_ready", playerId: playerIds[0] },
  ]);
  assert.equal(Object.isFrozen(second.state.readyPlayerIds), true);
  assert.equal(Object.isFrozen(second.events), true);
  assert.equal(second.events.every(Object.isFrozen), true);
});

test("a duplicate ready command is an idempotent no-op", () => {
  const first = ready(initialState(), playerIds[0] as UserId);
  const duplicate = ready(
    first.state,
    playerIds[0] as UserId,
    timestamp("2026-07-24T12:00:20.000Z"),
  );

  assert.equal(duplicate.state, first.state);
  assert.equal(duplicate.state.version, 2);
  assert.deepEqual(duplicate.events, []);
});

function readyPlayers(count: number): MatchState {
  let state = initialState();
  for (const playerId of playerIds.slice(0, count)) {
    state = ready(state, playerId).state;
  }
  return state;
}

test("an all-ready roster starts the first negotiation deterministically", () => {
  const first = readyPlayers(6);
  const second = readyPlayers(6);

  assert.deepEqual(first, second);
  assert.equal(first.phase, "negotiation");
  assert.equal(first.phaseDeadline, "2026-07-24T12:02:10.000Z");
  assert.equal(first.version, 7);
  assert.deepEqual(first.readyPlayerIds, playerIds);
});

test("lobby timeout starts with the minimum roster or cancels below it", () => {
  const start = success(
    applyLobbyCommand(readyPlayers(4), {
      type: "lobby_timed_out",
      occurredAt: lobbyDeadline,
    }),
  );
  const cancel = success(
    applyLobbyCommand(readyPlayers(3), {
      type: "lobby_timed_out",
      occurredAt: lobbyDeadline,
    }),
  );

  assert.equal(start.state.phase, "negotiation");
  assert.equal(start.state.phaseDeadline, "2026-07-24T12:03:00.000Z");
  assert.deepEqual(start.events, [
    {
      type: "match.phase_changed",
      phase: "negotiation",
      deadline: "2026-07-24T12:03:00.000Z",
    },
  ]);
  assert.equal(
    start.state.roster.every(({ status }) => status === "active"),
    true,
  );
  assert.equal(cancel.state.phase, "cancelled");
  assert.equal(cancel.state.phaseDeadline, null);
  assert.deepEqual(cancel.events, [
    {
      type: "match.cancelled",
      reason: "insufficient_ready_contestants",
    },
  ]);
});

test("invalid lobby actors, times, and phases return structured errors", () => {
  const outsider = id("user", 99);
  const cases = [
    applyLobbyCommand(initialState(), {
      type: "contestant_ready",
      playerId: outsider,
      occurredAt: timestamp("2026-07-24T12:00:10.000Z"),
    }),
    applyLobbyCommand(initialState(), {
      type: "contestant_ready",
      playerId: playerIds[0] as UserId,
      occurredAt: lobbyDeadline,
    }),
    applyLobbyCommand(initialState(), {
      type: "lobby_timed_out",
      occurredAt: timestamp("2026-07-24T12:00:59.999Z"),
    }),
    applyLobbyCommand(readyPlayers(6), {
      type: "lobby_timed_out",
      occurredAt: lobbyDeadline,
    }),
  ];

  assert.deepEqual(
    cases.map((result) => (result.ok ? null : result.error.details.reason)),
    [
      "player_not_in_roster",
      "deadline_passed",
      "deadline_not_reached",
      "wrong_phase",
    ],
  );
});

function negotiationState(): MatchState {
  return readyPlayers(6);
}

function votingState(): MatchState {
  const state = negotiationState();
  return success(
    applyRoundCommand(state, {
      type: "negotiation_timed_out",
      occurredAt: state.phaseDeadline as UtcTimestamp,
    }),
  ).state;
}

function submitBallot(
  state: MatchState,
  voterId: UserId,
  targetId: UserId,
  occurredAt = timestamp("2026-07-24T12:02:15.000Z"),
): RoundTransition {
  return success(ballotResult(state, voterId, targetId, occurredAt));
}

function ballotResult(
  state: MatchState,
  voterId: UserId,
  targetId: UserId,
  occurredAt = timestamp("2026-07-24T12:02:15.000Z"),
) {
  return applyRoundCommand(state, {
    type: "normal_ballot_submitted",
    voterId,
    targetId,
    occurredAt,
  });
}

function player(index: number): UserId {
  return playerIds[index] as UserId;
}

test("negotiation closes into a versioned normal voting phase", () => {
  const state = negotiationState();
  const transition = success(
    applyRoundCommand(state, {
      type: "negotiation_timed_out",
      occurredAt: state.phaseDeadline as UtcTimestamp,
    }),
  );

  assert.equal(transition.state.phase, "voting");
  assert.equal(transition.state.phaseDeadline, "2026-07-24T12:02:30.000Z");
  assert.equal(transition.state.version, 8);
  assert.deepEqual(transition.state.normalBallots, []);
  assert.deepEqual(transition.events, [
    {
      type: "match.phase_changed",
      phase: "voting",
      deadline: "2026-07-24T12:02:30.000Z",
    },
  ]);
});

test("ballots stay canonical, private, revisable, and idempotent", () => {
  const first = submitBallot(votingState(), player(2), player(3));
  const second = submitBallot(first.state, player(0), player(1));
  const duplicate = submitBallot(second.state, player(0), player(1));
  const revision = submitBallot(
    duplicate.state,
    player(0),
    player(4),
    timestamp("2026-07-24T12:02:20.000Z"),
  );

  assert.deepEqual(
    second.state.normalBallots.map(({ voterId }) => voterId),
    [playerIds[0], playerIds[2]],
  );
  assert.equal(duplicate.state, second.state);
  assert.deepEqual(duplicate.events, []);
  assert.equal(revision.state.normalBallots.length, 2);
  assert.deepEqual(revision.events, [
    {
      type: "normal_ballot.acknowledged",
      recipientUserId: playerIds[0],
      ballotTargetId: playerIds[4],
      revision: 2,
    },
  ]);
  assert.equal(Object.isFrozen(revision.state.normalBallots), true);
  assert.equal(revision.state.normalBallots.every(Object.isFrozen), true);
});

function submitAllBallots(): RoundTransition {
  let state = votingState();
  let transition: RoundTransition | undefined;
  for (let index = 0; index < playerIds.length; index += 1) {
    transition = submitBallot(
      state,
      player(index),
      player((index + 1) % playerIds.length),
    );
    state = transition.state;
  }
  assert.notEqual(transition, undefined);
  return transition as RoundTransition;
}

test("all final ballots close voting deterministically without tallying", () => {
  const first = submitAllBallots();
  const second = submitAllBallots();

  assert.deepEqual(first, second);
  assert.equal(first.state.phase, "tally");
  assert.equal(first.state.phaseDeadline, null);
  assert.equal(first.state.normalBallots.length, 6);
  assert.deepEqual(first.state.missingNormalBallotPlayerIds, []);
  assert.deepEqual(first.events.at(-1), {
    type: "match.phase_changed",
    phase: "tally",
    deadline: null,
  });
});

test("voting timeout records missing voters without automatic ballots", () => {
  let state = votingState();
  state = submitBallot(state, player(0), player(1)).state;
  state = submitBallot(state, player(2), player(3)).state;

  const closed = success(
    applyRoundCommand(state, {
      type: "voting_timed_out",
      occurredAt: state.phaseDeadline as UtcTimestamp,
    }),
  );

  assert.equal(closed.state.phase, "tally");
  assert.equal(closed.state.normalBallots.length, 2);
  assert.deepEqual(closed.state.missingNormalBallotPlayerIds, [
    playerIds[1],
    playerIds[3],
    playerIds[4],
    playerIds[5],
  ]);
});

test("invalid ballot actors, targets, phases, and times are rejected", () => {
  const negotiation = negotiationState();
  const voting = votingState();
  const outsider = id("user", 99);
  const eliminated = Object.freeze({
    ...voting,
    roster: Object.freeze(
      voting.roster.map((entry) =>
        entry.playerId === playerIds[1]
          ? Object.freeze({ ...entry, status: "eliminated" as const })
          : entry,
      ),
    ),
  });

  const cases = [
    applyRoundCommand(negotiation, {
      type: "negotiation_timed_out",
      occurredAt: timestamp("2026-07-24T12:02:09.999Z"),
    }),
    ballotResult(negotiation, player(0), player(1)),
    ballotResult(voting, player(0), player(0)),
    ballotResult(voting, outsider, player(0)),
    ballotResult(voting, player(0), outsider),
    ballotResult(eliminated, player(1), player(0)),
    ballotResult(eliminated, player(0), player(1)),
    ballotResult(
      voting,
      player(0),
      player(1),
      voting.phaseDeadline as UtcTimestamp,
    ),
    applyRoundCommand(voting, {
      type: "voting_timed_out",
      occurredAt: timestamp("2026-07-24T12:02:29.999Z"),
    }),
  ];

  assert.deepEqual(
    cases.map((result) => (result.ok ? null : result.error.details.reason)),
    [
      "deadline_not_reached",
      "wrong_phase",
      "self_vote",
      "voter_not_eligible",
      "target_not_eligible",
      "voter_not_eligible",
      "target_not_eligible",
      "deadline_passed",
      "deadline_not_reached",
    ],
  );
});

function closedVotingState(
  ballots: readonly (readonly [voterIndex: number, targetIndex: number])[],
): MatchState {
  let state = votingState();
  for (const [voterIndex, targetIndex] of ballots) {
    state = submitBallot(state, player(voterIndex), player(targetIndex)).state;
  }
  if (state.phase === "voting") {
    state = success(
      applyRoundCommand(state, {
        type: "voting_timed_out",
        occurredAt: state.phaseDeadline as UtcTimestamp,
      }),
    ).state;
  }
  assert.equal(state.phase, "tally");
  return state;
}

function ballotTargets(...targetIndexes: readonly number[]) {
  return targetIndexes.map(
    (targetIndex, voterIndex) => [voterIndex, targetIndex] as const,
  );
}

function tally(
  state: MatchState,
  occurredAt = timestamp("2026-07-24T12:02:30.000Z"),
): TallyTransition {
  return success(
    applyTallyCommand(state, {
      type: "normal_ballots_tallied",
      occurredAt,
    }),
  );
}

test("normal tally eliminates a sole majority or plurality leader", () => {
  const cases = [
    [ballotTargets(1, 0, 0, 0, 0, 0), [5, 1, 0, 0, 0, 0]],
    [ballotTargets(1, 0, 0, 0, 1, 2), [3, 2, 1, 0, 0, 0]],
  ] as const;

  for (const [ballots, votes] of cases) {
    const transition = tally(closedVotingState(ballots));
    const projection = JSON.stringify(transition.events);

    assert.equal(transition.state.phase, "elimination");
    assert.equal(transition.state.phaseDeadline, "2026-07-24T12:02:40.000Z");
    assert.equal(transition.state.normalTally?.eliminatedPlayerId, player(0));
    assert.deepEqual(
      transition.state.normalTally?.voteTotals.map(({ votes }) => votes),
      votes,
    );
    assert.deepEqual(
      transition.state.roster.flatMap(({ playerId, status }) =>
        status === "eliminated" ? [playerId] : [],
      ),
      [player(0)],
    );
    assert.match(projection, /"voteTotals"/);
    assert.doesNotMatch(projection, /"voterId"|"targetId"|"ballotTargetId"/);
    assert.doesNotMatch(projection, /"automaticSelfVotes"/);
  }
});

test("missed ballots materialize as deterministic automatic self-votes", () => {
  const closed = closedVotingState(ballotTargets(4, 4, 4, 5));
  const transition = tally(closed);
  const result = transition.state.normalTally;
  assert.notEqual(result, null);
  assert.deepEqual(result?.automaticSelfVotes, [
    { playerId: player(4), reason: "missed_normal_ballot" },
    { playerId: player(5), reason: "missed_normal_ballot" },
  ]);
  assert.deepEqual(
    result?.voteTotals.map(({ votes }) => votes),
    [0, 0, 0, 0, 4, 2],
  );
  assert.equal(result?.eliminatedPlayerId, player(4));
  assert.equal(closed.normalBallots.length, 4);
  assert.equal(
    closed.normalBallots.every(({ voterId, targetId }) => voterId !== targetId),
    true,
  );
  assert.equal(
    result?.voteTotals.reduce((sum, { votes }) => sum + votes, 0),
    playerIds.length,
  );
});

test("tied leaders remain unresolved for deterministic runoff handling", () => {
  const state = closedVotingState(ballotTargets(1, 2, 3, 4, 5, 0));
  const first = tally(state);
  const second = tally(state);

  assert.deepEqual(first, second);
  assert.equal(first.state.phase, "tally");
  assert.equal(first.state.phaseDeadline, null);
  assert.deepEqual(first.state.normalTally?.leaderPlayerIds, playerIds);
  assert.equal(first.state.normalTally?.eliminatedPlayerId, null);
  assert.equal(
    first.state.roster.every(({ status }) => status === "active"),
    true,
  );
  assert.deepEqual(first.events, [
    {
      type: "normal_tally.completed",
      outcome: "tie",
      voteTotals: playerIds.map((playerId) => ({ playerId, votes: 1 })),
      tiedPlayerIds: playerIds,
    },
  ]);
  assert.equal(Object.isFrozen(first.state.normalTally), true);
  assert.equal(Object.isFrozen(first.state.normalTally?.voteTotals), true);
  assert.equal(
    first.state.normalTally?.voteTotals.every(Object.isFrozen),
    true,
  );
  const duplicate = tally(first.state, timestamp("2026-07-24T12:02:31.000Z"));
  assert.equal(duplicate.state, first.state);
  assert.deepEqual(duplicate.events, []);
});

test("tally rejects wrong phases and inconsistent ballot coverage", () => {
  const valid = closedVotingState([[0, 1]]);
  const inconsistent = Object.freeze({
    ...valid,
    missingNormalBallotPlayerIds: Object.freeze([
      player(0),
      ...valid.missingNormalBallotPlayerIds,
    ]),
  });
  const cases = [
    applyTallyCommand(votingState(), {
      type: "normal_ballots_tallied",
      occurredAt: timestamp("2026-07-24T12:02:30.000Z"),
    }),
    applyTallyCommand(inconsistent, {
      type: "normal_ballots_tallied",
      occurredAt: timestamp("2026-07-24T12:02:30.000Z"),
    }),
  ];

  assert.deepEqual(
    cases.map((result) => (result.ok ? null : result.error.details.reason)),
    ["wrong_phase", "invalid_tally_state"],
  );
});

function tiedTallyState(
  targets = ballotTargets(1, 0, 0, 0, 1, 1),
  priorVotes: readonly number[] = [0, 0, 0, 0, 0, 0],
): MatchState {
  const closed = closedVotingState(targets);
  const withHistory = Object.freeze({
    ...closed,
    cumulativeEliminationVoteTotals: Object.freeze(
      playerIds.map((playerId, index) =>
        Object.freeze({ playerId, votes: priorVotes[index] ?? 0 }),
      ),
    ),
  });
  return tally(withHistory).state;
}

function runoffVotingState(priorVotes?: readonly number[]): MatchState {
  const started = success(
    applyRunoffCommand(tiedTallyState(undefined, priorVotes), {
      type: "runoff_started",
      occurredAt: timestamp("2026-07-24T12:02:31.000Z"),
    }),
  );
  return success(
    applyRunoffCommand(started.state, {
      type: "runoff_negotiation_timed_out",
      occurredAt: started.state.phaseDeadline as UtcTimestamp,
    }),
  ).state;
}

function submitRunoff(
  state: MatchState,
  voterIndex: number,
  targetIndex: number,
): RunoffTransition {
  return success(
    applyRunoffCommand(state, {
      type: "runoff_ballot_submitted",
      voterId: player(voterIndex),
      targetId: player(targetIndex),
      occurredAt: timestamp("2026-07-24T12:03:05.000Z"),
    }),
  );
}

function runoffWithTargets(
  targets: readonly number[],
  priorVotes?: readonly number[],
): MatchState {
  let state = runoffVotingState(priorVotes);
  targets.forEach((target, index) => {
    state = submitRunoff(state, index + 2, target).state;
  });
  return state;
}

test("a partial tie enters runoff phases with restricted revisable ballots", () => {
  const tied = tiedTallyState();
  const started = success(
    applyRunoffCommand(tied, {
      type: "runoff_started",
      occurredAt: timestamp("2026-07-24T12:02:31.000Z"),
    }),
  );
  assert.equal(started.state.phase, "runoff_negotiation");
  assert.equal(started.state.phaseDeadline, "2026-07-24T12:03:01.000Z");
  assert.deepEqual(started.state.runoffPlayerIds, [player(0), player(1)]);

  const voting = runoffVotingState();
  assert.equal(voting.phase, "runoff_voting");
  assert.equal(voting.phaseDeadline, "2026-07-24T12:03:16.000Z");
  const first = submitRunoff(voting, 2, 0);
  const duplicate = submitRunoff(first.state, 2, 0);
  const revision = submitRunoff(duplicate.state, 2, 1);
  assert.equal(duplicate.state, first.state);
  assert.deepEqual(revision.events, [
    {
      type: "runoff_ballot.acknowledged",
      recipientUserId: player(2),
      ballotTargetId: player(1),
      revision: 2,
    },
  ]);

  const invalidCases = [
    applyRunoffCommand(started.state, {
      type: "runoff_negotiation_timed_out",
      occurredAt: timestamp("2026-07-24T12:03:00.999Z"),
    }),
    applyRunoffCommand(voting, {
      type: "runoff_ballot_submitted",
      voterId: player(0),
      targetId: player(1),
      occurredAt: timestamp("2026-07-24T12:03:05.000Z"),
    }),
    applyRunoffCommand(voting, {
      type: "runoff_ballot_submitted",
      voterId: player(2),
      targetId: player(3),
      occurredAt: timestamp("2026-07-24T12:03:05.000Z"),
    }),
    applyRunoffCommand(first.state, {
      type: "runoff_tallied",
      occurredAt: timestamp("2026-07-24T12:03:06.000Z"),
    }),
    applyRunoffCommand(voting, {
      type: "runoff_ballot_submitted",
      voterId: player(2),
      targetId: player(0),
      occurredAt: voting.phaseDeadline as UtcTimestamp,
    }),
  ];
  assert.deepEqual(
    invalidCases.map((result) =>
      result.ok ? null : result.error.details.reason,
    ),
    [
      "deadline_not_reached",
      "voter_not_eligible",
      "target_not_eligible",
      "voting_incomplete",
      "deadline_passed",
    ],
  );
});

test("a clear runoff result eliminates only its sole vote leader", () => {
  const state = runoffWithTargets([0, 0, 0, 1]);
  const first = success(
    applyRunoffCommand(state, {
      type: "runoff_tallied",
      occurredAt: timestamp("2026-07-24T12:03:06.000Z"),
    }),
  );
  const second = success(
    applyRunoffCommand(state, {
      type: "runoff_tallied",
      occurredAt: timestamp("2026-07-24T12:03:06.000Z"),
      randomSample: 0.99,
    }),
  );

  assert.deepEqual(first, second);
  assert.equal(first.state.phase, "elimination");
  assert.equal(first.state.tieResolution?.method, "runoff_vote");
  assert.deepEqual(
    first.state.tieResolution?.runoffVoteTotals.map(({ votes }) => votes),
    [3, 1],
  );
  assert.equal(first.state.tieResolution?.eliminatedPlayerId, player(0));
  assert.deepEqual(
    first.state.roster.flatMap(({ playerId, status }) =>
      status === "eliminated" ? [playerId] : [],
    ),
    [player(0)],
  );
  const aggregate = JSON.stringify(first.events[0]);
  assert.doesNotMatch(aggregate, /"voterId"|"targetId"|"ballotTargetId"/);
  assert.equal(Object.isFrozen(first.state.tieResolution), true);
});

test("a tied runoff falls back to cumulative votes before randomness", () => {
  const state = runoffWithTargets([0, 0, 1, 1], [2, 0, 0, 0, 0, 0]);
  const result = success(
    applyRunoffCommand(state, {
      type: "runoff_tallied",
      occurredAt: timestamp("2026-07-24T12:03:06.000Z"),
      randomSample: 0.99,
    }),
  );

  assert.equal(result.state.tieResolution?.method, "cumulative_votes");
  assert.equal(result.state.tieResolution?.randomSample, null);
  assert.deepEqual(
    result.state.cumulativeEliminationVoteTotals
      .slice(0, 2)
      .map(({ votes }) => votes),
    [7, 5],
  );
  assert.equal(result.state.tieResolution?.eliminatedPlayerId, player(0));
});

test("a cumulative tie requires and audits a deterministic random sample", () => {
  const state = runoffWithTargets([0, 0, 1, 1]);
  const missing = applyRunoffCommand(state, {
    type: "runoff_tallied",
    occurredAt: timestamp("2026-07-24T12:03:06.000Z"),
  });
  const invalid = applyRunoffCommand(state, {
    type: "runoff_tallied",
    occurredAt: timestamp("2026-07-24T12:03:06.000Z"),
    randomSample: 1,
  });
  const command = {
    type: "runoff_tallied",
    occurredAt: timestamp("2026-07-24T12:03:06.000Z"),
    randomSample: 0.75,
  } as const;
  const first = success(applyRunoffCommand(state, command));
  const second = success(applyRunoffCommand(state, command));

  assert.deepEqual(first, second);
  assert.equal(first.state.tieResolution?.method, "random_draw");
  assert.equal(first.state.tieResolution?.randomSample, 0.75);
  assert.deepEqual(first.state.tieResolution?.resolutionCandidatePlayerIds, [
    player(0),
    player(1),
  ]);
  assert.equal(first.state.tieResolution?.eliminatedPlayerId, player(1));
  assert.deepEqual(
    [missing, invalid].map((result) =>
      result.ok ? null : result.error.details.reason,
    ),
    ["random_sample_required", "invalid_random_sample"],
  );
});

test("an all-player tie skips runoff and uses the same fallback order", () => {
  const allTied = tiedTallyState(ballotTargets(1, 2, 3, 4, 5, 0));
  const random = success(
    applyRunoffCommand(allTied, {
      type: "runoff_started",
      occurredAt: timestamp("2026-07-24T12:02:31.000Z"),
      randomSample: 0.5,
    }),
  );
  const cumulative = success(
    applyRunoffCommand(
      tiedTallyState(ballotTargets(1, 2, 3, 4, 5, 0), [0, 0, 0, 0, 2, 0]),
      {
        type: "runoff_started",
        occurredAt: timestamp("2026-07-24T12:02:31.000Z"),
      },
    ),
  );

  assert.equal(random.state.phase, "elimination");
  assert.equal(random.state.tieResolution?.method, "random_draw");
  assert.equal(random.state.tieResolution?.eliminatedPlayerId, player(3));
  assert.deepEqual(random.state.tieResolution?.runoffVoteTotals, []);
  assert.equal(cumulative.state.tieResolution?.method, "cumulative_votes");
  assert.equal(cumulative.state.tieResolution?.eliminatedPlayerId, player(4));
});

function finalEliminationState(): MatchState {
  const negotiation = negotiationState();
  const reduced = Object.freeze({
    ...negotiation,
    roster: Object.freeze(
      negotiation.roster.map((entry, index) =>
        index < 3
          ? Object.freeze({ ...entry, status: "eliminated" as const })
          : entry,
      ),
    ),
  });
  let state = success(
    applyRoundCommand(reduced, {
      type: "negotiation_timed_out",
      occurredAt: reduced.phaseDeadline as UtcTimestamp,
    }),
  ).state;
  state = submitBallot(state, player(3), player(4)).state;
  state = submitBallot(state, player(4), player(3)).state;
  state = submitBallot(state, player(5), player(3)).state;
  return tally(state).state;
}

function finalPleaState(): MatchState {
  const elimination = finalEliminationState();
  return success(
    applyFinaleCommand(elimination, {
      type: "elimination_reveal_timed_out",
      occurredAt: elimination.phaseDeadline as UtcTimestamp,
    }),
  ).state;
}

function juryVotingState(): MatchState {
  let state = finalPleaState();
  for (const [playerIndex, text] of [
    [4, "Keep me in the booth."],
    [5, "My game deserves the win."],
  ] as const) {
    state = success(
      applyFinaleCommand(state, {
        type: "final_plea_submitted",
        playerId: player(playerIndex),
        text,
        occurredAt: timestamp(`2026-07-24T12:02:${playerIndex + 46}.000Z`),
      }),
    ).state;
  }
  return state;
}

function submitJuryBallot(
  state: MatchState,
  jurorIndex: number,
  finalistIndex: number,
): FinaleTransition {
  return success(
    applyFinaleCommand(state, {
      type: "jury_ballot_submitted",
      jurorId: player(jurorIndex),
      finalistId: player(finalistIndex),
      occurredAt: timestamp("2026-07-24T12:03:00.000Z"),
    }),
  );
}

function withFinalistCumulative(
  state: MatchState,
  first: number,
  second: number,
): MatchState {
  return Object.freeze({
    ...state,
    cumulativeEliminationVoteTotals: Object.freeze(
      state.cumulativeEliminationVoteTotals.map((entry) =>
        entry.playerId === player(4)
          ? Object.freeze({ ...entry, votes: first })
          : entry.playerId === player(5)
            ? Object.freeze({ ...entry, votes: second })
            : entry,
      ),
    ),
  });
}

function tiedJuryState(): MatchState {
  let state = juryVotingState();
  for (const [juror, finalist] of [
    [0, 4],
    [1, 4],
    [2, 5],
    [3, 5],
  ] as const) {
    state = submitJuryBallot(state, juror, finalist).state;
  }
  return withFinalistCumulative(state, 0, 0);
}

test("elimination reveal archives the round and advances by active count", () => {
  const firstElimination = tally(
    closedVotingState(ballotTargets(1, 0, 0, 0, 1, 2)),
  ).state;
  const laterRound = success(
    applyFinaleCommand(firstElimination, {
      type: "elimination_reveal_timed_out",
      occurredAt: firstElimination.phaseDeadline as UtcTimestamp,
    }),
  );
  const finalists = finalPleaState();

  assert.equal(laterRound.state.phase, "negotiation");
  assert.equal(laterRound.state.phaseDeadline, "2026-07-24T12:04:10.000Z");
  assert.equal(laterRound.state.completedRounds.length, 1);
  assert.equal(
    laterRound.state.completedRounds[0]?.eliminatedPlayerId,
    player(0),
  );
  assert.equal(Object.isFrozen(laterRound.state.completedRounds), true);
  assert.equal(Object.isFrozen(laterRound.state.completedRounds[0]), true);
  assert.equal(finalists.phase, "final_plea");
  assert.equal(finalists.phaseDeadline, "2026-07-24T12:03:40.000Z");
  assert.deepEqual(
    finalists.roster.flatMap(({ playerId, status }) =>
      status === "active" ? [playerId] : [],
    ),
    [player(4), player(5)],
  );
});

test("final pleas are private, revisable, bounded, and close into jury voting", () => {
  const state = finalPleaState();
  const first = success(
    applyFinaleCommand(state, {
      type: "final_plea_submitted",
      playerId: player(4),
      text: "First plea",
      occurredAt: timestamp("2026-07-24T12:02:50.000Z"),
    }),
  );
  const duplicate = success(
    applyFinaleCommand(first.state, {
      type: "final_plea_submitted",
      playerId: player(4),
      text: "First plea",
      occurredAt: timestamp("2026-07-24T12:02:51.000Z"),
    }),
  );
  const revised = success(
    applyFinaleCommand(duplicate.state, {
      type: "final_plea_submitted",
      playerId: player(4),
      text: "Final plea",
      occurredAt: timestamp("2026-07-24T12:02:52.000Z"),
    }),
  );
  const jury = success(
    applyFinaleCommand(revised.state, {
      type: "final_plea_submitted",
      playerId: player(5),
      text: "Other plea",
      occurredAt: timestamp("2026-07-24T12:02:53.000Z"),
    }),
  );

  assert.equal(duplicate.state, first.state);
  assert.equal(revised.state.finalPleas[0]?.text, "Final plea");
  assert.doesNotMatch(JSON.stringify(revised.events), /First plea|Final plea/);
  assert.equal(jury.state.phase, "jury_voting");
  assert.equal(jury.state.phaseDeadline, "2026-07-24T12:03:13.000Z");

  const invalidCases = [
    applyFinaleCommand(state, {
      type: "final_plea_submitted",
      playerId: player(0),
      text: "Not a finalist",
      occurredAt: timestamp("2026-07-24T12:02:50.000Z"),
    }),
    applyFinaleCommand(state, {
      type: "final_plea_submitted",
      playerId: player(4),
      text: " ",
      occurredAt: timestamp("2026-07-24T12:02:50.000Z"),
    }),
    applyFinaleCommand(state, {
      type: "final_plea_submitted",
      playerId: player(4),
      text: "x".repeat(241),
      occurredAt: timestamp("2026-07-24T12:02:50.000Z"),
    }),
  ];
  assert.deepEqual(
    invalidCases.map((result) =>
      result.ok ? null : result.error.details.reason,
    ),
    ["finalist_not_eligible", "plea_empty", "plea_too_long"],
  );
});

test("jury majority completes with one winner and hidden individual ballots", () => {
  let state = juryVotingState();
  for (const [juror, finalist] of [
    [0, 4],
    [1, 4],
    [2, 4],
    [3, 5],
  ] as const) {
    state = submitJuryBallot(state, juror, finalist).state;
  }
  const result = success(
    applyFinaleCommand(state, {
      type: "jury_tallied",
      occurredAt: timestamp("2026-07-24T12:03:01.000Z"),
    }),
  );

  assert.equal(result.state.phase, "complete");
  assert.equal(result.state.phaseDeadline, null);
  assert.equal(result.state.winnerPlayerId, player(4));
  assert.equal(result.state.juryResult?.method, "jury_vote");
  assert.deepEqual(
    result.state.juryResult?.voteTotals.map(({ votes }) => votes),
    [3, 1],
  );
  assert.doesNotMatch(
    JSON.stringify(result.events[0]),
    /"jurorId"|"finalistId"|"ballotTargetId"/,
  );
  assert.equal(Object.isFrozen(result.state.juryResult), true);
});

test("missing jurors are excluded when the jury deadline closes", () => {
  let state = juryVotingState();
  state = submitJuryBallot(state, 0, 4).state;
  state = submitJuryBallot(state, 1, 4).state;
  const result = success(
    applyFinaleCommand(state, {
      type: "jury_tallied",
      occurredAt: state.phaseDeadline as UtcTimestamp,
    }),
  );

  assert.equal(result.state.winnerPlayerId, player(4));
  assert.deepEqual(
    result.state.juryResult?.voteTotals.map(({ votes }) => votes),
    [2, 0],
  );
});

test("jury ties follow cumulative, missed-ballot, then random fallback", () => {
  const tied = tiedJuryState();
  const cumulativeState = withFinalistCumulative(tied, 1, 3);
  const cumulative = success(
    applyFinaleCommand(cumulativeState, {
      type: "jury_tallied",
      occurredAt: timestamp("2026-07-24T12:03:01.000Z"),
    }),
  );
  const missedState = Object.freeze({
    ...tied,
    completedRounds: Object.freeze(
      tied.completedRounds.map((round, index) =>
        index === 0
          ? Object.freeze({
              ...round,
              automaticSelfVotes: Object.freeze([
                Object.freeze({
                  playerId: player(5),
                  reason: "missed_normal_ballot" as const,
                }),
              ]),
            })
          : round,
      ),
    ),
  });
  const missed = success(
    applyFinaleCommand(missedState, {
      type: "jury_tallied",
      occurredAt: timestamp("2026-07-24T12:03:01.000Z"),
    }),
  );
  const noVotes = withFinalistCumulative(juryVotingState(), 0, 0);
  const random = success(
    applyFinaleCommand(noVotes, {
      type: "jury_tallied",
      occurredAt: noVotes.phaseDeadline as UtcTimestamp,
      randomSample: 0.75,
    }),
  );

  assert.equal(cumulative.state.juryResult?.method, "cumulative_votes");
  assert.equal(cumulative.state.winnerPlayerId, player(4));
  assert.equal(missed.state.juryResult?.method, "missed_ballots");
  assert.equal(missed.state.winnerPlayerId, player(4));
  assert.equal(random.state.juryResult?.method, "random_draw");
  assert.equal(random.state.winnerPlayerId, player(5));
  assert.equal(random.state.juryResult?.randomSample, 0.75);
});

test("jury rejects ineligible actors, incomplete tallies, and unsafe samples", () => {
  const state = juryVotingState();
  const tied = tiedJuryState();
  const cases = [
    applyFinaleCommand(state, {
      type: "jury_ballot_submitted",
      jurorId: player(4),
      finalistId: player(5),
      occurredAt: timestamp("2026-07-24T12:03:00.000Z"),
    }),
    applyFinaleCommand(state, {
      type: "jury_ballot_submitted",
      jurorId: player(0),
      finalistId: player(0),
      occurredAt: timestamp("2026-07-24T12:03:00.000Z"),
    }),
    applyFinaleCommand(state, {
      type: "jury_tallied",
      occurredAt: timestamp("2026-07-24T12:03:00.000Z"),
    }),
    applyFinaleCommand(tied, {
      type: "jury_tallied",
      occurredAt: timestamp("2026-07-24T12:03:01.000Z"),
    }),
    applyFinaleCommand(tied, {
      type: "jury_tallied",
      occurredAt: timestamp("2026-07-24T12:03:01.000Z"),
      randomSample: 1,
    }),
  ];
  assert.deepEqual(
    cases.map((result) => (result.ok ? null : result.error.details.reason)),
    [
      "juror_not_eligible",
      "finalist_not_eligible",
      "voting_incomplete",
      "random_sample_required",
      "invalid_random_sample",
    ],
  );
});

function completedMatchState(): MatchState {
  let state = juryVotingState();
  for (const [juror, finalist] of [
    [0, 4],
    [1, 4],
    [2, 4],
    [3, 5],
  ] as const) {
    state = submitJuryBallot(state, juror, finalist).state;
  }
  return success(
    applyFinaleCommand(state, {
      type: "jury_tallied",
      occurredAt: timestamp("2026-07-24T12:03:01.000Z"),
    }),
  ).state;
}

test("completed participants receive an immutable dossier with hidden facts", () => {
  const state = completedMatchState();
  const deals: DossierDealRecord[] = [
    {
      senderPlayerId: player(0),
      recipientPlayerId: player(4),
      promisedTargetPlayerId: player(5),
      outcome: "honored",
    },
    {
      senderPlayerId: player(1),
      recipientPlayerId: player(5),
      promisedTargetPlayerId: player(4),
      outcome: "betrayed",
    },
  ];
  const first = success(
    createDossierProjection(state, {
      viewerPlayerId: player(0),
      deals,
    }),
  );
  const second = success(
    createDossierProjection(state, {
      viewerPlayerId: player(0),
      deals,
    }),
  );

  assert.deepEqual(first, second);
  assert.equal(first.winnerPlayerId, player(4));
  assert.deepEqual(first.eliminationOrder, [player(3)]);
  assert.equal(first.rounds[0]?.normalBallots.length, 3);
  assert.equal(first.juryBallots.length, 4);
  assert.deepEqual(
    first.finalPleas.map(({ playerId }) => playerId),
    [player(4), player(5)],
  );
  assert.deepEqual(
    first.deals.map(({ outcome }) => outcome),
    ["honored", "betrayed"],
  );
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.eliminationOrder), true);
  assert.equal(Object.isFrozen(first.deals), true);
  assert.equal(first.deals.every(Object.isFrozen), true);

  (deals[0] as { outcome: string }).outcome = "expired";
  assert.equal(first.deals[0]?.outcome, "honored");
  assert.equal(
    createDossierProjection(state, {
      viewerPlayerId: player(4),
      deals: [],
    }).ok,
    true,
  );
});

test("dossier access is completion-, membership-, and participant-gated", () => {
  const complete = completedMatchState();
  const outsider = id("user", 99);
  const cases = [
    createDossierProjection(juryVotingState(), {
      viewerPlayerId: player(0),
      deals: [],
    }),
    createDossierProjection(complete, {
      viewerPlayerId: outsider,
      deals: [],
    }),
    createDossierProjection(complete, {
      viewerPlayerId: player(0),
      deals: [
        {
          senderPlayerId: outsider,
          recipientPlayerId: player(4),
          promisedTargetPlayerId: player(5),
          outcome: "reversed",
        },
      ],
    }),
  ];

  assert.deepEqual(
    cases.map((result) => (result.ok ? null : result.error.details.reason)),
    ["match_not_complete", "viewer_not_in_roster", "invalid_deal_participant"],
  );
});

function simulate(seed: number, players: readonly UserId[] = playerIds) {
  return simulateHeadlessMatch({
    matchId,
    ruleset: ruleset(),
    playerIds: players,
    lobbyDeadline,
    seed,
  });
}

test("a seed reproduces an identical complete six-player match and dossier", () => {
  const first = simulate(42);
  const second = simulate(42);

  assert.deepEqual(first, second);
  assert.equal(first.ok, true);
  if (!first.ok) {
    return;
  }
  assert.equal(first.value.state.phase, "complete");
  assert.notEqual(first.value.state.winnerPlayerId, null);
  assert.equal(first.value.state.completedRounds.length, 4);
  assert.equal(first.value.dossier.rounds.length, 4);
  assert.equal(first.value.dossier.juryBallots.length, 4);
  assert.equal(first.value.commandCount < 500, true);
  assert.equal(Object.isFrozen(first.value), true);
});

test("two thousand seeded matches finish with one winner and no illegal command", () => {
  const winners = new Set<UserId>();
  for (let seed = 0; seed < 2_000; seed += 1) {
    const result = simulate(seed);
    assert.equal(result.ok, true, `seed ${seed} must complete`);
    if (!result.ok) {
      continue;
    }
    const winnerPlayerId = result.value.state.winnerPlayerId;
    assert.notEqual(winnerPlayerId, null);
    assert.equal(result.value.state.juryResult?.winnerPlayerId, winnerPlayerId);
    assert.equal(result.value.state.completedRounds.length, 4);
    assert.deepEqual(result.value.dossier.eliminationOrder.length, 4);
    winners.add(winnerPlayerId as UserId);
  }
  assert.equal(winners.size > 1, true);
});

test("headless simulation rejects invalid seeds and non-six-player inputs", () => {
  const cases = [simulate(-1), simulate(1, playerIds.slice(0, 5))];

  assert.deepEqual(
    cases.map((result) => (result.ok ? null : result.error.details.reason)),
    ["invalid_seed", "invalid_input"],
  );
});
