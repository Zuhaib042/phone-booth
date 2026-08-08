import Foundation

struct MatchSnapshot: Codable, Equatable, Sendable {
  struct PrivateBallot: Codable, Equatable, Sendable {
    let targetUserId: UUID
    let revision: Int
  }

  struct PrivateJuryBallot: Codable, Equatable, Sendable {
    let finalistUserId: UUID
    let revision: Int
  }

  struct FinalPlea: Codable, Equatable, Identifiable, Sendable {
    let text: String
    let userId: UUID
    var id: UUID { userId }
  }

  struct RosterEntry: Codable, Equatable, Identifiable, Sendable {
    let avatarKey: String
    let displayName: String
    let ready: Bool
    let status: String
    let userId: UUID

    var id: UUID { userId }
  }

  struct Ruleset: Codable, Equatable, Sendable {
    let rulesetId: UUID
    let rulesetVersion: Int
  }

  struct SelfProjection: Codable, Equatable, Sendable {
    let finalPleaSubmitted: Bool
    let juryBallot: PrivateJuryBallot?
    let normalBallot: PrivateBallot?
    let ready: Bool
    let runoffBallot: PrivateBallot?
    let userId: UUID

    init(
      finalPleaSubmitted: Bool = false,
      juryBallot: PrivateJuryBallot? = nil,
      normalBallot: PrivateBallot? = nil,
      ready: Bool,
      runoffBallot: PrivateBallot? = nil,
      userId: UUID
    ) {
      self.finalPleaSubmitted = finalPleaSubmitted
      self.juryBallot = juryBallot
      self.normalBallot = normalBallot
      self.ready = ready
      self.runoffBallot = runoffBallot
      self.userId = userId
    }

    init(from decoder: any Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)
      finalPleaSubmitted =
        try container.decodeIfPresent(Bool.self, forKey: .finalPleaSubmitted) ?? false
      juryBallot = try container.decodeIfPresent(PrivateJuryBallot.self, forKey: .juryBallot)
      normalBallot = try container.decodeIfPresent(PrivateBallot.self, forKey: .normalBallot)
      ready = try container.decode(Bool.self, forKey: .ready)
      runoffBallot = try container.decodeIfPresent(PrivateBallot.self, forKey: .runoffBallot)
      userId = try container.decode(UUID.self, forKey: .userId)
    }

    private enum CodingKeys: String, CodingKey {
      case finalPleaSubmitted, juryBallot, normalBallot, ready, runoffBallot, userId
    }
  }

  let lastRecipientCursor: Int
  let matchId: UUID
  let matchVersion: Int
  let phase: String
  let phaseDeadline: Date?
  let roundNumber: Int
  let runoffUserIds: [UUID]
  let finalPleas: [FinalPlea]
  let winnerUserId: UUID?
  let roster: [RosterEntry]
  let ruleset: Ruleset
  let selfProjection: SelfProjection

  init(
    lastRecipientCursor: Int,
    matchId: UUID,
    matchVersion: Int,
    phase: String,
    phaseDeadline: Date?,
    roundNumber: Int = 1,
    runoffUserIds: [UUID] = [],
    finalPleas: [FinalPlea] = [],
    winnerUserId: UUID? = nil,
    roster: [RosterEntry],
    ruleset: Ruleset,
    selfProjection: SelfProjection
  ) {
    self.lastRecipientCursor = lastRecipientCursor
    self.matchId = matchId
    self.matchVersion = matchVersion
    self.phase = phase
    self.phaseDeadline = phaseDeadline
    self.roundNumber = roundNumber
    self.runoffUserIds = runoffUserIds
    self.finalPleas = finalPleas
    self.winnerUserId = winnerUserId
    self.roster = roster
    self.ruleset = ruleset
    self.selfProjection = selfProjection
  }

  init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    lastRecipientCursor = try container.decode(Int.self, forKey: .lastRecipientCursor)
    matchId = try container.decode(UUID.self, forKey: .matchId)
    matchVersion = try container.decode(Int.self, forKey: .matchVersion)
    phase = try container.decode(String.self, forKey: .phase)
    phaseDeadline = try container.decodeIfPresent(Date.self, forKey: .phaseDeadline)
    roundNumber = try container.decodeIfPresent(Int.self, forKey: .roundNumber) ?? 1
    runoffUserIds = try container.decodeIfPresent([UUID].self, forKey: .runoffUserIds) ?? []
    finalPleas = try container.decodeIfPresent([FinalPlea].self, forKey: .finalPleas) ?? []
    winnerUserId = try container.decodeIfPresent(UUID.self, forKey: .winnerUserId)
    roster = try container.decode([RosterEntry].self, forKey: .roster)
    ruleset = try container.decode(Ruleset.self, forKey: .ruleset)
    selfProjection = try container.decode(SelfProjection.self, forKey: .selfProjection)
  }

  private enum CodingKeys: String, CodingKey {
    case lastRecipientCursor, matchId, matchVersion, phase, phaseDeadline, roundNumber
    case runoffUserIds, finalPleas, winnerUserId, roster, ruleset
    case selfProjection = "self"
  }
}

struct MatchProjection: Equatable, Sendable {
  var matchId: UUID
  var version: Int
  var recipientCursor: Int
  var phase: String
  var phaseDeadline: Date?
  var roundNumber: Int
  var runoffUserIds: [UUID]
  var finalPleas: [MatchSnapshot.FinalPlea]
  var winnerUserId: UUID?
  var roster: [MatchSnapshot.RosterEntry]
  var ruleset: MatchSnapshot.Ruleset
  var selfProjection: MatchSnapshot.SelfProjection
}
