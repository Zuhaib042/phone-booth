import XCTest

final class MatchmakingUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  func testCancellationLeavesSearchWithoutEnteringMatch() {
    let app = launch("searching")
    app.buttons["Cancel Search"].tap()
    XCTAssertTrue(app.staticTexts["Search cancelled"].waitForExistence(timeout: 1))
    XCTAssertTrue(app.staticTexts["No match was joined and no coins moved."].exists)
  }

  func testReadyConfirmationShowsDurableAcknowledgement() {
    let app = launch("ready")
    XCTAssertTrue(app.staticTexts["Your booth is ready"].exists)
    app.buttons["matchmaking.ready"].tap()
    XCTAssertTrue(app.staticTexts["Ready confirmed"].waitForExistence(timeout: 1))
  }

  func testExpiredReadyWindowDoesNotEnterBooth() {
    let app = launch("timeout")
    XCTAssertTrue(
      app.staticTexts["The ready window expired. Refreshing matchmaking safely."].exists)
    XCTAssertFalse(app.staticTexts["The Booth"].exists)
  }

  func testMatchedRosterEntersBoothAndShowsRedPhone() {
    let app = launch("matched")
    XCTAssertTrue(app.staticTexts["The Booth"].exists)
    XCTAssertTrue(app.staticTexts["Negotiation"].exists)
    XCTAssertTrue(app.buttons["booth.red-phone"].exists)
  }

  private func launch(_ scenario: String) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["BOOTH_UI_TEST_MATCHMAKING"] = scenario
    app.launch()
    return app
  }
}
