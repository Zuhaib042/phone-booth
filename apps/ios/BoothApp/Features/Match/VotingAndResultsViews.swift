import SwiftUI

struct SecretVoteView: View {
  let model: LiveMatchModel
  let projection: MatchProjection
  let runoff: Bool
  @State private var selectedUserId: UUID?
  @State private var confirmsVote = false

  var body: some View {
    VStack(alignment: .leading, spacing: BoothSpacing.medium) {
      Label(
        runoff ? "Secret runoff vote" : "Secret elimination vote",
        systemImage: "checkmark.shield.fill"
      )
      .font(.title3.bold())
      Text(
        "Only your final selection is saved. Other contestants never receive your ballot before the dossier."
      )
      .font(.subheadline)
      .foregroundStyle(.secondary)

      if runoff && projection.runoffUserIds.contains(projection.selfProjection.userId) {
        Label(
          "You are tied and cannot vote in this runoff.", systemImage: "person.fill.questionmark"
        )
        .foregroundStyle(.orange)
      } else {
        ForEach(candidates) { player in
          Button {
            selectedUserId = player.userId
          } label: {
            HStack {
              Image(
                systemName: selectedUserId == player.userId ? "checkmark.circle.fill" : "circle")
              Text(player.displayName)
              Spacer()
            }
          }
          .buttonStyle(.plain)
          .padding(BoothSpacing.medium)
          .background(Color.boothBackground, in: .rect(cornerRadius: 12))
        }

        if let saved = savedBallot,
          let player = projection.roster.first(where: { $0.userId == saved.targetUserId })
        {
          Label(
            "Saved: \(player.displayName) · revision \(saved.revision)", systemImage: "lock.fill"
          )
          .font(.footnote)
          .foregroundStyle(.secondary)
        }

        Button(savedBallot == nil ? "Review Vote" : "Review Revision") {
          confirmsVote = true
        }
        .buttonStyle(BoothPrimaryButtonStyle())
        .disabled(selectedUserId == nil || model.commandInFlight)
        .accessibilityIdentifier(runoff ? "vote.runoff.submit" : "vote.normal.submit")
      }
    }
    .padding(BoothSpacing.medium)
    .background(Color.boothSurface, in: .rect(cornerRadius: 16))
    .alert("Confirm your secret vote?", isPresented: $confirmsVote) {
      Button("Keep Editing", role: .cancel) {}
      Button("Submit Vote", role: .destructive) {
        guard let selectedUserId else { return }
        Task { await model.submitVote(for: selectedUserId, runoff: runoff) }
      }
    } message: {
      Text(
        "You can revise this choice until the server deadline. Your ballot stays private during the match."
      )
    }
  }

  private var candidates: [MatchSnapshot.RosterEntry] {
    projection.roster.filter { player in
      player.status == "active"
        && player.userId != projection.selfProjection.userId
        && (!runoff || projection.runoffUserIds.contains(player.userId))
    }
  }

  private var savedBallot: MatchSnapshot.PrivateBallot? {
    runoff ? projection.selfProjection.runoffBallot : projection.selfProjection.normalBallot
  }
}

struct FinalPleaView: View {
  let model: LiveMatchModel
  let projection: MatchProjection
  @State private var text = ""
  @State private var confirmsPlea = false

  var body: some View {
    if isFinalist {
      VStack(alignment: .leading, spacing: BoothSpacing.medium) {
        Label("Your final plea", systemImage: "megaphone.fill")
          .font(.title3.bold())
        Text("Tell the jury why you should win. Your latest submitted plea is used.")
          .font(.subheadline)
          .foregroundStyle(.secondary)
        TextEditor(text: $text)
          .frame(minHeight: 120)
          .padding(8)
          .background(Color.boothBackground, in: .rect(cornerRadius: 12))
          .onChange(of: text) { _, value in
            if value.count > 240 { text = String(value.prefix(240)) }
          }
        HStack {
          Text("\(text.count)/240").font(.caption).foregroundStyle(.secondary)
          Spacer()
          if projection.selfProjection.finalPleaSubmitted {
            Label("Saved", systemImage: "checkmark.circle.fill").font(.caption).foregroundStyle(
              .green)
          }
        }
        Button(projection.selfProjection.finalPleaSubmitted ? "Update Plea" : "Submit Plea") {
          confirmsPlea = true
        }
        .buttonStyle(BoothPrimaryButtonStyle())
        .disabled(
          text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.commandInFlight)
      }
      .padding(BoothSpacing.medium)
      .background(Color.boothSurface, in: .rect(cornerRadius: 16))
      .alert("Submit final plea?", isPresented: $confirmsPlea) {
        Button("Keep Editing", role: .cancel) {}
        Button("Submit") { Task { await model.submitFinalPlea(text) } }
      } message: {
        Text("Your plea becomes visible to jurors when jury voting begins.")
      }
    } else {
      BoothStatusCard(
        title: "The finalists are speaking",
        detail:
          "Stay for the final jury vote. Reopening the app restores this spectator state from the server.",
        systemImage: "ear.fill"
      )
    }
  }

  private var isFinalist: Bool {
    projection.roster.contains {
      $0.userId == projection.selfProjection.userId && $0.status == "active"
    }
  }
}

struct JuryView: View {
  let model: LiveMatchModel
  let projection: MatchProjection
  @State private var selectedUserId: UUID?
  @State private var confirmsVote = false

