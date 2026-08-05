import Foundation
import Observation

enum EventApplication: Equatable {
    case applied
    case ignored
    case snapshotRequired
}

@MainActor
@Observable
final class MatchStore {
    private(set) var projection: MatchProjection?
    private var appliedEventIDs: Set<UUID> = []
    private var eventOrder: [UUID] = []
    private let deduplicationCapacity = 512

    var recipientCursor: Int { projection?.recipientCursor ?? 0 }

    func apply(snapshot: MatchSnapshot) {
        if let projection, projection.matchId == snapshot.matchId,
           snapshot.matchVersion < projection.version {
            return
        }
        projection = MatchProjection(
            matchId: snapshot.matchId,
            version: snapshot.matchVersion,
            recipientCursor: snapshot.lastRecipientCursor,
            phase: snapshot.phase,
            phaseDeadline: snapshot.phaseDeadline,
            roster: snapshot.roster,
            ruleset: snapshot.ruleset,
            selfProjection: snapshot.selfProjection
        )
        appliedEventIDs.removeAll(keepingCapacity: true)
        eventOrder.removeAll(keepingCapacity: true)
    }

    @discardableResult
    func apply(event: RealtimeEvent) -> EventApplication {
        guard var current = projection, current.matchId == event.matchId else {
            return .snapshotRequired
        }
        if appliedEventIDs.contains(event.eventId) || event.recipientCursor <= current.recipientCursor {
            return .ignored
        }
        guard event.recipientCursor == current.recipientCursor + 1,
              event.matchVersion >= current.version else {
            return .snapshotRequired
        }

        current.recipientCursor = event.recipientCursor
        current.version = event.matchVersion
        if case .string(let phase)? = event.payload["phase"] { current.phase = phase }
        if case .string(let deadline)? = event.payload["phaseDeadline"] {
            current.phaseDeadline = ISO8601DateFormatter().date(from: deadline)
        } else if case .null? = event.payload["phaseDeadline"] {
            current.phaseDeadline = nil
        }
        projection = current
        remember(event.eventId)
        return .applied
    }

    private func remember(_ eventID: UUID) {
        appliedEventIDs.insert(eventID)
        eventOrder.append(eventID)
        if eventOrder.count > deduplicationCapacity {
            appliedEventIDs.remove(eventOrder.removeFirst())
        }
    }
}
