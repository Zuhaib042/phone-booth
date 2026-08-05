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
