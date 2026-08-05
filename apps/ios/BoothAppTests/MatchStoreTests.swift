import XCTest
@testable import BoothApp

@MainActor
final class MatchStoreTests: XCTestCase {
    func testDuplicateAndOutOfOrderEventsCannotCorruptProjection() {
        let store = MatchStore()
        let snapshot = Fixtures.snapshot(version: 4, cursor: 10, phase: "lobby")
        store.apply(snapshot: snapshot)
        let event = Fixtures.event(matchId: snapshot.matchId, version: 5, cursor: 11, phase: "booth")

        XCTAssertEqual(store.apply(event: event), .applied)
        XCTAssertEqual(store.projection?.phase, "booth")
        XCTAssertEqual(store.apply(event: event), .ignored)

        let gap = Fixtures.event(matchId: snapshot.matchId, version: 9, cursor: 13, phase: "finale")
        XCTAssertEqual(store.apply(event: gap), .snapshotRequired)
        XCTAssertEqual(store.projection?.version, 5)
        XCTAssertEqual(store.projection?.recipientCursor, 11)
        XCTAssertEqual(store.projection?.phase, "booth")
    }

    func testReconnectSnapshotReconcilesCursorAndVersion() {
        let store = MatchStore()
        let initial = Fixtures.snapshot(version: 2, cursor: 3, phase: "lobby")
        store.apply(snapshot: initial)
        let interrupted = Fixtures.event(matchId: initial.matchId, version: 7, cursor: 9, phase: "vote")
        XCTAssertEqual(store.apply(event: interrupted), .snapshotRequired)

        store.apply(snapshot: Fixtures.snapshot(
            matchId: initial.matchId,
            version: 7,
            cursor: 9,
            phase: "vote"
        ))
        XCTAssertEqual(store.projection?.version, 7)
        XCTAssertEqual(store.recipientCursor, 9)
        XCTAssertEqual(store.projection?.phase, "vote")
    }
}

private enum Fixtures {
    static func snapshot(
        matchId: UUID = UUID(),
        version: Int,
        cursor: Int,
        phase: String
    ) -> MatchSnapshot {
        MatchSnapshot(
            lastRecipientCursor: cursor,
            matchId: matchId,
            matchVersion: version,
            phase: phase,
            phaseDeadline: nil,
            roster: [
                .init(avatarKey: "red", displayName: "Caller", ready: true, status: "active", userId: UUID())
            ],
            ruleset: .init(rulesetId: UUID(), rulesetVersion: 1),
            selfProjection: .init(ready: true, userId: UUID())
        )
    }

    static func event(
        matchId: UUID,
        version: Int,
        cursor: Int,
        phase: String
    ) -> RealtimeEvent {
        RealtimeEvent(
            schemaVersion: 1,
            eventId: UUID(),
            type: "match.domain.phase_changed",
            occurredAt: Date(),
            matchId: matchId,
            matchVersion: version,
            recipientCursor: cursor,
            audience: "participants",
            recipientUserId: nil,
            payload: ["phase": .string(phase)]
        )
    }
}
