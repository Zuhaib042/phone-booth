import Foundation

protocol AuthService: Sendable {
    func exchange(credential: String) async throws -> AuthSession
    func refresh(using refreshToken: String) async throws -> AuthSession
    func logout(accessToken: String) async throws
}

enum AuthServiceError: Error, Equatable {
    case revoked
    case invalidResponse(Int)
}

actor URLSessionAuthService: AuthService {
    private let baseURL: URL
    private let session: URLSession
    private let decoder: JSONDecoder
    private let installationId: UUID

    init(
        baseURL: URL,
        session: URLSession = .shared,
        installationId: UUID = InstallationIdentity.current()
    ) {
        self.baseURL = baseURL
        self.session = session
        self.installationId = installationId
        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
    }

    func exchange(credential: String) async throws -> AuthSession {
        var request = URLRequest(url: baseURL.appending(path: "/v1/auth/exchange"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(
            ExchangeRequest(
                credential: credential,
                device: .init(
                    installationId: installationId,
                    platform: "ios",
                    appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
                )
            )
        )
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 201 else { throw AuthServiceError.invalidResponse(status) }
        return try decoder.decode(ExchangeResponse.self, from: data).tokens
    }

    func refresh(using refreshToken: String) async throws -> AuthSession {
        var request = URLRequest(url: baseURL.appending(path: "/v1/auth/refresh"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(RefreshRequest(refreshToken: refreshToken))
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 { throw AuthServiceError.revoked }
        guard status == 200 else { throw AuthServiceError.invalidResponse(status) }
        return try decoder.decode(AuthSession.self, from: data)
    }

    func logout(accessToken: String) async throws {
        var request = URLRequest(url: baseURL.appending(path: "/v1/auth/logout"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        let (_, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 204 || status == 401 else {
            throw AuthServiceError.invalidResponse(status)
        }
    }
}

private struct RefreshRequest: Encodable {
    let refreshToken: String
}

private struct ExchangeRequest: Encodable {
    struct Device: Encodable {
        let installationId: UUID
        let platform: String
        let appVersion: String?
    }

    let credential: String
    let device: Device
}

private struct ExchangeResponse: Decodable {
    let tokens: AuthSession
}

enum InstallationIdentity {
    private static let key = "project-booth-installation-id"

    static func current(defaults: UserDefaults = .standard) -> UUID {
        if let value = defaults.string(forKey: key), let id = UUID(uuidString: value) {
            return id
        }
        let id = UUID()
        defaults.set(id.uuidString, forKey: key)
        return id
    }
}
