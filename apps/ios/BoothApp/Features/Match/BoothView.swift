import SwiftUI

struct BoothView: View {
  @Environment(\.scenePhase) private var scenePhase
  let model: LiveMatchModel
  @State private var showsPhone = false
  @State private var showsOfferComposer = false

  var body: some View {
    Group {
      switch model.state {
      case .idle, .loading:
        LoadingStateView(title: "Entering your booth")
      case .failed(let message):
        ErrorStateView(message: message) { await model.refresh() }
      case .active:
        if let projection = model.store.projection {
          matchContent(projection)
        } else {
          LoadingStateView(title: "Synchronizing the match")
        }
      }
    }
    .navigationBarBackButtonHidden(true)
    .navigationTitle("The Booth")
    .navigationBarTitleDisplayMode(.inline)
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { Task { await model.refresh() } }
    }
    .alert(
      "Match update",
      isPresented: Binding(
        get: { model.notice != nil },
        set: { if !$0 { model.clearNotice() } }
      )
    ) {
      Button("OK") { model.clearNotice() }
    } message: {
      Text(model.notice ?? "")
    }
  }

  private func matchContent(_ projection: MatchProjection) -> some View {
    ScrollView {
      VStack(spacing: BoothSpacing.medium) {
        PhaseHeader(projection: projection)
        CoinStrip(wallet: model.wallet)
        phaseView(projection)
        RosterCard(projection: projection)
      }
      .padding(BoothSpacing.medium)
    }
    .background(Color.boothBackground)
    .safeAreaInset(edge: .bottom) {
      if canUsePhone(projection) {
        phoneBar(projection)
      }
    }
    .sheet(isPresented: $showsPhone) {
      NavigationStack {
        ThreadListView(model: model, projection: projection)
      }
    }
    .sheet(isPresented: $showsOfferComposer) {
      NavigationStack {
        BribeComposerView(model: model, projection: projection)
      }
    }
  }

  @ViewBuilder
  private func phaseView(_ projection: MatchProjection) -> some View {
    switch projection.phase {
    case "lobby":
      BoothStatusCard(
        title: "Waiting at the door",
        detail: "Contestants are entering. The server will begin when the booth is ready.",
        systemImage: "door.left.hand.open"
      )
    case "negotiation":
      BoothStatusCard(
        title: "Make your case",
        detail:
          "Use the red phone for private conversations. Formal offers are non-binding promises.",
        systemImage: "bubble.left.and.bubble.right.fill"
      )
      OfferDeck(model: model, projection: projection)
    case "voting":
      SecretVoteView(model: model, projection: projection, runoff: false)
    case "tally":
      BoothStatusCard(
        title: "Votes are locked",
        detail: "The server is tallying private ballots. Individual choices remain hidden.",
        systemImage: "lock.fill"
      )
    case "runoff_negotiation":
      BoothStatusCard(
        title: "Runoff",
        detail:
          "A tie forced a short final negotiation. Only eligible non-tied contestants will vote.",
        systemImage: "arrow.triangle.2.circlepath"
      )
    case "runoff_voting":
      SecretVoteView(model: model, projection: projection, runoff: true)
    case "elimination":
      EliminationView(projection: projection)
    case "final_plea":
      FinalPleaView(model: model, projection: projection)
    case "jury_voting":
      JuryView(model: model, projection: projection)
    case "complete":
      DossierView(model: model, projection: projection)
    case "cancelled":
      BoothStatusCard(
        title: "Match cancelled",
        detail: "No result was recorded. Any affected coin movement is reversed by the server.",
        systemImage: "exclamationmark.arrow.triangle.2.circlepath"
      )
    default:
      BoothStatusCard(
        title: "Synchronizing phase",
        detail: "The booth is waiting for an authoritative server update.",
        systemImage: "arrow.clockwise"
      )
    }
  }

  private func canUsePhone(_ projection: MatchProjection) -> Bool {
    projection.selfProjection.userId
      == projection.roster.first(where: {
        $0.userId == projection.selfProjection.userId && $0.status == "active"
      })?.userId
      && ["negotiation", "runoff_negotiation"].contains(projection.phase)
  }

  private func phoneBar(_ projection: MatchProjection) -> some View {
    HStack(spacing: BoothSpacing.small) {
      Button {
        showsPhone = true
      } label: {
        Label("Red Phone", systemImage: "phone.fill")
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(BoothPrimaryButtonStyle())
      .accessibilityIdentifier("booth.red-phone")

      if projection.phase == "negotiation" {
        Button {
          showsOfferComposer = true
        } label: {
          Image(systemName: "handshake.fill")
            .frame(width: 50, height: 50)
        }
        .buttonStyle(.borderedProminent)
        .tint(.orange)
        .accessibilityLabel("Compose a Booth Coin offer")
      }
    }
    .padding(.horizontal, BoothSpacing.medium)
    .padding(.vertical, BoothSpacing.small)
    .background(.bar)
  }
}

