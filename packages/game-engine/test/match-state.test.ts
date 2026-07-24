import assert from "node:assert/strict";
import test from "node:test";

import { parseRulesetV1, type RulesetV1 } from "@project-booth/config";
import {
  parseEntityId,
  type EntityId,
  type MatchId,
  type UserId,
} from "@project-booth/domain";

import { createMatchState, INITIAL_MATCH_VERSION } from "../src/index.js";

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

test("constructs the documented immutable initial match state", () => {
  const result = createMatchState({ matchId, ruleset: ruleset(), playerIds });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.equal(result.value.version, INITIAL_MATCH_VERSION);
  assert.equal(result.value.phase, "lobby");
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
  const result = createMatchState({ matchId, ruleset: source, playerIds });
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
  const first = createMatchState({ matchId, ruleset: ruleset(), playerIds });
  const second = createMatchState({ matchId, ruleset: ruleset(), playerIds });

  assert.deepEqual(first, second);
});
