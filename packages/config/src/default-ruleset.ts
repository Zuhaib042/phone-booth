import type { RulesetV1Input } from "./ruleset.js";

export const DEFAULT_RULESET_V1: RulesetV1Input = {
  schemaVersion: 1,
  rulesetId: "019824d0-7c1a-7a91-8c4a-3fe0f1b51e22",
  rulesetVersion: 1,
  roster: {
    contestantCount: 6,
    minimumReadyCount: 4,
  },
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
  communication: {
    maximumTypedMessageCharacters: 240,
  },
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
};
