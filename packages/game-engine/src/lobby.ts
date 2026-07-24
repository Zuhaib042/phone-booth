import {
  domainError,
  err,
  ok,
  utcTimestampFromDate,
  type DomainError,
  type Result,
  type UserId,
  type UtcTimestamp,
} from "@project-booth/domain";

import type { MatchState, MatchVersion } from "./match-state.js";

export type LobbyCommand =
  | {
      readonly type: "contestant_ready";
      readonly playerId: UserId;
      readonly occurredAt: UtcTimestamp;
    }
  | {
      readonly type: "lobby_timed_out";
      readonly occurredAt: UtcTimestamp;
    };

export type LobbyEvent =
  | {
      readonly type: "lobby.contestant_ready";
      readonly playerId: UserId;
    }
  | {
      readonly type: "match.phase_changed";
      readonly phase: "negotiation";
      readonly deadline: UtcTimestamp;
    }
  | {
      readonly type: "match.cancelled";
      readonly reason: "insufficient_ready_contestants";
    };

export interface LobbyTransition {
  readonly state: MatchState;
  readonly events: readonly LobbyEvent[];
}

type InvalidLobbyReason =
  | "deadline_passed"
  | "deadline_not_reached"
  | "deadline_out_of_range"
  | "player_not_in_roster"
  | "wrong_phase";

export type InvalidLobbyCommandError = DomainError<
  "invalid_lobby_command",
  {
    readonly reason: InvalidLobbyReason;
  }
>;

const NO_EVENTS: readonly LobbyEvent[] = Object.freeze([]);

function invalid(reason: InvalidLobbyReason): InvalidLobbyCommandError {
  return domainError("invalid_lobby_command", "Lobby command is not valid", {
    reason,
  });
}

function nextVersion(version: MatchVersion): MatchVersion {
  return (version + 1) as MatchVersion;
}

function transition(
  state: MatchState,
  updates: Partial<MatchState>,
  events: readonly LobbyEvent[],
): LobbyTransition {
  return Object.freeze({
    state: Object.freeze({
      ...state,
      ...updates,
      version: nextVersion(state.version),
    }),
    events: Object.freeze(events.map((event) => Object.freeze(event))),
  });
}

function beginNegotiation(
  state: MatchState,
  occurredAt: UtcTimestamp,
  readyPlayerIds: readonly UserId[],
  events: readonly LobbyEvent[],
): Result<LobbyTransition, InvalidLobbyCommandError> {
  const duration = state.rulesetSnapshot.phaseDurationsSeconds.firstNegotiation;
  const deadline = utcTimestampFromDate(
    new Date(Date.parse(occurredAt) + duration * 1_000),
  );
  if (!deadline.ok) {
    return err(invalid("deadline_out_of_range"));
  }

  return ok(
    transition(
      state,
      {
        phase: "negotiation",
        phaseDeadline: deadline.value,
        readyPlayerIds,
      },
      [
        ...events,
        {
          type: "match.phase_changed",
          phase: "negotiation",
          deadline: deadline.value,
        },
      ],
    ),
  );
}

export function applyLobbyCommand(
  state: MatchState,
  command: LobbyCommand,
): Result<LobbyTransition, InvalidLobbyCommandError> {
  if (state.phase !== "lobby" || state.phaseDeadline === null) {
    return err(invalid("wrong_phase"));
  }

  if (command.type === "contestant_ready") {
    if (command.occurredAt >= state.phaseDeadline) {
      return err(invalid("deadline_passed"));
    }
    if (!state.roster.some(({ playerId }) => playerId === command.playerId)) {
      return err(invalid("player_not_in_roster"));
    }
    if (state.readyPlayerIds.includes(command.playerId)) {
      return ok(Object.freeze({ state, events: NO_EVENTS }));
    }

    const readyPlayerIds = Object.freeze(
      state.roster
        .map(({ playerId }) => playerId)
        .filter(
          (playerId) =>
            playerId === command.playerId ||
            state.readyPlayerIds.includes(playerId),
        ),
    );
    const events = [
      { type: "lobby.contestant_ready", playerId: command.playerId },
    ] as const;

    return readyPlayerIds.length === state.roster.length
      ? beginNegotiation(state, command.occurredAt, readyPlayerIds, events)
      : ok(transition(state, { readyPlayerIds }, events));
  }

  if (command.occurredAt < state.phaseDeadline) {
    return err(invalid("deadline_not_reached"));
  }
  if (
    state.readyPlayerIds.length < state.rulesetSnapshot.roster.minimumReadyCount
  ) {
    return ok(
      transition(state, { phase: "cancelled", phaseDeadline: null }, [
        {
          type: "match.cancelled",
          reason: "insufficient_ready_contestants",
        },
      ]),
    );
  }

  return beginNegotiation(
    state,
    command.occurredAt,
    state.readyPlayerIds,
    NO_EVENTS,
  );
}
