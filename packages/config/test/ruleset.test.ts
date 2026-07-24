import assert from "node:assert/strict";
import test from "node:test";

import { parseRulesetV1 } from "../src/index.js";
import { VALID_RULESET_V1 } from "./fixtures/ruleset-v1.js";

function assertInvalid(value: unknown, expectedRule: string): void {
  const result = parseRulesetV1(value);
  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }

  assert.equal(result.error.code, "invalid_ruleset");
  assert.equal(
    result.error.details.issues.some((issue) => issue.rule === expectedRule),
    true,
  );
}

test("a valid versioned ruleset parses with a typed ruleset identifier", () => {
  const result = parseRulesetV1({
    ...VALID_RULESET_V1,
    rulesetId: VALID_RULESET_V1.rulesetId.toUpperCase(),
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.equal(result.value.schemaVersion, 1);
  assert.equal(result.value.rulesetVersion, 1);
  assert.equal(result.value.rulesetId, "019824d0-7c1a-7a91-8c4a-3fe0f1b51e22");
});

test("unknown phases and invalid durations are rejected", () => {
  assertInvalid(
    {
      ...VALID_RULESET_V1,
      phaseDurationsSeconds: {
        ...VALID_RULESET_V1.phaseDurationsSeconds,
        auction: 10,
      },
    },
    "schema.additionalProperties",
  );
  assertInvalid(
    {
      ...VALID_RULESET_V1,
      phaseDurationsSeconds: {
        ...VALID_RULESET_V1.phaseDurationsSeconds,
        voting: 0,
      },
    },
    "schema.minimum",
  );
  assertInvalid(
    {
      ...VALID_RULESET_V1,
      phaseDurationsSeconds: {
        ...VALID_RULESET_V1.phaseDurationsSeconds,
        firstNegotiation: 60,
      },
    },
    "phases.first_negotiation_not_shorter",
  );
  assertInvalid(
    {
      ...VALID_RULESET_V1,
      phaseDurationsSeconds: {
        ...VALID_RULESET_V1.phaseDurationsSeconds,
        runoffNegotiation: 100,
      },
    },
    "phases.runoff_negotiation_not_longer",
  );
  assertInvalid(
    {
      ...VALID_RULESET_V1,
      phaseDurationsSeconds: {
        ...VALID_RULESET_V1.phaseDurationsSeconds,
        runoffVoting: 25,
      },
    },
    "phases.runoff_voting_not_longer",
  );
});

test("invalid roster sizes and readiness relationships are rejected", () => {
  assertInvalid(
    {
      ...VALID_RULESET_V1,
      roster: { contestantCount: 3, minimumReadyCount: 3 },
    },
    "schema.minimum",
  );
  assertInvalid(
    {
      ...VALID_RULESET_V1,
      roster: { contestantCount: 6, minimumReadyCount: 7 },
    },
    "roster.minimum_ready_not_above_contestants",
  );
});

test("economy configuration remains symbolic", () => {
  assert.equal(
    Object.values(VALID_RULESET_V1.economy.references).every(
      (reference) => typeof reference === "string",
    ),
    true,
  );
  assertInvalid(
    {
      ...VALID_RULESET_V1,
      economy: {
        ...VALID_RULESET_V1.economy,
        references: {
          ...VALID_RULESET_V1.economy.references,
          matchOutflowCap: 100_000,
        },
      },
    },
    "schema.type",
  );
});

test("unsafe economy relationships are rejected", () => {
  assertInvalid(
    {
      ...VALID_RULESET_V1,
      economy: {
        ...VALID_RULESET_V1.economy,
        references: {
          ...VALID_RULESET_V1.economy.references,
          winnerReward:
            VALID_RULESET_V1.economy.references.matchCompletionReward,
        },
      },
    },
    "economy.references_unique",
  );
  assertInvalid(
    {
      ...VALID_RULESET_V1,
      economy: {
        ...VALID_RULESET_V1.economy,
        rules: {
          ...VALID_RULESET_V1.economy.rules,
          incomingTransfersRestoreAllowance: true,
        },
      },
    },
    "schema.const",
  );
  assertInvalid(
    {
      ...VALID_RULESET_V1,
      economy: {
        ...VALID_RULESET_V1.economy,
        rules: {
          ...VALID_RULESET_V1.economy.rules,
          promisedTargetEnforced: true,
        },
      },
    },
    "schema.const",
  );
});
