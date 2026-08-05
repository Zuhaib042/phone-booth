import BoothAPI
import Foundation
import OpenAPIURLSession

actor BoothAPIClient {
    private let client: Client

    init(
        baseURL: URL,
        tokenProvider: AccessTokenProvider,
        session: URLSession = .shared
    ) {
        client = Client(
            serverURL: baseURL,
            transport: URLSessionTransport(configuration: .init(session: session)),
            middlewares: [BearerAuthMiddleware(tokenProvider: tokenProvider)]
        )
    }

    func isLive() async throws -> Bool {
        switch try await client.getLiveHealth() {
        case .ok:
            true
        case .undocumented(let statusCode, _):
            throw APIClientError.unexpectedStatus(statusCode)
        }
    }
}

enum APIClientError: Error, Equatable {
    case unexpectedStatus(Int)
}
