import { parseRulesetV1 } from "@project-booth/config";
import {
  parseEntityId,
  parseUtcTimestamp,
  type MatchId,
  type UtcTimestamp,
  type UserId,
} from "@project-booth/domain";
import type {
  ContestantStatus,
  MatchPhase,
  MatchState,
  MatchVersion,
} from "@project-booth/game-engine";

const MATCH_PHASES = new Set<MatchPhase>([
  "lobby",
  "negotiation",
  "voting",
  "tally",
  "runoff_negotiation",
  "runoff_voting",
  "elimination",
  "final_plea",
  "jury_voting",
  "complete",
  "cancelled",
]);

const ARRAY_FIELDS = [
  "roster",
  "readyPlayerIds",
  "normalBallots",
  "missingNormalBallotPlayerIds",
  "cumulativeEliminationVoteTotals",
  "runoffPlayerIds",
  "runoffBallots",
  "completedRounds",
  "finalPleas",
  "juryBallots",
] as const;

const NULLABLE_OBJECT_FIELDS = [
  "normalTally",
  "tieResolution",
  "juryResult",
] as const;

type MutableRecord = Record<string, unknown>;

export class MatchStateDecodeError extends Error {
  public constructor(message: string) {
    super(`Invalid persisted match state: ${message}`);
    this.name = "MatchStateDecodeError";
  }
}

function isRecord(value: unknown): value is MutableRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeId<Entity extends string>(
  entity: Entity,
  value: unknown,
): string {
  if (typeof value !== "string") {
    throw new MatchStateDecodeError(`${entity} identifier must be a string`);
  }
  const parsed = parseEntityId(entity, value);
  if (!parsed.ok) {
    throw new MatchStateDecodeError(parsed.error.message);
  }
  return parsed.value;
}

function decodeOptionalTimestamp(value: unknown): UtcTimestamp | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new MatchStateDecodeError("phaseDeadline must be a string or null");
  }
  const parsed = parseUtcTimestamp(value);
  if (!parsed.ok) {
    throw new MatchStateDecodeError(parsed.error.message);
  }
  return parsed.value;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function validateRoster(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new MatchStateDecodeError("roster must be an array");
  }
  const players = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new MatchStateDecodeError("roster entries must be objects");
    }
    const { playerId: rawPlayerId, status } = entry;
    const playerId = decodeId("user", rawPlayerId) as UserId;
    if (status !== "active" && status !== "eliminated") {
      throw new MatchStateDecodeError("roster status is invalid");
    }
    if (players.has(playerId)) {
      throw new MatchStateDecodeError("roster players must be unique");
    }
    players.add(playerId);
  }
}

export function decodeMatchState(value: unknown): MatchState {
  if (!isRecord(value)) {
    throw new MatchStateDecodeError("snapshot must be an object");
  }

  const {
    matchId: rawMatchId,
    phase,
    phaseDeadline: rawPhaseDeadline,
    roster,
    rulesetSnapshot,
    version,
    winnerPlayerId,
  } = value;
  const matchId = decodeId("match", rawMatchId) as MatchId;
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    throw new MatchStateDecodeError("version must be a positive safe integer");
  }
  if (typeof phase !== "string" || !MATCH_PHASES.has(phase as MatchPhase)) {
    throw new MatchStateDecodeError("phase is invalid");
  }
  const phaseDeadline = decodeOptionalTimestamp(rawPhaseDeadline);
  if (
    (phase === "complete" || phase === "cancelled") &&
    phaseDeadline !== null
  ) {
    throw new MatchStateDecodeError("terminal states cannot have a deadline");
  }

  const parsedRuleset = parseRulesetV1(rulesetSnapshot);
  if (!parsedRuleset.ok) {
    throw new MatchStateDecodeError(parsedRuleset.error.message);
  }

  for (const field of ARRAY_FIELDS) {
    if (!Array.isArray(value[field])) {
      throw new MatchStateDecodeError(`${field} must be an array`);
    }
  }
  for (const field of NULLABLE_OBJECT_FIELDS) {
    const fieldValue = value[field];
    if (fieldValue !== null && !isRecord(fieldValue)) {
      throw new MatchStateDecodeError(`${field} must be an object or null`);
    }
  }
  validateRoster(roster);

  if (winnerPlayerId !== null) {
    decodeId("user", winnerPlayerId);
  }

  const decoded: MatchState = {
    ...(value as unknown as MatchState),
    matchId,
    version: version as MatchVersion,
    phase: phase as MatchPhase,
    phaseDeadline,
    rulesetSnapshot: parsedRuleset.value,
  };
  return deepFreeze(decoded);
}

export function contestantStatus(value: string): ContestantStatus {
  if (value !== "active" && value !== "eliminated") {
    throw new MatchStateDecodeError("persisted roster status is invalid");
  }
  return value;
}
