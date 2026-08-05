import Foundation
import Observation

struct HomeProjection: Equatable, Sendable {
    let avatarKey: String
    let configuredMatchOutflowCap: Int
    let displayName: String
    let progressionLevel: Int
    let restricted: Bool
    let spendableBalance: Int
}

protocol HomeDataLoading: Sendable {
    func loadHome() async throws -> HomeProjection
}

@MainActor
@Observable
final class HomeModel {
    enum State: Equatable {
        case idle
        case loading
        case loaded(HomeProjection)
        case failed(String)
    }

    private(set) var state: State = .idle
    private let loader: any HomeDataLoading

    init(loader: any HomeDataLoading) {
        self.loader = loader
    }

    func load() async {
        state = .loading
        do {
            state = .loaded(try await loader.loadHome())
        } catch is CancellationError {
            state = .idle
        } catch {
            state = .failed("Your booth could not be loaded. Check your connection and try again.")
        }
    }

    func reset() {
        state = .idle
    }
}
