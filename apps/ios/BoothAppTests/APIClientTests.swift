import XCTest
@testable import BoothApp

final class APIClientTests: XCTestCase {
    func testGeneratedClientCallsHealthEndpoint() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HealthURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let client = BoothAPIClient(
            baseURL: URL(string: "https://booth.test")!,
            tokenProvider: AccessTokenProvider(),
            session: session
        )

        let live = try await client.isLive()
        XCTAssertTrue(live)
        XCTAssertEqual(HealthURLProtocol.lastPath, "/health/live")
    }

    func testHomeKeepsWalletBalanceSeparateFromConfiguredMatchAllowance() async throws {
        HomeURLProtocol.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HomeURLProtocol.self]
        let tokenProvider = AccessTokenProvider()
        await tokenProvider.update("access-home")
        let client = BoothAPIClient(
            baseURL: URL(string: "https://booth.test")!,
            tokenProvider: tokenProvider,
            session: URLSession(configuration: configuration)
        )

        let home = try await client.loadHome()

        XCTAssertEqual(home.displayName, "Quiet Fox")
        XCTAssertEqual(home.progressionLevel, 7)
        XCTAssertEqual(home.spendableBalance, 1_250)
        XCTAssertEqual(home.configuredMatchOutflowCap, 600)
        XCTAssertEqual(HomeURLProtocol.requestedPaths, ["/v1/account", "/v1/economy/wallet"])
        XCTAssertEqual(HomeURLProtocol.authorizationValues, ["Bearer access-home"])
    }
}

private final class HealthURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var recordedPath: String?

    static var lastPath: String? { lock.withLock { recordedPath } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.withLock { Self.recordedPath = request.url?.path }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"status":"ok"}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class HomeURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var paths: Set<String> = []
    nonisolated(unsafe) private static var authorizations: Set<String> = []

    static var requestedPaths: Set<String> { lock.withLock { paths } }
    static var authorizationValues: Set<String> { lock.withLock { authorizations } }

    static func reset() {
        lock.withLock {
            paths.removeAll()
            authorizations.removeAll()
        }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let path = request.url?.path ?? ""
        Self.lock.withLock {
            Self.paths.insert(path)
            if let authorization = request.value(forHTTPHeaderField: "Authorization") {
                Self.authorizations.insert(authorization)
            }
        }

        let body: String
        switch path {
        case "/v1/account":
            body = #"{"userId":"4f873f4c-2c20-44f6-b1ce-8ce4dbf6ec93","status":"active","deletionStatus":"none","profile":{"userId":"4f873f4c-2c20-44f6-b1ce-8ce4dbf6ec93","displayName":"Quiet Fox","avatarKey":"fox","progressionLevel":7}}"#
        case "/v1/economy/wallet":
            body = #"{"configuredMatchOutflowCap":600,"pending":0,"reserved":0,"restricted":false,"spendable":1250}"#
        default:
            body = #"{"error":{"code":"not_found","message":"Not found","traceId":"test"}}"#
        }

        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: path.isEmpty ? 404 : 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
