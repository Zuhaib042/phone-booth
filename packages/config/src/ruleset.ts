import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";

import {
  domainError,
  err,
  ok,
  parseEntityId,
  RFC_9562_UUID_PATTERN,
  type DomainError,
  type Result,
  type RulesetId,
} from "@project-booth/domain";

export interface PhaseDurationsSecondsV1 {
  readonly firstNegotiation: number;
  readonly laterNegotiation: number;
  readonly voting: number;
  readonly eliminationReveal: number;
  readonly runoffNegotiation: number;
  readonly runoffVoting: number;
  readonly finalPlea: number;
  readonly juryVoting: number;
  readonly reconnectGrace: number;
}

export interface EconomyReferencesV1 {
  readonly matchOutflowCap: string;
  readonly minimumOfferIncrement: string;
  readonly matchCompletionReward: string;
  readonly placementReward: string;
  readonly winnerReward: string;
}

export interface EconomyRulesV1 {
  readonly outgoingLimitBasis: "cumulative_outgoing";
  readonly incomingTransfersRestoreAllowance: false;
  readonly inMatchPurchasesAvailability: "next_match";
  readonly reversalRestoresAllowance: true;
  readonly acceptedOfferSettlement: "any_valid_ballot";
  readonly promisedTargetEnforced: false;
  readonly missedBallotSettlement: "reverse";
}

export interface RulesetV1Input {
  readonly schemaVersion: 1;
  readonly rulesetId: string;
  readonly rulesetVersion: number;
  readonly roster: {
    readonly contestantCount: number;
    readonly minimumReadyCount: number;
  };
  readonly phaseDurationsSeconds: PhaseDurationsSecondsV1;
  readonly communication: {
    readonly maximumTypedMessageCharacters: number;
  };
  readonly economy: {
    readonly references: EconomyReferencesV1;
    readonly rules: EconomyRulesV1;
  };
}

export interface RulesetV1 extends Omit<RulesetV1Input, "rulesetId"> {
  readonly rulesetId: RulesetId;
}

export interface RulesetValidationIssue {
  readonly path: string;
  readonly rule: string;
  readonly message: string;
}

export type InvalidRulesetError = DomainError<
  "invalid_ruleset",
  {
    readonly issues: readonly RulesetValidationIssue[];
  }
>;

const DURATION_SCHEMA = {
  type: "integer",
  minimum: 1,
  maximum: 3_600,
} as const;

const ECONOMY_REFERENCE_SCHEMA = {
  type: "string",
  pattern: "^economy\\.[a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*)*$",
} as const;

export const RULESET_V1_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:project-booth:schema:ruleset:v1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "rulesetId",
    "rulesetVersion",
    "roster",
    "phaseDurationsSeconds",
    "communication",
    "economy",
  ],
  properties: {
    schemaVersion: { const: 1 },
    rulesetId: {
      type: "string",
      pattern: RFC_9562_UUID_PATTERN,
    },
    rulesetVersion: {
      type: "integer",
      minimum: 1,
    },
    roster: {
      type: "object",
      additionalProperties: false,
      required: ["contestantCount", "minimumReadyCount"],
      properties: {
        contestantCount: { type: "integer", minimum: 4, maximum: 32 },
        minimumReadyCount: { type: "integer", minimum: 4, maximum: 32 },
      },
    },
    phaseDurationsSeconds: {
      type: "object",
      additionalProperties: false,
      required: [
        "firstNegotiation",
        "laterNegotiation",
        "voting",
        "eliminationReveal",
        "runoffNegotiation",
        "runoffVoting",
        "finalPlea",
        "juryVoting",
        "reconnectGrace",
      ],
      properties: {
        firstNegotiation: DURATION_SCHEMA,
        laterNegotiation: DURATION_SCHEMA,
        voting: DURATION_SCHEMA,
        eliminationReveal: DURATION_SCHEMA,
        runoffNegotiation: DURATION_SCHEMA,
        runoffVoting: DURATION_SCHEMA,
        finalPlea: DURATION_SCHEMA,
        juryVoting: DURATION_SCHEMA,
        reconnectGrace: DURATION_SCHEMA,
      },
    },
    communication: {
      type: "object",
      additionalProperties: false,
      required: ["maximumTypedMessageCharacters"],
      properties: {
        maximumTypedMessageCharacters: {
          type: "integer",
          minimum: 1,
          maximum: 2_000,
        },
      },
    },
    economy: {
      type: "object",
      additionalProperties: false,
      required: ["references", "rules"],
      properties: {
        references: {
          type: "object",
          additionalProperties: false,
          required: [
            "matchOutflowCap",
            "minimumOfferIncrement",
            "matchCompletionReward",
            "placementReward",
            "winnerReward",
          ],
          properties: {
            matchOutflowCap: ECONOMY_REFERENCE_SCHEMA,
            minimumOfferIncrement: ECONOMY_REFERENCE_SCHEMA,
            matchCompletionReward: ECONOMY_REFERENCE_SCHEMA,
            placementReward: ECONOMY_REFERENCE_SCHEMA,
            winnerReward: ECONOMY_REFERENCE_SCHEMA,
          },
        },
        rules: {
          type: "object",
          additionalProperties: false,
          required: [
            "outgoingLimitBasis",
            "incomingTransfersRestoreAllowance",
            "inMatchPurchasesAvailability",
            "reversalRestoresAllowance",
            "acceptedOfferSettlement",
            "promisedTargetEnforced",
            "missedBallotSettlement",
          ],
          properties: {
            outgoingLimitBasis: { const: "cumulative_outgoing" },
            incomingTransfersRestoreAllowance: { const: false },
            inMatchPurchasesAvailability: { const: "next_match" },
            reversalRestoresAllowance: { const: true },
            acceptedOfferSettlement: { const: "any_valid_ballot" },
            promisedTargetEnforced: { const: false },
            missedBallotSettlement: { const: "reverse" },
          },
        },
      },
    },
  },
} as const;

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile<RulesetV1Input>(RULESET_V1_SCHEMA);

