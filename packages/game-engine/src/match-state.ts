import type { RulesetV1 } from "@project-booth/config";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type MatchId,
  type Result,
  type UserId,
  type UtcTimestamp,
} from "@project-booth/domain";

declare const matchVersionBrand: unique symbol;

export type MatchVersion = number & {
  readonly [matchVersionBrand]: "matchVersion";
};

export const INITIAL_MATCH_VERSION = 1 as MatchVersion;

export type MatchPhase =
  | "lobby"
  | "negotiation"
  | "voting"
  | "tally"
  | "runoff_negotiation"
  | "runoff_voting"
  | "elimination"
  | "final_plea"
  | "jury_voting"
  | "complete"
  | "cancelled";

export type ContestantStatus = "active" | "eliminated";

export interface MatchRosterEntry {
  readonly playerId: UserId;
  readonly status: ContestantStatus;
}

export interface NormalBallot {
  readonly voterId: UserId;
  readonly targetId: UserId;
  readonly revision: number;
  readonly submittedAt: UtcTimestamp;
}

export interface MatchState {
  readonly matchId: MatchId;
  readonly version: MatchVersion;
  readonly phase: MatchPhase;
  readonly phaseDeadline: UtcTimestamp | null;
  readonly rulesetSnapshot: RulesetV1;
  readonly roster: readonly MatchRosterEntry[];
  readonly readyPlayerIds: readonly UserId[];
  readonly normalBallots: readonly NormalBallot[];
  readonly missingNormalBallotPlayerIds: readonly UserId[];
}

export interface CreateMatchStateInput {
  readonly matchId: MatchId;
  readonly ruleset: RulesetV1;
  readonly playerIds: readonly UserId[];
  readonly lobbyDeadline: UtcTimestamp;
}

export type InvalidRosterSizeError = DomainError<
  "invalid_roster_size",
  {
    readonly expected: number;
    readonly actual: number;
  }
>;

export type DuplicateRosterPlayerError = DomainError<
  "duplicate_roster_player",
  {
    readonly playerId: UserId;
  }
>;

export type MatchConstructionError =
  InvalidRosterSizeError | DuplicateRosterPlayerError;

function snapshotRuleset(ruleset: RulesetV1): RulesetV1 {
  const economy = Object.freeze({
    references: Object.freeze({ ...ruleset.economy.references }),
    rules: Object.freeze({ ...ruleset.economy.rules }),
  });

  return Object.freeze({
    ...ruleset,
    roster: Object.freeze({ ...ruleset.roster }),
    phaseDurationsSeconds: Object.freeze({
      ...ruleset.phaseDurationsSeconds,
    }),
    communication: Object.freeze({ ...ruleset.communication }),
    economy,
  });
}

export function createMatchState(
  input: CreateMatchStateInput,
): Result<MatchState, MatchConstructionError> {
  const expected = input.ruleset.roster.contestantCount;
  if (input.playerIds.length !== expected) {
    return err(
      domainError(
        "invalid_roster_size",
        "Roster size must match the ruleset contestant count",
        { expected, actual: input.playerIds.length },
      ),
    );
  }

  const seen = new Set<UserId>();
  for (const playerId of input.playerIds) {
    if (seen.has(playerId)) {
      return err(
        domainError(
          "duplicate_roster_player",
          "Roster players must be unique",
          { playerId },
        ),
      );
    }
    seen.add(playerId);
  }

  const roster = Object.freeze(
    input.playerIds.map((playerId) =>
      Object.freeze({ playerId, status: "active" as const }),
    ),
  );

  return ok(
    Object.freeze({
      matchId: input.matchId,
      version: INITIAL_MATCH_VERSION,
      phase: "lobby",
      phaseDeadline: input.lobbyDeadline,
      rulesetSnapshot: snapshotRuleset(input.ruleset),
      roster,
      readyPlayerIds: Object.freeze([]),
      normalBallots: Object.freeze([]),
      missingNormalBallotPlayerIds: Object.freeze([]),
    }),
  );
}
