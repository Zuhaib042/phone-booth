import {
  parseEntityId,
  utcTimestampFromDate,
  type MatchId,
  type UserId,
  type UtcTimestamp,
} from "@project-booth/domain";
import {
  createDossierProjection,
  applyFinaleCommand,
  applyLobbyCommand,
  applyRoundCommand,
  applyRunoffCommand,
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

  public async submitRunoffBallot(
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
        operation: "match.runoff_ballot.submit",
        idempotencyKey,
        request: { matchId: matchIdValue, targetUserId: targetUserIdValue },
        matchId: matchId.value as MatchId,
        occurredAt,
        apply: (state): MatchCommandTransition => {
          const transition = applyRunoffCommand(state, {
            type: "runoff_ballot_submitted",
            voterId: userId.value as UserId,
            targetId: targetUserId.value as UserId,
            occurredAt,
          });
          if (!transition.ok) {
            throw new MatchApplicationError(
              "invalid_match_command",
              "The runoff ballot is not valid in the current match state",
              409,
            );
          }
          const ballot = transition.value.state.runoffBallots.find(
            ({ voterId }) => voterId === userId.value,
          );
          if (ballot === undefined) {
            throw new Error("Valid runoff transition did not retain a ballot");
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

  public async submitFinalPlea(
    userIdValue: string,
    matchIdValue: string,
    text: string,
    idempotencyKey: string,
  ): Promise<{
    readonly matchId: string;
    readonly matchVersion: number;
    readonly submitted: true;
  }> {
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
      const result = await this.executor.execute({
        accountId: userId.value as UserId,
        operation: "match.final_plea.submit",
        idempotencyKey,
        request: { matchId: matchIdValue, text },
        matchId: matchId.value as MatchId,
        occurredAt,
        apply: (state): MatchCommandTransition => {
          const transition = applyFinaleCommand(state, {
            type: "final_plea_submitted",
            playerId: userId.value as UserId,
            text,
            occurredAt,
          });
          if (!transition.ok) {
            throw new MatchApplicationError(
              "invalid_match_command",
              "The final plea is not valid in the current match state",
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
                submitted: true,
              },
            },
          };
        },
      });
      return result.body as {
        readonly matchId: string;
        readonly matchVersion: number;
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

  public async submitJuryBallot(
    userIdValue: string,
    matchIdValue: string,
    finalistUserIdValue: string,
    idempotencyKey: string,
  ): Promise<{
    readonly matchId: string;
    readonly matchVersion: number;
    readonly revision: number;
    readonly submitted: true;
  }> {
    const userId = parseEntityId("user", userIdValue);
    const matchId = parseEntityId("match", matchIdValue);
    const finalistUserId = parseEntityId("user", finalistUserIdValue);
    if (!userId.ok || !matchId.ok || !finalistUserId.ok) {
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
        operation: "match.jury_ballot.submit",
        idempotencyKey,
        request: { finalistUserId: finalistUserIdValue, matchId: matchIdValue },
        matchId: matchId.value as MatchId,
        occurredAt,
        apply: (state): MatchCommandTransition => {
          const transition = applyFinaleCommand(state, {
            type: "jury_ballot_submitted",
            jurorId: userId.value as UserId,
            finalistId: finalistUserId.value as UserId,
            occurredAt,
          });
          if (!transition.ok) {
            throw new MatchApplicationError(
              "invalid_match_command",
              "The jury ballot is not valid in the current match state",
              409,
            );
          }
          const ballot = transition.value.state.juryBallots.find(
            ({ jurorId }) => jurorId === userId.value,
          );
          if (ballot === undefined) {
            throw new Error("Valid jury transition did not retain a ballot");
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

  public async dossier(
    userIdValue: string,
    matchIdValue: string,
  ): Promise<unknown> {
    const userId = parseEntityId("user", userIdValue);
    const matchId = parseEntityId("match", matchIdValue);
    if (!userId.ok || !matchId.ok) {
      throw new MatchApplicationError(
        "match_not_found",
        "The match was not found",
        404,
      );
    }
    const state = await this.executor.loadState(matchId.value as MatchId);
    if (state === null) {
      throw new MatchApplicationError(
        "match_not_found",
        "The match was not found",
        404,
      );
    }
    const deals =
      this.economy === undefined
        ? []
        : await this.economy.dossierDeals(matchIdValue, state);
    const projection = createDossierProjection(state, {
      viewerPlayerId: userId.value as UserId,
      deals,
    });
    if (!projection.ok) {
      throw new MatchApplicationError(
        "invalid_match_command",
        "The dossier is available to participants after match completion",
        409,
      );
    }
    return {
      matchId: projection.value.matchId,
      winnerUserId: projection.value.winnerPlayerId,
      eliminationOrder: projection.value.eliminationOrder,
      rounds: projection.value.rounds.map((round, index) => ({
        roundNumber: index + 1,
        eliminatedUserId: round.eliminatedPlayerId,
        normalBallots: round.normalBallots.map((ballot) => ({
          voterUserId: ballot.voterId,
          targetUserId: ballot.targetId,
          automatic: false,
        })),
        automaticBallots: round.automaticSelfVotes.map((ballot) => ({
          voterUserId: ballot.playerId,
          targetUserId: ballot.playerId,
          automatic: true,
        })),
      })),
      finalPleas: projection.value.finalPleas.map((plea) => ({
        userId: plea.playerId,
        text: plea.text,
      })),
      juryBallots: projection.value.juryBallots.map((ballot) => ({
        jurorUserId: ballot.jurorId,
        finalistUserId: ballot.finalistId,
      })),
      juryResolutionMethod: projection.value.juryResult.method,
      deals,
    };
  }
}
