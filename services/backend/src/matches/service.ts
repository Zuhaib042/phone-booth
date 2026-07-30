import {
  parseEntityId,
  utcTimestampFromDate,
  type MatchId,
  type UserId,
  type UtcTimestamp,
} from "@project-booth/domain";
import { applyLobbyCommand } from "@project-booth/game-engine";

import {
  MatchNotFoundError,
  type MatchCommandTransition,
  type PostgresMatchCommandExecutor,
} from "../persistence/match-command-executor.js";

export interface MatchReadyView {
  readonly matchId: string;
  readonly matchVersion: number;
  readonly phase: string;
  readonly phaseDeadline: string | null;
  readonly ready: boolean;
}

export class MatchApplicationError extends Error {
  public constructor(
    public readonly code: "invalid_match_command" | "match_not_found",
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "MatchApplicationError";
  }
}

function timestamp(date: Date): UtcTimestamp {
  const parsed = utcTimestampFromDate(date);
  if (!parsed.ok) {
    throw new RangeError("Match command clock returned an invalid timestamp");
  }
  return parsed.value;
}

export class PostgresMatchApplication {
  public constructor(
    private readonly executor: PostgresMatchCommandExecutor,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async confirmBoothReady(
    userIdValue: string,
    matchIdValue: string,
    idempotencyKey: string,
  ): Promise<MatchReadyView> {
    const userId = parseEntityId("user", userIdValue);
    const matchId = parseEntityId("match", matchIdValue);
    if (!userId.ok || !matchId.ok) {
      throw new MatchApplicationError(
        "match_not_found",
        "The match was not found",
        404,
      );
    }
    const occurredAt = timestamp(this.clock());
    try {
      const response = await this.executor.execute({
        accountId: userId.value as UserId,
        operation: "match.booth.ready",
        idempotencyKey,
        request: { matchId: matchIdValue },
        matchId: matchId.value as MatchId,
        occurredAt,
        apply: (state): MatchCommandTransition => {
          const transition = applyLobbyCommand(state, {
            type: "contestant_ready",
            playerId: userId.value as UserId,
            occurredAt,
          });
          if (!transition.ok) {
            throw new MatchApplicationError(
              "invalid_match_command",
              "The contestant cannot become ready in the current match state",
              409,
            );
          }
          return {
            state: transition.value.state,
            events: transition.value.events,
            response: {
              status: 200,
              headers: { "content-type": "application/json" },
              body: {
                matchId: matchIdValue,
                matchVersion: transition.value.state.version,
                phase: transition.value.state.phase,
                phaseDeadline: transition.value.state.phaseDeadline,
                ready: transition.value.state.readyPlayerIds.includes(
                  userId.value as UserId,
                ),
              },
            },
          };
        },
      });
      return response.body as unknown as MatchReadyView;
    } catch (error: unknown) {
      if (error instanceof MatchNotFoundError) {
        throw new MatchApplicationError(
          "match_not_found",
          "The match was not found",
          404,
        );
      }
      throw error;
    }
  }
}
