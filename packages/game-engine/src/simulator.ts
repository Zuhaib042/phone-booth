import {
  domainError,
  err,
  ok,
  utcTimestampFromDate,
  type DomainError,
  type MatchId,
  type Result,
  type UserId,
  type UtcTimestamp,
} from "@project-booth/domain";
import type { RulesetV1 } from "@project-booth/config";

import { createDossierProjection, type DossierProjection } from "./dossier.js";
import { applyFinaleCommand } from "./finale.js";
import { applyLobbyCommand } from "./lobby.js";
import {
  createMatchState,
  type MatchPhase,
  type MatchState,
} from "./match-state.js";
import { applyRunoffCommand } from "./runoff.js";
import { applyTallyCommand } from "./tally.js";
import { applyRoundCommand } from "./voting.js";

export interface HeadlessSimulationInput {
  readonly matchId: MatchId;
  readonly ruleset: RulesetV1;
  readonly playerIds: readonly UserId[];
  readonly lobbyDeadline: UtcTimestamp;
  readonly seed: number;
}

export interface HeadlessSimulationResult {
  readonly seed: number;
  readonly commandCount: number;
  readonly state: MatchState;
  readonly dossier: DossierProjection;
}

type SimulationFailureReason =
  | "command_limit"
  | "illegal_transition"
  | "invalid_input"
  | "invalid_seed"
  | "invalid_timestamp";

export type SimulationError = DomainError<
  "simulation_failed",
  {
    readonly reason: SimulationFailureReason;
    readonly phase: MatchPhase;
    readonly commandType: string;
  }
>;

interface StateTransition {
  readonly state: MatchState;
}

class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (Math.imul(this.state, 1_664_525) + 1_013_904_223) >>> 0;
    return this.state / 0x1_0000_0000;
  }

  choose<Value>(values: readonly Value[]): Value | undefined {
    return values[Math.floor(this.next() * values.length)];
  }
}

function simulationError(
  reason: SimulationFailureReason,
  phase: MatchPhase,
  commandType: string,
): SimulationError {
  return domainError("simulation_failed", "Headless simulation failed", {
    reason,
    phase,
    commandType,
  });
}

function shifted(
  timestamp: UtcTimestamp,
  milliseconds: number,
): UtcTimestamp | null {
  const result = utcTimestampFromDate(
    new Date(Date.parse(timestamp) + milliseconds),
  );
  return result.ok ? result.value : null;
}

function activePlayerIds(state: MatchState): readonly UserId[] {
  return state.roster.flatMap(({ playerId, status }) =>
    status === "active" ? [playerId] : [],
  );
}

