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

    func loadHome() async throws -> HomeProjection {
        async let account = currentAccount()
        async let wallet = coinWallet()
        let (accountValue, walletValue) = try await (account, wallet)
        guard let configuredMatchOutflowCap = walletValue.configuredMatchOutflowCap else {
            throw APIClientError.invalidPayload
        }
        return HomeProjection(
            avatarKey: accountValue.profile.avatarKey,
            configuredMatchOutflowCap: configuredMatchOutflowCap,
            displayName: accountValue.profile.displayName,
            progressionLevel: accountValue.profile.progressionLevel,
            restricted: walletValue.restricted,
            spendableBalance: walletValue.spendable
        )
    }

    private func currentAccount() async throws -> Components.Schemas.Account {
        switch try await client.getCurrentAccount() {
        case .ok(let response): try response.body.json
        case .unauthorized: throw APIClientError.unexpectedStatus(401)
        case .notFound: throw APIClientError.unexpectedStatus(404)
        case .serviceUnavailable: throw APIClientError.unexpectedStatus(503)
        case .undocumented(let statusCode, _): throw APIClientError.unexpectedStatus(statusCode)
        }
    }

    private func coinWallet() async throws -> Components.Schemas.CoinWallet {
        switch try await client.getCoinWallet() {
        case .ok(let response): try response.body.json
        case .unauthorized: throw APIClientError.unexpectedStatus(401)
        case .forbidden: throw APIClientError.unexpectedStatus(403)
        case .notFound: throw APIClientError.unexpectedStatus(404)
        case .serviceUnavailable: throw APIClientError.unexpectedStatus(503)
        case .undocumented(let statusCode, _): throw APIClientError.unexpectedStatus(statusCode)
        }
    }
}

enum APIClientError: Error, Equatable {
    case invalidPayload
    case unexpectedStatus(Int)
}

extension BoothAPIClient: HomeDataLoading {}
