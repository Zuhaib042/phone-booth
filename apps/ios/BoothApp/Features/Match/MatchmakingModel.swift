import Foundation
import Observation

@MainActor
@Observable
final class MatchmakingModel {
  enum State: Equatable {
    case idle
    case searching(MatchmakingTicket)
    case ready(MatchmakingTicket)
    case matched(UUID)
    case cancelled
    case failed(String)
  }

  private(set) var state: State = .idle
  private let api: any MatchExperienceAPI
  private var requestInFlight = false

  init(api: any MatchExperienceAPI) {
    self.api = api
  }

  func start() async {
    guard !requestInFlight else { return }
    requestInFlight = true
    defer { requestInFlight = false }
    do {
      apply(try await api.createMatchmakingTicket())
    } catch {
      state = .failed(
        message(for: error, fallback: "Matchmaking could not start. Please try again."))
    }
  }

  func refresh() async {
    guard !requestInFlight, let ticket = currentTicket else { return }
    requestInFlight = true
    defer { requestInFlight = false }
    do {
      apply(try await api.matchmakingTicket(ticket.ticketId))
    } catch {
      state = .failed(message(for: error, fallback: "The match status could not be refreshed."))
    }
  }

  func confirmReady() async {
    guard !requestInFlight, let ticket = currentTicket else { return }
    requestInFlight = true
    defer { requestInFlight = false }
    do {
      apply(try await api.confirmMatchmakingReady(ticket.ticketId))
    } catch {
      state = .failed(
        message(for: error, fallback: "Readiness could not be confirmed. You can try again."))
    }
  }

  func cancel() async {
    guard !requestInFlight, let ticket = currentTicket else {
      state = .cancelled
      return
    }
    requestInFlight = true
    defer { requestInFlight = false }
    do {
      apply(try await api.cancelMatchmakingTicket(ticket.ticketId))
    } catch {
      state = .failed(
        message(
          for: error, fallback: "Cancellation could not be confirmed. Check the match status."))
    }
  }

  func reset() {
    state = .idle
    requestInFlight = false
  }

  var currentTicket: MatchmakingTicket? {
    switch state {
    case .searching(let ticket), .ready(let ticket): ticket
    default: nil
    }
  }

  private func apply(_ ticket: MatchmakingTicket) {
    switch ticket.status {
    case "queued": state = .searching(ticket)
    case "proposed": state = .ready(ticket)
    case "matched":
      guard let matchId = ticket.matchId else {
        state = .failed("The match was created without an identifier. Refresh to recover.")
        return
      }
      state = .matched(matchId)
    case "cancelled": state = .cancelled
    default: state = .failed("The server returned an unknown matchmaking state.")
    }
  }

  private func message(for error: Error, fallback: String) -> String {
    (error as? APIClientError)?.userMessage ?? fallback
  }
}
