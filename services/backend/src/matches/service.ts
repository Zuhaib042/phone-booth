import {
  parseEntityId,
  utcTimestampFromDate,
  type MatchId,
  type UserId,
  type UtcTimestamp,
} from "@project-booth/domain";
import {
  applyLobbyCommand,
  applyRoundCommand,
} from "@project-booth/game-engine";

import type { PostgresEconomyService } from "../economy/service.js";
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
    private readonly economy?: PostgresEconomyService,
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

  public async submitNormalBallot(
    userIdValue: string,
    matchIdValue: string,
    targetUserIdValue: string,
    idempotencyKey: string,
  ): Promise<{
    readonly matchId: string;
    readonly matchVersion: number;
    readonly revision: number;
    readonly submitted: true;
  }> {
    const userId = parseEntityId("user", userIdValue);
    const matchId = parseEntityId("match", matchIdValue);
    const targetUserId = parseEntityId("user", targetUserIdValue);
    if (!userId.ok || !matchId.ok || !targetUserId.ok) {
      throw new MatchApplicationError(
        "match_not_found",
        "The match was not found",
        404,
      );
    }
    const occurredAt = timestamp(this.clock());
    try {
      const result = await this.executor.execute({
        accountId: userId.value as UserId,
        operation: "match.normal_ballot.submit",
        idempotencyKey,
        request: { matchId: matchIdValue, targetUserId: targetUserIdValue },
        matchId: matchId.value as MatchId,
        occurredAt,
        apply: (state): MatchCommandTransition => {
          const transition = applyRoundCommand(state, {
            type: "normal_ballot_submitted",
            voterId: userId.value as UserId,
            targetId: targetUserId.value as UserId,
            occurredAt,
          });
          if (!transition.ok) {
            throw new MatchApplicationError(
              "invalid_match_command",
              "The ballot is not valid in the current match state",
              409,
            );
          }
          const ballot = transition.value.state.normalBallots.find(
            ({ voterId }) => voterId === userId.value,
          );
          if (ballot === undefined) {
            throw new Error("Valid ballot transition did not retain a ballot");
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
                revision: ballot.revision,
                submitted: true,
              },
            },
          };
        },
        afterApply: async (client, previous, transition) => {
          if (
            this.economy !== undefined &&
            !previous.normalBallots.some(
              ({ voterId }) => voterId === userId.value,
            )
          ) {
            await this.economy.settleIncomingWithinTransaction(
              client,
              matchId.value,
              userId.value,
              previous.completedRounds.length + 1,
              occurredAt,
              transition.state.version,
            );
          }
        },
      });
      return result.body as {
        readonly matchId: string;
        readonly matchVersion: number;
        readonly revision: number;
        readonly submitted: true;
      };
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