function schemaIssues(
  errors: readonly ErrorObject[] | null | undefined,
): RulesetValidationIssue[] {
  return (errors ?? []).map((error) => ({
    path: error.instancePath || "/",
    rule: `schema.${error.keyword}`,
    message: error.message ?? "Schema validation failed",
  }));
}

function relationshipIssues(ruleset: RulesetV1Input): RulesetValidationIssue[] {
  const issues: RulesetValidationIssue[] = [];
  const { phaseDurationsSeconds: phases, roster } = ruleset;

  if (roster.minimumReadyCount > roster.contestantCount) {
    issues.push({
      path: "/roster/minimumReadyCount",
      rule: "roster.minimum_ready_not_above_contestants",
      message: "Minimum ready count cannot exceed contestant count",
    });
  }
  if (phases.firstNegotiation < phases.laterNegotiation) {
    issues.push({
      path: "/phaseDurationsSeconds/firstNegotiation",
      rule: "phases.first_negotiation_not_shorter",
      message: "First negotiation cannot be shorter than later negotiation",
    });
  }
  if (phases.runoffNegotiation > phases.laterNegotiation) {
    issues.push({
      path: "/phaseDurationsSeconds/runoffNegotiation",
      rule: "phases.runoff_negotiation_not_longer",
      message: "Runoff negotiation cannot exceed later negotiation",
    });
  }
  if (phases.runoffVoting > phases.voting) {
    issues.push({
      path: "/phaseDurationsSeconds/runoffVoting",
      rule: "phases.runoff_voting_not_longer",
      message: "Runoff voting cannot exceed normal voting",
    });
  }

  const references = Object.values(ruleset.economy.references);
  if (new Set(references).size !== references.length) {
    issues.push({
      path: "/economy/references",
      rule: "economy.references_unique",
      message: "Each economy role must use a distinct symbolic reference",
    });
  }

  return issues;
}

function invalidRuleset(
  issues: readonly RulesetValidationIssue[],
): InvalidRulesetError {
  return domainError("invalid_ruleset", "Ruleset validation failed", {
    issues,
  });
}

export function parseRulesetV1(
  value: unknown,
): Result<RulesetV1, InvalidRulesetError> {
  if (!validateSchema(value)) {
    return err(invalidRuleset(schemaIssues(validateSchema.errors)));
  }

  const rulesetId = parseEntityId("ruleset", value.rulesetId);
  const issues = relationshipIssues(value);
  if (!rulesetId.ok) {
    issues.push({
      path: "/rulesetId",
      rule: "ruleset_id.uuid",
      message: rulesetId.error.message,
    });
  }
  if (issues.length > 0 || !rulesetId.ok) {
    return err(invalidRuleset(issues));
  }

  return ok({ ...value, rulesetId: rulesetId.value });
}
