import XCTest
@testable import BoothApp

@MainActor
final class SessionControllerTests: XCTestCase {
    func testFreshInstallIsSignedOut() async {
        let controller = SessionController(vault: MemoryVault(), authService: StubAuthService())
        await controller.restore()
        XCTAssertEqual(controller.state, .signedOut)
    }

    func testStoredSessionRotatesAndRestores() async throws {
        let old = session(token: "old")
        let fresh = session(token: "fresh")
        let vault = MemoryVault(old)
        let controller = SessionController(
            vault: vault,
            authService: StubAuthService(refreshed: fresh)
        )
        await controller.restore()
        XCTAssertEqual(controller.state, .signedIn(fresh))
        XCTAssertEqual(try vault.load(), fresh)
    }

    func testLoginPersistsExchangedSession() async throws {
        let fresh = session(token: "login")
        let vault = MemoryVault()
        let controller = SessionController(
            vault: vault,
            authService: StubAuthService(refreshed: fresh)
        )
        await controller.signIn(credential: "apple-identity-token")
        XCTAssertEqual(controller.state, .signedIn(fresh))
        XCTAssertEqual(try vault.load(), fresh)
    }

    func testRevokedSessionIsRemoved() async throws {
        let vault = MemoryVault(session(token: "revoked"))
        let controller = SessionController(
            vault: vault,
            authService: StubAuthService(error: .revoked)
        )
        await controller.restore()
        XCTAssertEqual(controller.state, .signedOut)
        XCTAssertNil(try vault.load())
    }

    func testLogoutAlwaysClearsLocalSession() async throws {
        let active = session(token: "active")
        let vault = MemoryVault(active)
        let controller = SessionController(vault: vault, authService: StubAuthService())
        await controller.accept(active)
        await controller.logout()
        XCTAssertEqual(controller.state, .signedOut)
        XCTAssertNil(try vault.load())
    }

    private func session(token: String) -> AuthSession {
        AuthSession(
            accessToken: "access-\(token)",
            accessTokenExpiresAt: Date().addingTimeInterval(300),
            refreshToken: "refresh-\(token)",
            refreshTokenExpiresAt: Date().addingTimeInterval(3_600)
        )
    }
}

private final class MemoryVault: SessionVault, @unchecked Sendable {
    private let lock = NSLock()
    private var session: AuthSession?

    init(_ session: AuthSession? = nil) { self.session = session }

    func load() throws -> AuthSession? { lock.withLock { session } }
    func save(_ session: AuthSession) throws { lock.withLock { self.session = session } }
    func delete() throws { lock.withLock { session = nil } }
}

private actor StubAuthService: AuthService {
    let refreshed: AuthSession?
    let error: AuthServiceError?

    init(refreshed: AuthSession? = nil, error: AuthServiceError? = nil) {
        self.refreshed = refreshed
        self.error = error
    }

    func exchange(credential: String) async throws -> AuthSession {
        if let error { throw error }
        guard let refreshed else { throw AuthServiceError.invalidResponse(500) }
        return refreshed
    }

    func refresh(using refreshToken: String) async throws -> AuthSession {
        if let error { throw error }
        guard let refreshed else { throw AuthServiceError.invalidResponse(500) }
        return refreshed
    }

    func logout(accessToken: String) async throws {}
}
