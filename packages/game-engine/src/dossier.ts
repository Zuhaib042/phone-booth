import {
  domainError,
  err,
  ok,
  type DomainError,
  type MatchId,
  type Result,
  type UserId,
} from "@project-booth/domain";

import type {
  CompletedRound,
  EliminationVoteTotal,
  FinalPlea,
  JuryBallot,
  JuryResult,
  MatchState,
} from "./match-state.js";

export type DealDossierOutcome =
  "honored" | "betrayed" | "reversed" | "declined" | "expired";

export interface DossierDealRecord {
  readonly senderPlayerId: UserId;
  readonly recipientPlayerId: UserId;
  readonly promisedTargetPlayerId: UserId;
  readonly outcome: DealDossierOutcome;
}

export interface DossierProjectionInput {
  readonly viewerPlayerId: UserId;
  readonly deals: readonly DossierDealRecord[];
}

export interface DossierProjection {
  readonly matchId: MatchId;
  readonly viewerPlayerId: UserId;
  readonly winnerPlayerId: UserId;
  readonly eliminationOrder: readonly UserId[];
  readonly rounds: readonly CompletedRound[];
  readonly finalPleas: readonly FinalPlea[];
  readonly juryBallots: readonly JuryBallot[];
  readonly juryResult: JuryResult;
  readonly cumulativeEliminationVoteTotals: readonly EliminationVoteTotal[];
  readonly deals: readonly DossierDealRecord[];
}

type DossierProjectionReason =
  "invalid_deal_participant" | "match_not_complete" | "viewer_not_in_roster";

export type DossierProjectionError = DomainError<
  "dossier_projection_denied",
  { readonly reason: DossierProjectionReason }
>;

function denied(reason: DossierProjectionReason): DossierProjectionError {
  return domainError(
    "dossier_projection_denied",
    "Dossier projection is not available",
    { reason },
  );
}

export function createDossierProjection(
  state: MatchState,
  input: DossierProjectionInput,
): Result<DossierProjection, DossierProjectionError> {
  if (
    state.phase !== "complete" ||
    state.winnerPlayerId === null ||
    state.juryResult === null
  ) {
    return err(denied("match_not_complete"));
  }
  const rosterPlayerIds = state.roster.map(({ playerId }) => playerId);
  if (!rosterPlayerIds.includes(input.viewerPlayerId)) {
    return err(denied("viewer_not_in_roster"));
  }
  if (
    input.deals.some(
      ({ senderPlayerId, recipientPlayerId, promisedTargetPlayerId }) =>
        !rosterPlayerIds.includes(senderPlayerId) ||
        !rosterPlayerIds.includes(recipientPlayerId) ||
        !rosterPlayerIds.includes(promisedTargetPlayerId),
    )
  ) {
    return err(denied("invalid_deal_participant"));
  }

  const deals = Object.freeze(
    input.deals.map((deal) => Object.freeze({ ...deal })),
  );
  return ok(
    Object.freeze({
      matchId: state.matchId,
      viewerPlayerId: input.viewerPlayerId,
      winnerPlayerId: state.winnerPlayerId,
      eliminationOrder: Object.freeze(
        state.completedRounds.map(
          ({ eliminatedPlayerId }) => eliminatedPlayerId,
        ),
      ),
      rounds: state.completedRounds,
      finalPleas: state.finalPleas,
      juryBallots: state.juryBallots,
      juryResult: state.juryResult,
      cumulativeEliminationVoteTotals: state.cumulativeEliminationVoteTotals,
      deals,
    }),
  );
}
