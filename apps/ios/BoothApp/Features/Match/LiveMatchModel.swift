import Foundation
import Observation

@MainActor
@Observable
final class LiveMatchModel {
  enum State: Equatable {
    case idle
    case loading
    case active(UUID)
    case failed(String)
  }

  private(set) var state: State = .idle
  private(set) var wallet: CoinWalletProjection?
  private(set) var threads: [ChatThreadProjection] = []
  private(set) var offers: [BribeOfferProjection] = []
  private(set) var dossier: MatchDossier?
  private(set) var notice: String?
  private(set) var commandInFlight = false

  let api: any MatchExperienceAPI
  let store: MatchStore
  private let realtime: MatchRealtimeCoordinator
  private var activeMatchId: UUID?

  init(api: any MatchExperienceAPI, store: MatchStore, realtime: MatchRealtimeCoordinator) {
    self.api = api
    self.store = store
    self.realtime = realtime
  }

  func start(matchId: UUID, accessToken: String, realtimeURL: URL) async {
    if activeMatchId == matchId, case .active = state { return }
    state = .loading
    activeMatchId = matchId
    do {
      _ = try await api.confirmBoothReady(matchId)
      store.apply(snapshot: try await api.matchSnapshot(matchId))
      try await realtime.connect(url: realtimeURL, matchId: matchId, accessToken: accessToken)
      state = .active(matchId)
      await refreshPrivateState()
    } catch {
      state = .failed(
        message(for: error, fallback: "The booth could not be entered. Please reconnect."))
    }
  }

  func reconnect(accessToken: String, realtimeURL: URL) async {
    guard let matchId = activeMatchId else { return }
    await start(matchId: matchId, accessToken: accessToken, realtimeURL: realtimeURL)
  }

  func refresh() async {
    guard let matchId = activeMatchId else { return }
    do {
      store.apply(snapshot: try await api.matchSnapshot(matchId))
      await refreshPrivateState()
    } catch {
      notice = message(for: error, fallback: "Live state could not be refreshed.")
    }
  }

  func refreshPrivateState() async {
    guard let matchId = activeMatchId else { return }
    async let walletValue = api.matchWallet(matchId)
    async let offerValue = api.bribeOffers(matchId)
    do { wallet = try await walletValue } catch {
      notice = "Wallet information is temporarily unavailable."
    }
    do { offers = try await offerValue } catch {
      notice = "Offer information is temporarily unavailable."
    }
    if store.projection?.phase == "negotiation" || store.projection?.phase == "runoff_negotiation" {
      do { threads = try await api.chatThreads(matchId) } catch {
        notice = "Private threads are temporarily unavailable."
      }
    } else {
      threads = []
    }
    if store.projection?.phase == "complete" {
      await loadDossier()
    }
  }

  func submitVote(for userId: UUID, runoff: Bool) async {
    guard let matchId = activeMatchId else { return }
    await command(success: "Your secret ballot is saved. You may revise it before the deadline.") {
      if runoff {
        _ = try await api.submitRunoffBallot(matchId: matchId, targetUserId: userId)
      } else {
        _ = try await api.submitBallot(matchId: matchId, targetUserId: userId)
      }
    }
  }

  func submitFinalPlea(_ text: String) async {
    guard let matchId = activeMatchId else { return }
    await command(success: "Your final plea is saved.") {
      _ = try await api.submitFinalPlea(matchId: matchId, text: text)
    }
  }

  func submitJuryVote(for userId: UUID) async {
    guard let matchId = activeMatchId else { return }
    await command(success: "Your jury vote is saved. You may revise it before the deadline.") {
      _ = try await api.submitJuryBallot(matchId: matchId, finalistUserId: userId)
    }
  }

  func createOffer(recipient: UUID, target: UUID, amount: Int, message: String?) async {
    guard let matchId = activeMatchId else { return }
    await command(success: "Offer sent. The recipient is never bound to vote as promised.") {
      _ = try await api.createBribeOffer(
        matchId: matchId,
        recipientUserId: recipient,
        targetUserId: target,
        amount: amount,
        message: message
      )
    }
  }

  func acceptOffer(_ offerId: UUID) async {
    await command(success: "Offer accepted. Cast any valid ballot to settle the pending coins.") {
      _ = try await api.acceptBribeOffer(offerId)
    }
  }

  func declineOffer(_ offerId: UUID) async {
    await command(success: "Offer declined.") { _ = try await api.declineBribeOffer(offerId) }
  }

  func loadDossier() async {
    guard let matchId = activeMatchId else { return }
    do { dossier = try await api.dossier(matchId) } catch {
      notice = message(for: error, fallback: "The dossier is still being prepared.")
    }
  }

  func clearNotice() { notice = nil }

  func stop() async {
    await realtime.disconnect()
    activeMatchId = nil
    state = .idle
    wallet = nil
    threads = []
    offers = []
    dossier = nil
    notice = nil
  }

  private func command(success: String, action: () async throws -> Void) async {
    guard !commandInFlight else { return }
    commandInFlight = true
    defer { commandInFlight = false }
    do {
      try await action()
      notice = success
      await refresh()
    } catch {
      notice = message(
        for: error, fallback: "That action could not be completed. Please try again.")
    }
  }

  private func message(for error: Error, fallback: String) -> String {
    (error as? APIClientError)?.userMessage ?? fallback
  }
}
