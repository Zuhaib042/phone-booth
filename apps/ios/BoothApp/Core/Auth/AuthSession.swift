import Foundation

struct AuthSession: Codable, Equatable, Sendable {
    let accessToken: String
    let accessTokenExpiresAt: Date
    let refreshToken: String
    let refreshTokenExpiresAt: Date

    var isRefreshExpired: Bool {
        refreshTokenExpiresAt <= Date()
    }
}

protocol SessionVault: Sendable {
    func load() throws -> AuthSession?
    func save(_ session: AuthSession) throws
    func delete() throws
}
