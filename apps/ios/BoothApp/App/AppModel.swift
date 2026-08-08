import Foundation
import Observation

@MainActor
@Observable
final class AppModel {
  let session: SessionController
  let matchStore: MatchStore
  let api: BoothAPIClient
  let home: HomeModel
  let matchmaking: MatchmakingModel
  let liveMatch: LiveMatchModel
  let environment: AppEnvironment

  init(
    session: SessionController,
    api: BoothAPIClient,
    matchStore: MatchStore = MatchStore(),
    environment: AppEnvironment = .current,
    realtimeClient: RealtimeClient = RealtimeClient()
  ) {
    self.session = session
    self.api = api
    self.matchStore = matchStore
    self.environment = environment
    home = HomeModel(loader: api)
    matchmaking = MatchmakingModel(api: api)
    liveMatch = LiveMatchModel(
      api: api,
      store: matchStore,
      realtime: MatchRealtimeCoordinator(
        client: realtimeClient,
        snapshotLoader: URLSessionSnapshotLoader(baseURL: environment.apiBaseURL),
        store: matchStore
      )
    )
  }

  static func live() -> AppModel {
    let environment = AppEnvironment.current
    let vault = KeychainSessionVault(service: "com.projectbooth.app.session")
    let auth = URLSessionAuthService(baseURL: environment.apiBaseURL)
    let tokenProvider = AccessTokenProvider()
    let session = SessionController(
      vault: vault,
      authService: auth,
      tokenProvider: tokenProvider
    )
    let api = BoothAPIClient(baseURL: environment.apiBaseURL, tokenProvider: tokenProvider)
    return AppModel(session: session, api: api, environment: environment)
  }

  func restoreSession() async {
    await session.restore()
  }

  func logout() async {
    home.reset()
    matchmaking.reset()
    await liveMatch.stop()
    await session.logout()
  }
}
