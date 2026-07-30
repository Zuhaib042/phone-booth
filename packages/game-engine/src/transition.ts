import {
  utcTimestampFromDate,
  type InvalidUtcTimestampError,
  type Result,
  type UtcTimestamp,
} from "@project-booth/domain";

import type { MatchState, MatchVersion } from "./match-state.js";

export interface MatchTransition<Event> {
  readonly state: MatchState;
  readonly events: readonly Event[];
}

export function createMatchTransition<Event>(
  state: MatchState,
  updates: Partial<MatchState>,
  events: readonly Event[],
): MatchTransition<Event> {
  return Object.freeze({
    state: Object.freeze({
      ...state,
      ...updates,
      version: (state.version + 1) as MatchVersion,
    }),
    events: Object.freeze(events.map((event) => Object.freeze(event))),
  });
}

export function deadlineAfterSeconds(
  occurredAt: UtcTimestamp,
  seconds: number,
): Result<UtcTimestamp, InvalidUtcTimestampError> {
  return utcTimestampFromDate(
    new Date(Date.parse(occurredAt) + seconds * 1_000),
  );
}
