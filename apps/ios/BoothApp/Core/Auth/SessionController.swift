import Foundation
import Observation

@MainActor
@Observable
final class SessionController {
    enum State: Equatable {
        case restoring
        case signedOut
        case signedIn(AuthSession)
        case failed(String)
    }

    private(set) var state: State = .restoring
    private let vault: any SessionVault
    private let authService: any AuthService
    private let tokenProvider: AccessTokenProvider

    init(
        vault: any SessionVault,
        authService: any AuthService,
        tokenProvider: AccessTokenProvider = AccessTokenProvider()
    ) {
        self.vault = vault
        self.authService = authService
        self.tokenProvider = tokenProvider
    }

    func accept(_ session: AuthSession) async {
        do {
            try vault.save(session)
            await tokenProvider.update(session.accessToken)
            state = .signedIn(session)
        } catch {
            state = .failed("Your secure session could not be saved.")
        }
    }

    func signIn(credential: String) async {
        state = .restoring
        do {
            await accept(try await authService.exchange(credential: credential))
        } catch {
            state = .failed("Sign in could not be completed. Please try again.")
        }
    }

    func restore() async {
        state = .restoring
        do {
            guard let stored = try vault.load(), !stored.isRefreshExpired else {
                try? vault.delete()
                await tokenProvider.update(nil)
                state = .signedOut
                return
            }
            let refreshed = try await authService.refresh(using: stored.refreshToken)
            try vault.save(refreshed)
            await tokenProvider.update(refreshed.accessToken)
            state = .signedIn(refreshed)
        } catch AuthServiceError.revoked {
            try? vault.delete()
            await tokenProvider.update(nil)
            state = .signedOut
        } catch {
            state = .failed("We could not restore your session. Check your connection and try again.")
        }
    }

    func logout() async {
        if case .signedIn(let session) = state {
            try? await authService.logout(accessToken: session.accessToken)
        }
        try? vault.delete()
        await tokenProvider.update(nil)
        state = .signedOut
    }
}
