import Foundation
import Observation

@MainActor
@Observable
final class AppModel {
    let session: SessionController
    let matchStore: MatchStore
    let api: BoothAPIClient
    let home: HomeModel

    init(
        session: SessionController,
        api: BoothAPIClient,
        matchStore: MatchStore = MatchStore()
    ) {
        self.session = session
        self.api = api
        self.matchStore = matchStore
        home = HomeModel(loader: api)
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
        return AppModel(session: session, api: api)
    }

    func restoreSession() async {
        await session.restore()
    }

    func logout() async {
        home.reset()
        await session.logout()
    }
}
