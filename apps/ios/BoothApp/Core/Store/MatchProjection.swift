import Foundation

struct MatchSnapshot: Codable, Equatable, Sendable {
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
        let ready: Bool
        let userId: UUID
    }

    let lastRecipientCursor: Int
    let matchId: UUID
    let matchVersion: Int
    let phase: String
    let phaseDeadline: Date?
    let roster: [RosterEntry]
    let ruleset: Ruleset
    let selfProjection: SelfProjection

    private enum CodingKeys: String, CodingKey {
        case lastRecipientCursor, matchId, matchVersion, phase, phaseDeadline, roster, ruleset
        case selfProjection = "self"
    }
}

struct MatchProjection: Equatable, Sendable {
    var matchId: UUID
    var version: Int
    var recipientCursor: Int
    var phase: String
    var phaseDeadline: Date?
    var roster: [MatchSnapshot.RosterEntry]
    var ruleset: MatchSnapshot.Ruleset
    var selfProjection: MatchSnapshot.SelfProjection
}