private struct PhaseHeader: View {
  let projection: MatchProjection

  var body: some View {
    HStack {
      VStack(alignment: .leading, spacing: 2) {
        Text("ROUND \(projection.roundNumber)")
          .font(.caption.bold())
          .foregroundStyle(.secondary)
        Text(label)
          .font(.title2.bold())
      }
      Spacer()
      if let deadline = projection.phaseDeadline {
        ServerTimerView(deadline: deadline)
      } else {
        Image(systemName: "infinity")
          .font(.title2.bold())
          .accessibilityLabel("No active deadline")
      }
    }
    .padding(BoothSpacing.medium)
    .background(Color.boothSurface, in: .rect(cornerRadius: 16))
  }

  private var label: String {
    projection.phase.replacingOccurrences(of: "_", with: " ").capitalized
  }
}

private struct CoinStrip: View {
  let wallet: CoinWalletProjection?

  var body: some View {
    HStack {
      Label("Wallet", systemImage: "wallet.bifold.fill")
      Spacer()
      Text(wallet?.spendable ?? 0, format: .number).fontWeight(.semibold)
      Divider().frame(height: 24)
      Text("Allowance")
      Text(wallet?.matchAllowance?.remaining ?? 0, format: .number).fontWeight(.semibold)
    }
    .font(.subheadline)
    .padding(BoothSpacing.medium)
    .background(Color.boothSurface, in: .rect(cornerRadius: 14))
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      "Wallet \(wallet?.spendable ?? 0) coins. Remaining match allowance \(wallet?.matchAllowance?.remaining ?? 0) coins."
    )
  }
}

struct BoothStatusCard: View {
  let title: String
  let detail: String
  let systemImage: String

  var body: some View {
    VStack(spacing: BoothSpacing.small) {
      Image(systemName: systemImage)
        .font(.largeTitle)
        .foregroundStyle(Color.boothAccent)
      Text(title).font(.headline)
      Text(detail)
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
    }
    .padding(BoothSpacing.large)
    .frame(maxWidth: .infinity)
    .background(Color.boothSurface, in: .rect(cornerRadius: 16))
    .accessibilityElement(children: .combine)
  }
}

private struct RosterCard: View {
  let projection: MatchProjection

  var body: some View {
    VStack(alignment: .leading, spacing: BoothSpacing.small) {
      Text("Contestants").font(.headline)
      ForEach(projection.roster) { player in
        HStack {
          Image(
            systemName: player.status == "active"
              ? "person.crop.circle.fill" : "person.crop.circle.badge.xmark"
          )
          .foregroundStyle(player.status == "active" ? Color.boothAccent : .secondary)
          Text(player.displayName)
          if player.userId == projection.selfProjection.userId {
            Text("YOU").font(.caption2.bold()).foregroundStyle(.secondary)
          }
          Spacer()
          Text(player.status.capitalized)
            .font(.caption)
            .foregroundStyle(player.status == "active" ? .green : .secondary)
        }
        if player.id != projection.roster.last?.id { Divider() }
      }
    }
    .padding(BoothSpacing.medium)
    .background(Color.boothSurface, in: .rect(cornerRadius: 16))
  }
}

private struct EliminationView: View {
  let projection: MatchProjection

  var body: some View {
    let eliminated = projection.roster.filter { $0.status == "eliminated" }
    let selfEliminated = eliminated.contains { $0.userId == projection.selfProjection.userId }
    BoothStatusCard(
      title: selfEliminated ? "You were eliminated" : "A contestant was eliminated",
      detail: selfEliminated
        ? "Stay in the booth. You are now a juror and will help choose the winner before seeing the dossier."
        : "Ballots remain secret until the match dossier. The next round starts on the server deadline.",
      systemImage: selfEliminated ? "person.crop.circle.badge.xmark" : "hand.raised.fill"
    )
  }
}