export function simulateHeadlessMatch(
  input: HeadlessSimulationInput,
): Result<HeadlessSimulationResult, SimulationError> {
  if (
    !Number.isSafeInteger(input.seed) ||
    input.seed < 0 ||
    input.seed > 0xffff_ffff
  ) {
    return err(simulationError("invalid_seed", "lobby", "simulation_started"));
  }
  if (
    input.playerIds.length !== 6 ||
    input.ruleset.roster.contestantCount !== 6
  ) {
    return err(simulationError("invalid_input", "lobby", "simulation_started"));
  }
  const constructed = createMatchState({
    matchId: input.matchId,
    ruleset: input.ruleset,
    playerIds: input.playerIds,
    lobbyDeadline: input.lobbyDeadline,
  });
  if (!constructed.ok) {
    return err(simulationError("invalid_input", "lobby", "match_created"));
  }

  let state = constructed.value;
  let commandCount = 0;
  let currentTime = shifted(input.lobbyDeadline, -1);
  let failure: SimulationError | null = null;
  const random = new SeededRandom(input.seed);
  const accept = (
    result: Result<StateTransition, unknown>,
    commandType: string,
  ): boolean => {
    if (!result.ok) {
      failure = simulationError("illegal_transition", state.phase, commandType);
      return false;
    }
    state = result.value.state;
    commandCount += 1;
    return true;
  };
  const requireDeadline = (commandType: string): UtcTimestamp | null => {
    if (state.phaseDeadline === null) {
      failure = simulationError("invalid_timestamp", state.phase, commandType);
    }
    return state.phaseDeadline;
  };
  if (currentTime === null) {
    return err(
      simulationError("invalid_timestamp", "lobby", "contestant_ready"),
    );
  }
  for (const playerId of input.playerIds) {
    if (
      !accept(
        applyLobbyCommand(state, {
          type: "contestant_ready",
          playerId,
          occurredAt: currentTime,
        }),
        "contestant_ready",
      )
    ) {
      return err(
        failure ??
          simulationError(
            "illegal_transition",
            state.phase,
            "contestant_ready",
          ),
      );
    }
  }

  while (state.phase !== "complete" && commandCount < 500) {
    if (state.phase === "negotiation") {
      const deadline = requireDeadline("negotiation_timed_out");
      if (
        deadline === null ||
        !accept(
          applyRoundCommand(state, {
            type: "negotiation_timed_out",
            occurredAt: deadline,
          }),
          "negotiation_timed_out",
        )
      ) {
        break;
      }
      currentTime = deadline;
      continue;
    }

    if (state.phase === "voting") {
      const deadline = requireDeadline("normal_ballot_submitted");
      const occurredAt = deadline === null ? null : shifted(deadline, -1);
      if (occurredAt === null) {
        failure = simulationError(
          "invalid_timestamp",
          state.phase,
          "normal_ballot_submitted",
        );
        break;
      }
      for (const voterId of activePlayerIds(state)) {
        const targetId = random.choose(
          activePlayerIds(state).filter((playerId) => playerId !== voterId),
        );
        if (
          targetId === undefined ||
          !accept(
            applyRoundCommand(state, {
              type: "normal_ballot_submitted",
              voterId,
              targetId,
              occurredAt,
            }),
            "normal_ballot_submitted",
          )
        ) {
          break;
        }
      }
      if (failure !== null) {
        break;
      }
      currentTime = deadline;
      continue;
    }

    if (state.phase === "tally") {
      if (
        currentTime === null ||
        !accept(
          applyTallyCommand(state, {
            type: "normal_ballots_tallied",
            occurredAt: currentTime,
          }),
          "normal_ballots_tallied",
        )
      ) {
        break;
      }
      if (
        state.phase === "tally" &&
        !accept(
          applyRunoffCommand(state, {
            type: "runoff_started",
            occurredAt: currentTime,
            randomSample: random.next(),
          }),
          "runoff_started",
        )
      ) {
        break;
      }
      continue;
    }

    if (state.phase === "runoff_negotiation") {
      const deadline = requireDeadline("runoff_negotiation_timed_out");
      if (
        deadline === null ||
        !accept(
          applyRunoffCommand(state, {
            type: "runoff_negotiation_timed_out",
            occurredAt: deadline,
          }),
          "runoff_negotiation_timed_out",
        )
      ) {
        break;
      }
      currentTime = deadline;
      continue;
    }

    if (state.phase === "runoff_voting") {
      const deadline = requireDeadline("runoff_ballot_submitted");
      const occurredAt = deadline === null ? null : shifted(deadline, -1);
      if (occurredAt === null) {
        failure = simulationError(
          "invalid_timestamp",
          state.phase,
          "runoff_ballot_submitted",
        );
        break;
      }
      for (const voterId of activePlayerIds(state).filter(
        (playerId) => !state.runoffPlayerIds.includes(playerId),
      )) {
        const targetId = random.choose(state.runoffPlayerIds);
        if (
          targetId === undefined ||
          !accept(
            applyRunoffCommand(state, {
              type: "runoff_ballot_submitted",
              voterId,
              targetId,
              occurredAt,
            }),
            "runoff_ballot_submitted",
          )
        ) {
          break;
        }
      }
      if (
        failure !== null ||
        !accept(
          applyRunoffCommand(state, {
            type: "runoff_tallied",
            occurredAt,
            randomSample: random.next(),
          }),
          "runoff_tallied",
        )
      ) {
        break;
      }
      currentTime = occurredAt;
      continue;
    }

    if (state.phase === "elimination") {
      const deadline = requireDeadline("elimination_reveal_timed_out");
      if (
        deadline === null ||
        !accept(
          applyFinaleCommand(state, {
            type: "elimination_reveal_timed_out",
            occurredAt: deadline,
          }),
          "elimination_reveal_timed_out",
        )
      ) {
        break;
      }
      currentTime = deadline;
      continue;
    }

    if (state.phase === "final_plea") {
      const deadline = requireDeadline("final_plea_submitted");
      const occurredAt = deadline === null ? null : shifted(deadline, -1);
      if (occurredAt === null) {
        failure = simulationError(
          "invalid_timestamp",
          state.phase,
          "final_plea_submitted",
        );
        break;
      }
      for (const playerId of activePlayerIds(state)) {
        if (
          !accept(
            applyFinaleCommand(state, {
              type: "final_plea_submitted",
              playerId,
              text: `Seed ${input.seed}: keep me in the booth.`,
              occurredAt,
            }),
            "final_plea_submitted",
          )
        ) {
          break;
        }
      }
      currentTime = occurredAt;
      continue;
    }

    if (state.phase === "jury_voting") {
      const deadline = requireDeadline("jury_ballot_submitted");
      const occurredAt = deadline === null ? null : shifted(deadline, -1);
      const finalists = activePlayerIds(state);
      if (occurredAt === null) {
        failure = simulationError(
          "invalid_timestamp",
          state.phase,
          "jury_ballot_submitted",
        );
        break;
      }
      for (const jurorId of state.roster.flatMap(({ playerId, status }) =>
        status === "eliminated" ? [playerId] : [],
      )) {
        const finalistId = random.choose(finalists);
        if (
          finalistId === undefined ||
          !accept(
            applyFinaleCommand(state, {
              type: "jury_ballot_submitted",
              jurorId,
              finalistId,
              occurredAt,
            }),
            "jury_ballot_submitted",
          )
        ) {
          break;
        }
      }
      if (
        failure !== null ||
        !accept(
          applyFinaleCommand(state, {
            type: "jury_tallied",
            occurredAt,
            randomSample: random.next(),
          }),
          "jury_tallied",
        )
      ) {
        break;
      }
      currentTime = occurredAt;
      continue;
    }

    failure = simulationError(
      "illegal_transition",
      state.phase,
      "unsupported_phase",
    );
    break;
  }

  if (failure !== null) {
    return err(failure);
  }
  if (state.phase !== "complete" || state.winnerPlayerId === null) {
    return err(simulationError("command_limit", state.phase, "simulation"));
  }
  const dossier = createDossierProjection(state, {
    viewerPlayerId: input.playerIds[0] as UserId,
    deals: [],
  });
  if (!dossier.ok) {
    return err(simulationError("illegal_transition", state.phase, "dossier"));
  }
  return ok(
    Object.freeze({
      seed: input.seed,
      commandCount,
      state,
      dossier: dossier.value,
    }),
  );
}
