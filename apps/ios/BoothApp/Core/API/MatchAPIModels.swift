import Foundation

struct MatchmakingTicket: Codable, Equatable, Sendable {
  let compatibilityVersion: Int
  let createdAt: Date
  let language: String
  let matchId: UUID?
  let proposalId: UUID?
  let readyConfirmed: Bool
  let readyDeadline: Date?
  let region: String
  let rulesetId: UUID
  let rulesetVersion: Int
  let status: String
  let ticketId: UUID
  let updatedAt: Date
}

struct MatchReadyProjection: Codable, Equatable, Sendable {
  let matchId: UUID
  let matchVersion: Int
  let phase: String
  let phaseDeadline: Date?
  let ready: Bool
}

struct CoinWalletProjection: Codable, Equatable, Sendable {
  struct Allowance: Codable, Equatable, Sendable {
    let acceptedOutflow: Int
    let cap: Int
    let remaining: Int
  }

  let configuredMatchOutflowCap: Int?
  let matchAllowance: Allowance?
  let pending: Int
  let reserved: Int
  let restricted: Bool
  let spendable: Int
}

struct QuickPhrase: Codable, Equatable, Identifiable, Sendable {
  let key: String
  let text: String
  var id: String { key }
}

struct ChatThreadProjection: Codable, Equatable, Identifiable, Sendable {
  struct OtherUser: Codable, Equatable, Sendable {
    let avatarKey: String
    let displayName: String
    let userId: UUID
  }

  let blocked: Bool
  let createdAt: Date
  let matchId: UUID
  let muted: Bool
  let otherUser: OtherUser
  let threadId: UUID
  var id: UUID { threadId }
}

struct ChatMessageProjection: Codable, Equatable, Identifiable, Sendable {
  let body: String
  let kind: String
  let messageId: UUID
  let quickPhraseKey: String?
  let recipientUserId: UUID
  let senderUserId: UUID
  let sentAt: Date
  let threadId: UUID
  var id: UUID { messageId }
}

struct ChatMessageAttempt: Codable, Equatable, Identifiable, Sendable {
  let body: String
  let deliveryStatus: String
  let kind: String
  let messageId: UUID
  let quickPhraseKey: String?
  let recipientUserId: UUID
  let senderUserId: UUID
  let sentAt: Date
  let threadId: UUID
  var id: UUID { messageId }
}

struct BribeOfferProjection: Codable, Equatable, Identifiable, Sendable {
  let amount: Int
  let createdAt: Date
  let expiresAt: Date
  let filteredMessage: String?
  let matchId: UUID
  let offerId: UUID
  let recipientUserId: UUID
  let requestedTargetUserId: UUID
  let roundNumber: Int
  let senderUserId: UUID
  let state: String
  var id: UUID { offerId }
}

struct BallotAcknowledgement: Codable, Equatable, Sendable {
  let matchId: UUID
  let matchVersion: Int
  let revision: Int
  let submitted: Bool
}

struct FinalPleaAcknowledgement: Codable, Equatable, Sendable {
  let matchId: UUID
  let matchVersion: Int
  let submitted: Bool
}

struct MatchDossier: Codable, Equatable, Sendable {
  struct Ballot: Codable, Equatable, Identifiable, Sendable {
    let automatic: Bool
    let targetUserId: UUID
    let voterUserId: UUID
    var id: String { "\(voterUserId)-\(targetUserId)-\(automatic)" }
  }

  struct Round: Codable, Equatable, Identifiable, Sendable {
    let automaticBallots: [Ballot]
    let eliminatedUserId: UUID
    let normalBallots: [Ballot]
    let roundNumber: Int
    var id: Int { roundNumber }
  }

  struct Plea: Codable, Equatable, Identifiable, Sendable {
    let text: String
    let userId: UUID
    var id: UUID { userId }
  }

  struct JuryBallot: Codable, Equatable, Identifiable, Sendable {
    let finalistUserId: UUID
    let jurorUserId: UUID
    var id: UUID { jurorUserId }
  }

  struct Deal: Codable, Equatable, Identifiable, Sendable {
    let amount: Int
    let offerId: UUID
    let outcome: String
    let promisedTargetPlayerId: UUID
    let recipientPlayerId: UUID
    let roundNumber: Int
    let senderPlayerId: UUID
    var id: UUID { offerId }
  }

  let deals: [Deal]
  let eliminationOrder: [UUID]
  let finalPleas: [Plea]
  let juryBallots: [JuryBallot]
  let juryResolutionMethod: String
  let matchId: UUID
  let rounds: [Round]
  let winnerUserId: UUID
}

protocol MatchExperienceAPI: Sendable {
  func createMatchmakingTicket() async throws -> MatchmakingTicket
  func matchmakingTicket(_ ticketId: UUID) async throws -> MatchmakingTicket
  func cancelMatchmakingTicket(_ ticketId: UUID) async throws -> MatchmakingTicket
  func confirmMatchmakingReady(_ ticketId: UUID) async throws -> MatchmakingTicket
  func confirmBoothReady(_ matchId: UUID) async throws -> MatchReadyProjection
  func matchSnapshot(_ matchId: UUID) async throws -> MatchSnapshot
  func matchWallet(_ matchId: UUID) async throws -> CoinWalletProjection
  func quickPhrases() async throws -> [QuickPhrase]
  func chatThreads(_ matchId: UUID) async throws -> [ChatThreadProjection]
  func chatMessages(matchId: UUID, threadId: UUID) async throws -> [ChatMessageProjection]
  func sendChatMessage(matchId: UUID, threadId: UUID, text: String) async throws
    -> ChatMessageAttempt
  func sendQuickPhrase(matchId: UUID, threadId: UUID, key: String) async throws
    -> ChatMessageAttempt
  func muteUser(matchId: UUID, userId: UUID) async throws
  func blockUser(matchId: UUID, userId: UUID) async throws
  func reportUser(matchId: UUID, userId: UUID, category: String) async throws
  func reportMessage(matchId: UUID, messageId: UUID, category: String) async throws
  func bribeOffers(_ matchId: UUID) async throws -> [BribeOfferProjection]
  func createBribeOffer(
    matchId: UUID,
    recipientUserId: UUID,
    targetUserId: UUID,
    amount: Int,
    message: String?
  ) async throws -> BribeOfferProjection
  func acceptBribeOffer(_ offerId: UUID) async throws -> BribeOfferProjection
  func declineBribeOffer(_ offerId: UUID) async throws -> BribeOfferProjection
  func submitBallot(matchId: UUID, targetUserId: UUID) async throws -> BallotAcknowledgement
  func submitRunoffBallot(matchId: UUID, targetUserId: UUID) async throws -> BallotAcknowledgement
  func submitFinalPlea(matchId: UUID, text: String) async throws -> FinalPleaAcknowledgement
  func submitJuryBallot(matchId: UUID, finalistUserId: UUID) async throws -> BallotAcknowledgement
  func dossier(_ matchId: UUID) async throws -> MatchDossier
}
