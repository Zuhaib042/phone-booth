import XCTest

@testable import BoothApp

@MainActor
final class MatchExperienceTests: XCTestCase {
  func testMatchmakingCoversSearchReadyAndMatchEntry() async {
    let matchId = UUID()
    let api = StubMatchAPI(tickets: [
      ticket(status: "queued"),
      ticket(status: "proposed"),
      ticket(status: "matched", matchId: matchId),
    ])
    let model = MatchmakingModel(api: api)

    await model.start()
    guard case .searching = model.state else { return XCTFail("Expected search state") }
    await model.refresh()
    guard case .ready = model.state else { return XCTFail("Expected ready state") }
    await model.confirmReady()
    XCTAssertEqual(model.state, .matched(matchId))
  }

  func testMatchmakingCancellationIsTerminalAndSafe() async {
    let api = StubMatchAPI(tickets: [ticket(status: "queued"), ticket(status: "cancelled")])
    let model = MatchmakingModel(api: api)
    await model.start()

    await model.cancel()

    XCTAssertEqual(model.state, .cancelled)
  }

  func testServerCountdownUsesAbsoluteDeadlineAcrossBackgroundGap() {
    let start = Date(timeIntervalSince1970: 1_000)
    let deadline = start.addingTimeInterval(90)

    XCTAssertEqual(ServerCountdown.secondsRemaining(deadline: deadline, now: start), 90)
    XCTAssertEqual(
      ServerCountdown.secondsRemaining(deadline: deadline, now: start.addingTimeInterval(75)),
      15
    )
    XCTAssertEqual(
      ServerCountdown.secondsRemaining(deadline: deadline, now: start.addingTimeInterval(120)),
      0
    )
  }

  func testLegacySnapshotDefaultsNewPrivateFieldsWithoutLeakingOtherBallots() throws {
    let matchId = UUID()
    let userId = UUID()
    let rulesetId = UUID()
    let data = Data(
      """
      {
        "lastRecipientCursor": 2,
        "matchId": "\(matchId)",
        "matchVersion": 3,
        "phase": "voting",
        "phaseDeadline": null,
        "roster": [{
          "avatarKey": "fox",
          "displayName": "Quiet Fox",
          "ready": true,
          "status": "active",
          "userId": "\(userId)"
        }],
        "ruleset": {"rulesetId": "\(rulesetId)", "rulesetVersion": 1},
        "self": {"ready": true, "userId": "\(userId)"}
      }
      """.utf8
    )

    let snapshot = try JSONDecoder().decode(MatchSnapshot.self, from: data)

    XCTAssertNil(snapshot.selfProjection.normalBallot)
    XCTAssertNil(snapshot.selfProjection.runoffBallot)
    XCTAssertNil(snapshot.selfProjection.juryBallot)
    XCTAssertTrue(snapshot.runoffUserIds.isEmpty)
    XCTAssertTrue(snapshot.finalPleas.isEmpty)
  }

  private func ticket(status: String, matchId: UUID? = nil) -> MatchmakingTicket {
    MatchmakingTicket(
      compatibilityVersion: 1,
      createdAt: Date(),
      language: "en",
      matchId: matchId,
      proposalId: status == "proposed" ? UUID() : nil,
      readyConfirmed: false,
      readyDeadline: status == "proposed" ? Date().addingTimeInterval(15) : nil,
      region: "global",
      rulesetId: UUID(),
      rulesetVersion: 1,
      status: status,
      ticketId: UUID(),
      updatedAt: Date()
    )
  }
}

private actor StubMatchAPI: MatchExperienceAPI {
  enum Failure: Error { case unused }
  private var tickets: [MatchmakingTicket]

  init(tickets: [MatchmakingTicket]) { self.tickets = tickets }

  private func nextTicket() throws -> MatchmakingTicket {
    guard !tickets.isEmpty else { throw Failure.unused }
    return tickets.removeFirst()
  }

  func createMatchmakingTicket() async throws -> MatchmakingTicket { try nextTicket() }
  func matchmakingTicket(_: UUID) async throws -> MatchmakingTicket { try nextTicket() }
  func cancelMatchmakingTicket(_: UUID) async throws -> MatchmakingTicket { try nextTicket() }
  func confirmMatchmakingReady(_: UUID) async throws -> MatchmakingTicket { try nextTicket() }
  func confirmBoothReady(_: UUID) async throws -> MatchReadyProjection { throw Failure.unused }
  func matchSnapshot(_: UUID) async throws -> MatchSnapshot { throw Failure.unused }
  func matchWallet(_: UUID) async throws -> CoinWalletProjection { throw Failure.unused }
  func quickPhrases() async throws -> [QuickPhrase] { throw Failure.unused }
  func chatThreads(_: UUID) async throws -> [ChatThreadProjection] { throw Failure.unused }
  func chatMessages(matchId _: UUID, threadId _: UUID) async throws -> [ChatMessageProjection] {
    throw Failure.unused
  }
  func sendChatMessage(matchId _: UUID, threadId _: UUID, text _: String) async throws
    -> ChatMessageAttempt
  { throw Failure.unused }
  func sendQuickPhrase(matchId _: UUID, threadId _: UUID, key _: String) async throws
    -> ChatMessageAttempt
  { throw Failure.unused }
  func muteUser(matchId _: UUID, userId _: UUID) async throws { throw Failure.unused }
  func blockUser(matchId _: UUID, userId _: UUID) async throws { throw Failure.unused }
  func reportUser(matchId _: UUID, userId _: UUID, category _: String) async throws {
    throw Failure.unused
  }
  func reportMessage(matchId _: UUID, messageId _: UUID, category _: String) async throws {
    throw Failure.unused
  }
  func bribeOffers(_: UUID) async throws -> [BribeOfferProjection] { throw Failure.unused }
  func createBribeOffer(
    matchId _: UUID,
    recipientUserId _: UUID,
    targetUserId _: UUID,
    amount _: Int,
    message _: String?
  ) async throws -> BribeOfferProjection { throw Failure.unused }
  func acceptBribeOffer(_: UUID) async throws -> BribeOfferProjection { throw Failure.unused }
  func declineBribeOffer(_: UUID) async throws -> BribeOfferProjection { throw Failure.unused }
  func submitBallot(matchId _: UUID, targetUserId _: UUID) async throws -> BallotAcknowledgement {
    throw Failure.unused
  }
  func submitRunoffBallot(matchId _: UUID, targetUserId _: UUID) async throws
    -> BallotAcknowledgement
  { throw Failure.unused }
  func submitFinalPlea(matchId _: UUID, text _: String) async throws -> FinalPleaAcknowledgement {
    throw Failure.unused
  }
  func submitJuryBallot(matchId _: UUID, finalistUserId _: UUID) async throws
    -> BallotAcknowledgement
  { throw Failure.unused }
  func dossier(_: UUID) async throws -> MatchDossier { throw Failure.unused }
}
