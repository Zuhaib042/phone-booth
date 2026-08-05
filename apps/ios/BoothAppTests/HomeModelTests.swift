import XCTest
@testable import BoothApp

@MainActor
final class HomeModelTests: XCTestCase {
    func testLoadPublishesTheServerProjectionWithoutCombiningCoinLimits() async {
        let expected = HomeProjection(
            avatarKey: "fox",
            configuredMatchOutflowCap: 600,
            displayName: "Quiet Fox",
            progressionLevel: 7,
            restricted: false,
            spendableBalance: 1_250
        )
        let model = HomeModel(loader: StubHomeLoader(result: .success(expected)))

        await model.load()

        XCTAssertEqual(model.state, .loaded(expected))
        XCTAssertNotEqual(expected.spendableBalance, expected.configuredMatchOutflowCap)
    }

    func testLoadFailureOffersARecoverableState() async {
        let model = HomeModel(loader: StubHomeLoader(result: .failure(.offline)))

        await model.load()

        XCTAssertEqual(
            model.state,
            .failed("Your booth could not be loaded. Check your connection and try again.")
        )
    }

    func testResetClearsThePreviousAccountProjection() async {
        let projection = HomeProjection(
            avatarKey: "fox",
            configuredMatchOutflowCap: 600,
            displayName: "Quiet Fox",
            progressionLevel: 7,
            restricted: false,
            spendableBalance: 1_250
        )
        let model = HomeModel(loader: StubHomeLoader(result: .success(projection)))
        await model.load()

        model.reset()

        XCTAssertEqual(model.state, .idle)
    }
}

private struct StubHomeLoader: HomeDataLoading {
    let result: Result<HomeProjection, StubHomeError>

    func loadHome() async throws -> HomeProjection {
        try result.get()
    }
}

private enum StubHomeError: Error {
    case offline
}
