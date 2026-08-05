import XCTest
@testable import BoothApp

final class RealtimeContractTests: XCTestCase {
    func testResumeMessageCarriesLastAppliedCursor() throws {
        let data = try JSONEncoder().encode(ConnectionResume(afterCursor: 42))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["schemaVersion"] as? Int, 1)
        XCTAssertEqual(object["type"] as? String, "connection.resume")
        XCTAssertEqual(object["afterCursor"] as? Int, 42)
    }
}
