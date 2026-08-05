import Foundation

protocol MatchSnapshotLoading: Sendable {
    func snapshot(matchId: UUID, accessToken: String) async throws -> MatchSnapshot
}

@MainActor
final class MatchRealtimeCoordinator {
    private let client: RealtimeClient
    private let snapshotLoader: any MatchSnapshotLoading
    private let store: MatchStore
    private var consumeTask: Task<Void, Never>?

    init(client: RealtimeClient, snapshotLoader: any MatchSnapshotLoading, store: MatchStore) {
        self.client = client
        self.snapshotLoader = snapshotLoader
        self.store = store
    }

    func connect(url: URL, matchId: UUID, accessToken: String) async throws {
        store.apply(snapshot: try await snapshotLoader.snapshot(matchId: matchId, accessToken: accessToken))
        let store = store
        let messages = await client.messages(url: url, accessToken: accessToken) {
            await MainActor.run { store.recipientCursor }
        }
        consumeTask?.cancel()
        consumeTask = Task { [weak self] in
            do {
                for try await message in messages {
                    guard let self else { return }
                    switch message {
                    case .event(let event):
                        if store.apply(event: event) == .snapshotRequired {
                            store.apply(snapshot: try await snapshotLoader.snapshot(matchId: matchId, accessToken: accessToken))
                        }
                    case .protocolError(let error) where error.code == "resync_required":
                        store.apply(snapshot: try await snapshotLoader.snapshot(matchId: matchId, accessToken: accessToken))
                    case .protocolError:
                        break
                    }
                }
            } catch {
                // RealtimeClient owns transport retries. A terminal stream ends quietly.
            }
        }
    }

    func disconnect() async {
        consumeTask?.cancel()
        consumeTask = nil
        await client.disconnect()
    }
}
