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
  applyLobbyCommand,
  applyRoundCommand,
  createMatchState,
  INITIAL_MATCH_VERSION,
  type LobbyTransition,
  type MatchState,
  type RoundTransition,
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
