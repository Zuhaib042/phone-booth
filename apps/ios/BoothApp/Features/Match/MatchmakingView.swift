import SwiftUI

struct MatchmakingView: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(AppModel.self) private var app

  var body: some View {
    Group {
      switch app.matchmaking.state {
      case .idle:
        LoadingStateView(title: "Joining matchmaking")
      case .searching(let ticket):
        searching(ticket)
      case .ready(let ticket):
        ready(ticket)
      case .matched(let matchId):
        if let accessToken = app.session.accessToken {
          BoothView(model: app.liveMatch)
            .task {
              await app.liveMatch.start(
                matchId: matchId,
                accessToken: accessToken,
                realtimeURL: app.environment.realtimeURL
              )
            }
        } else {
          ErrorStateView(message: "Your session expired before booth entry.") {
            await app.restoreSession()
          }
        }
      case .cancelled:
        ContentUnavailableView {
          Label("Search cancelled", systemImage: "xmark.circle")
        } description: {
          Text("No match was joined and no coins moved.")
        } actions: {
          Button("Return to Booth") { dismiss() }
            .buttonStyle(BoothPrimaryButtonStyle())
        }
        .padding(BoothSpacing.large)
      case .failed(let message):
        ErrorStateView(message: message) { await app.matchmaking.start() }
      }
    }
    .navigationTitle("Matchmaking")
    .navigationBarTitleDisplayMode(.inline)
    .navigationBarBackButtonHidden(isCommittedToMatch)
    .task { if case .idle = app.matchmaking.state { await app.matchmaking.start() } }
    .task(id: pollTicketId) {
      while !Task.isCancelled, pollTicketId != nil {
        try? await Task.sleep(for: .seconds(1))
        await app.matchmaking.refresh()
      }
    }
  }

  private var pollTicketId: UUID? { app.matchmaking.currentTicket?.ticketId }

  private var isCommittedToMatch: Bool {
    if case .matched = app.matchmaking.state { true } else { false }
  }

  private func searching(_ ticket: MatchmakingTicket) -> some View {
    VStack(spacing: BoothSpacing.large) {
      Image(systemName: "phone.connection.fill")
        .font(.system(size: 56))
        .foregroundStyle(Color.boothAccent)
        .symbolEffect(.pulse)
        .accessibilityHidden(true)
      Text("Finding five contestants")
        .font(.title2.bold())
      Text("Language: \(ticket.language.uppercased()) · Region: \(ticket.region)")
        .font(.subheadline)
        .foregroundStyle(.secondary)
      ProgressView()
      Button("Cancel Search", role: .cancel) {
        Task { await app.matchmaking.cancel() }
      }
      .buttonStyle(.bordered)
      .accessibilityHint("Leaves matchmaking before a match is entered")
    }
    .padding(BoothSpacing.large)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private func ready(_ ticket: MatchmakingTicket) -> some View {
    VStack(spacing: BoothSpacing.large) {
      Image(
        systemName: ticket.readyConfirmed
          ? "checkmark.circle.fill" : "bell.and.waves.left.and.right.fill"
      )
      .font(.system(size: 56))
      .foregroundStyle(ticket.readyConfirmed ? .green : Color.boothAccent)
      .accessibilityHidden(true)
      Text(ticket.readyConfirmed ? "Ready confirmed" : "Your booth is ready")
        .font(.title2.bold())
      if let deadline = ticket.readyDeadline {
        ServerTimerView(deadline: deadline, label: "Confirm within")
      }
      Text(
        ticket.readyConfirmed
          ? "Waiting for the other contestants. Entry is automatic when everyone confirms."
          : "Confirm now. If the roster times out, you will return safely to matchmaking."
      )
      .multilineTextAlignment(.center)
      .foregroundStyle(.secondary)
      if !ticket.readyConfirmed {
        Button("I'm Ready") { Task { await app.matchmaking.confirmReady() } }
          .buttonStyle(BoothPrimaryButtonStyle())
          .accessibilityIdentifier("matchmaking.ready")
      }
      Button("Cancel", role: .cancel) { Task { await app.matchmaking.cancel() } }
        .buttonStyle(.bordered)
    }
    .padding(BoothSpacing.large)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

struct ServerTimerView: View {
  let deadline: Date
  var label = "Time remaining"

  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { context in
      let seconds = ServerCountdown.secondsRemaining(deadline: deadline, now: context.date)
      VStack(spacing: 2) {
        Text(label)
          .font(.caption)
          .foregroundStyle(.secondary)
        Text(Duration.seconds(seconds), format: .time(pattern: .minuteSecond))
          .font(.title2.bold().monospacedDigit())
          .contentTransition(.numericText())
          .accessibilityLabel("\(label), \(seconds) seconds")
      }
    }
  }
}

enum ServerCountdown {
  static func secondsRemaining(deadline: Date, now: Date) -> Int {
    max(0, Int(deadline.timeIntervalSince(now).rounded(.up)))
  }
}