  var body: some View {
    if isJuror {
      VStack(alignment: .leading, spacing: BoothSpacing.medium) {
        Label("Choose the winner", systemImage: "person.2.badge.gearshape.fill")
          .font(.title3.bold())
        ForEach(projection.finalPleas) { plea in
          VStack(alignment: .leading, spacing: BoothSpacing.small) {
            Text(name(plea.userId)).font(.headline)
            Text(plea.text)
            Button {
              selectedUserId = plea.userId
            } label: {
              Label(
                selectedUserId == plea.userId ? "Selected" : "Choose \(name(plea.userId))",
                systemImage: selectedUserId == plea.userId ? "checkmark.circle.fill" : "circle"
              )
            }
          }
          .padding(BoothSpacing.medium)
          .background(Color.boothBackground, in: .rect(cornerRadius: 12))
        }
        if let ballot = projection.selfProjection.juryBallot {
          Text("Saved jury ballot: \(name(ballot.finalistUserId)) · revision \(ballot.revision)")
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
        Button("Review Jury Vote") { confirmsVote = true }
          .buttonStyle(BoothPrimaryButtonStyle())
          .disabled(selectedUserId == nil || model.commandInFlight)
          .accessibilityIdentifier("jury.submit")
      }
      .padding(BoothSpacing.medium)
      .background(Color.boothSurface, in: .rect(cornerRadius: 16))
      .alert("Confirm jury vote?", isPresented: $confirmsVote) {
        Button("Keep Reviewing", role: .cancel) {}
        Button("Submit Vote") {
          guard let selectedUserId else { return }
          Task { await model.submitJuryVote(for: selectedUserId) }
        }
      } message: {
        Text("The jury ballot remains secret and can be revised until the deadline.")
      }
    } else {
      BoothStatusCard(
        title: "The jury is deciding",
        detail:
          "Finalists cannot see individual jury ballots. The server will reveal only the completed result.",
        systemImage: "hourglass"
      )
    }
  }

  private var isJuror: Bool {
    projection.roster.contains {
      $0.userId == projection.selfProjection.userId && $0.status == "eliminated"
    }
  }

  private func name(_ id: UUID) -> String {
    projection.roster.first(where: { $0.userId == id })?.displayName ?? "Contestant"
  }
}

struct DossierView: View {
  let model: LiveMatchModel
  let projection: MatchProjection

  var body: some View {
    if let dossier = model.dossier {
      VStack(alignment: .leading, spacing: BoothSpacing.medium) {
        VStack(spacing: BoothSpacing.small) {
          Image(
            systemName: dossier.winnerUserId == projection.selfProjection.userId
              ? "trophy.fill" : "flag.checkered"
          )
          .font(.system(size: 48))
          .foregroundStyle(.yellow)
          Text(
            dossier.winnerUserId == projection.selfProjection.userId
              ? "You won" : "\(name(dossier.winnerUserId)) won"
          )
          .font(.title.bold())
          Text(
            "Resolved by \(dossier.juryResolutionMethod.replacingOccurrences(of: "_", with: " "))."
          )
          .font(.subheadline)
          .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)

        ForEach(dossier.rounds) { round in
          DisclosureGroup("Round \(round.roundNumber) · \(name(round.eliminatedUserId)) eliminated")
          {
            ForEach(round.normalBallots + round.automaticBallots) { ballot in
              Label(
                "\(name(ballot.voterUserId)) → \(name(ballot.targetUserId))",
                systemImage: ballot.automatic ? "clock.badge.exclamationmark" : "checkmark.shield"
              )
              .font(.subheadline)
            }
          }
        }

        Text("Deals").font(.headline)
        if dossier.deals.isEmpty {
          Text("No formal offers were made.").foregroundStyle(.secondary)
        }
        ForEach(dossier.deals) { deal in
          DealOutcomeCard(deal: deal, name: name)
        }

        Text("Jury ballots").font(.headline)
        ForEach(dossier.juryBallots) { ballot in
          Text("\(name(ballot.jurorUserId)) chose \(name(ballot.finalistUserId))")
            .font(.subheadline)
        }
      }
      .padding(BoothSpacing.medium)
      .background(Color.boothSurface, in: .rect(cornerRadius: 16))
    } else {
      VStack(spacing: BoothSpacing.medium) {
        ProgressView()
        Text("Preparing the match dossier")
        Button("Try Again") { Task { await model.loadDossier() } }
          .buttonStyle(.bordered)
      }
      .task { await model.loadDossier() }
      .padding(BoothSpacing.large)
      .frame(maxWidth: .infinity)
      .background(Color.boothSurface, in: .rect(cornerRadius: 16))
    }
  }

  private func name(_ id: UUID) -> String {
    projection.roster.first(where: { $0.userId == id })?.displayName ?? "Contestant"
  }
}

private struct DealOutcomeCard: View {
  let deal: MatchDossier.Deal
  let name: (UUID) -> String

  var body: some View {
    HStack(alignment: .top) {
      Image(systemName: symbol).foregroundStyle(color)
      VStack(alignment: .leading, spacing: 3) {
        Text(outcome).font(.headline)
        Text(
          "\(name(deal.senderPlayerId)) offered \(deal.amount) to \(name(deal.recipientPlayerId)) to vote for \(name(deal.promisedTargetPlayerId))."
        )
        .font(.caption)
        .foregroundStyle(.secondary)
      }
    }
    .padding(BoothSpacing.medium)
    .background(color.opacity(0.1), in: .rect(cornerRadius: 12))
    .accessibilityElement(children: .combine)
  }

  private var outcome: String { deal.outcome.capitalized }
  private var symbol: String {
    switch deal.outcome {
    case "honored": "checkmark.seal.fill"
    case "betrayed": "theatermasks.fill"
    case "reversed": "arrow.uturn.backward.circle.fill"
    case "declined": "xmark.circle.fill"
    default: "clock.badge.xmark.fill"
    }
  }
  private var color: Color {
    switch deal.outcome {
    case "honored": .green
    case "betrayed": .purple
    case "reversed": .blue
    case "declined": .red
    default: .secondary
    }
  }
}
