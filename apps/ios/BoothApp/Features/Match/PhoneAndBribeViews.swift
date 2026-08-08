import Observation
import SwiftUI

struct ThreadListView: View {
  @Environment(\.dismiss) private var dismiss
  let model: LiveMatchModel
  let projection: MatchProjection

  var body: some View {
    List {
      if model.threads.isEmpty {
        ContentUnavailableView(
          "No active lines",
          systemImage: "phone.down.fill",
          description: Text(
            "Private phone lines are available only between active contestants during negotiation.")
        )
      }
      ForEach(model.threads) { thread in
        NavigationLink {
          PrivateThreadView(
            api: model.api,
            liveModel: model,
            matchId: projection.matchId,
            selfUserId: projection.selfProjection.userId,
            thread: thread,
            projection: projection
          )
        } label: {
          HStack {
            Image(systemName: "person.crop.circle.fill")
              .font(.title2)
              .foregroundStyle(Color.boothAccent)
            VStack(alignment: .leading) {
              Text(thread.otherUser.displayName)
              if thread.blocked {
                Text("Blocked").font(.caption).foregroundStyle(.red)
              } else if thread.muted {
                Text("Muted").font(.caption).foregroundStyle(.secondary)
              }
            }
          }
        }
      }
    }
    .navigationTitle("Red Phone")
    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
    .task { await model.refreshPrivateState() }
  }
}

@MainActor
@Observable
private final class PrivateThreadModel {
  private(set) var messages: [ChatMessageProjection] = []
  private(set) var phrases: [QuickPhrase] = []
  private(set) var notice: String?
  private(set) var sending = false
  private let api: any MatchExperienceAPI
  private let matchId: UUID
  private let threadId: UUID

  init(api: any MatchExperienceAPI, matchId: UUID, threadId: UUID) {
    self.api = api
    self.matchId = matchId
    self.threadId = threadId
  }

  func load() async {
    do {
      async let messageValue = api.chatMessages(matchId: matchId, threadId: threadId)
      async let phraseValue = api.quickPhrases()
      messages = try await messageValue
      phrases = try await phraseValue
    } catch {
      notice = (error as? APIClientError)?.userMessage ?? "This private line could not be loaded."
    }
  }

  func send(text: String) async {
    await send { try await api.sendChatMessage(matchId: matchId, threadId: threadId, text: text) }
  }

  func send(phrase: QuickPhrase) async {
    await send {
      try await api.sendQuickPhrase(matchId: matchId, threadId: threadId, key: phrase.key)
    }
  }

  func mute(_ userId: UUID) async {
    await safety(success: "Contestant muted for this match.") {
      try await api.muteUser(matchId: matchId, userId: userId)
    }
  }

  func block(_ userId: UUID) async {
    await safety(success: "Contestant blocked from future communication and matchmaking.") {
      try await api.blockUser(matchId: matchId, userId: userId)
    }
  }

  func reportUser(_ userId: UUID) async {
    await safety(success: "Report submitted for review.") {
      try await api.reportUser(matchId: matchId, userId: userId, category: "other")
    }
  }

  func reportMessage(_ messageId: UUID) async {
    await safety(success: "Message reported and its evidence preserved.") {
      try await api.reportMessage(matchId: matchId, messageId: messageId, category: "other")
    }
  }

  func clearNotice() { notice = nil }

  private func send(action: () async throws -> ChatMessageAttempt) async {
    guard !sending else { return }
    sending = true
    defer { sending = false }
    do {
      let attempt = try await action()
      switch attempt.deliveryStatus {
      case "delivered":
        await load()
      case "blocked":
        notice =
          "That message was not delivered because it did not meet the community rules. Edit it or use a quick phrase."
      case "provider_unavailable":
        notice = "Free text is temporarily unavailable. Quick phrases and voting still work."
      case "rate_limited":
        notice = "You are sending too quickly. Wait a moment or use a quick phrase."
      default:
        notice = "The recipient cannot receive this message right now."
      }
    } catch {
      notice = (error as? APIClientError)?.userMessage ?? "The message could not be sent."
    }
  }

  private func safety(success: String, action: () async throws -> Void) async {
    do {
      try await action()
      notice = success
    } catch {
      notice =
        (error as? APIClientError)?.userMessage ?? "The safety action could not be completed."
    }
  }
}

private struct PrivateThreadView: View {
  enum SafetyAction { case mute, report, block }

  let liveModel: LiveMatchModel
  let matchId: UUID
  let selfUserId: UUID
  let thread: ChatThreadProjection
  let projection: MatchProjection
  @State private var chat: PrivateThreadModel
  @State private var draft = ""
  @State private var safetyAction: SafetyAction?
  @State private var showsOffer = false

  init(
    api: any MatchExperienceAPI,
    liveModel: LiveMatchModel,
    matchId: UUID,
    selfUserId: UUID,
    thread: ChatThreadProjection,
    projection: MatchProjection
  ) {
    self.liveModel = liveModel
    self.matchId = matchId
    self.selfUserId = selfUserId
    self.thread = thread
    self.projection = projection
    _chat = State(
      initialValue: PrivateThreadModel(api: api, matchId: matchId, threadId: thread.threadId))
  }

  var body: some View {
    VStack(spacing: 0) {
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(spacing: BoothSpacing.small) {
            OfferDeck(model: liveModel, projection: projection, userFilter: thread.otherUser.userId)
            ForEach(chat.messages) { message in
              MessageBubble(message: message, isMine: message.senderUserId == selfUserId)
                .id(message.id)
                .contextMenu {
                  if message.senderUserId != selfUserId {
                    Button(
                      "Report Message", systemImage: "exclamationmark.bubble", role: .destructive
                    ) {
                      Task { await chat.reportMessage(message.messageId) }
                    }
                  }
                }
            }
          }
          .padding(BoothSpacing.medium)
        }
        .onChange(of: chat.messages.count) { _, _ in
          if let last = chat.messages.last { proxy.scrollTo(last.id, anchor: .bottom) }
        }
      }

      if !thread.blocked {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack {
            ForEach(chat.phrases) { phrase in
              Button(phrase.text) { Task { await chat.send(phrase: phrase) } }
                .buttonStyle(.bordered)
                .disabled(chat.sending)
            }
          }
          .padding(.horizontal, BoothSpacing.medium)
        }
        HStack(alignment: .bottom) {
          TextField("Private message", text: $draft, axis: .vertical)
            .lineLimit(1...4)
            .textFieldStyle(.roundedBorder)
            .onChange(of: draft) { _, value in
              if value.count > 240 { draft = String(value.prefix(240)) }
            }
          Button {
            let value = draft
            draft = ""
            Task { await chat.send(text: value) }
          } label: {
            Image(systemName: "arrow.up.circle.fill").font(.title)
          }
          .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || chat.sending)
          .accessibilityLabel("Send private message")
        }
        .padding(BoothSpacing.medium)
        .background(.bar)
      }
    }
    .navigationTitle(thread.otherUser.displayName)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItemGroup(placement: .topBarTrailing) {
        Button {
          showsOffer = true
        } label: {
          Image(systemName: "handshake.fill")
        }
        .accessibilityLabel("Make an offer")
        Menu {
          Button("Mute for Match", systemImage: "speaker.slash") { safetyAction = .mute }
          Button("Report Contestant", systemImage: "exclamationmark.bubble") {
            safetyAction = .report
          }
          Button("Block Contestant", systemImage: "hand.raised.fill", role: .destructive) {
            safetyAction = .block
          }
        } label: {
          Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("Safety options")
      }
    }
    .task { await chat.load() }
    .sheet(isPresented: $showsOffer) {
      NavigationStack {
        BribeComposerView(
          model: liveModel, projection: projection, fixedRecipient: thread.otherUser.userId)
      }
    }
    .alert(
      "Private line",
      isPresented: Binding(get: { chat.notice != nil }, set: { if !$0 { chat.clearNotice() } })
    ) {
      Button("OK") { chat.clearNotice() }
    } message: {
      Text(chat.notice ?? "")
    }
    .confirmationDialog(
      "Safety action",
      isPresented: Binding(get: { safetyAction != nil }, set: { if !$0 { safetyAction = nil } })
    ) {
      Button("Cancel", role: .cancel) { safetyAction = nil }
      if safetyAction == .mute {
        Button("Mute for this Match") { Task { await chat.mute(thread.otherUser.userId) } }
      }
      if safetyAction == .report {
        Button("Submit Report", role: .destructive) {
          Task { await chat.reportUser(thread.otherUser.userId) }
        }
      }
      if safetyAction == .block {
        Button("Block Future Pairing", role: .destructive) {
          Task { await chat.block(thread.otherUser.userId) }
        }
      }
    } message: {
      Text(
        "Blocking silences communication and prevents future pairing. It never changes this match's roster, ballots, or accepted offers."
      )
    }
  }
}

private struct MessageBubble: View {
  let message: ChatMessageProjection
  let isMine: Bool

  var body: some View {
    HStack {
      if isMine { Spacer(minLength: 48) }
      Text(message.body)
        .padding(12)
        .foregroundStyle(isMine ? .white : .primary)
        .background(isMine ? Color.boothAccent : Color.boothSurface, in: .rect(cornerRadius: 14))
      if !isMine { Spacer(minLength: 48) }
    }
    .accessibilityLabel("\(isMine ? "You" : "Contestant"): \(message.body)")
  }
}

struct OfferDeck: View {
  let model: LiveMatchModel
  let projection: MatchProjection
  var userFilter: UUID?
  @State private var offerToAccept: BribeOfferProjection?

  init(model: LiveMatchModel, projection: MatchProjection, userFilter: UUID? = nil) {
    self.model = model
    self.projection = projection
    self.userFilter = userFilter
  }

  var body: some View {
    let visible = model.offers.filter { offer in
      userFilter == nil || offer.senderUserId == userFilter || offer.recipientUserId == userFilter
    }
    if !visible.isEmpty {
      VStack(alignment: .leading, spacing: BoothSpacing.small) {
        Text("Formal offers").font(.headline)
        ForEach(visible) { offer in
          VStack(alignment: .leading, spacing: BoothSpacing.small) {
            HStack {
              Label("\(offer.amount) coins", systemImage: "seal.fill")
                .font(.headline)
              Spacer()
              Text(offer.state.capitalized).font(.caption.bold())
            }
            Text(
              "\(name(offer.senderUserId)) → \(name(offer.recipientUserId)) · asks for \(name(offer.requestedTargetUserId))"
            )
            .font(.subheadline)
            if let message = offer.filteredMessage {
              Text(message).font(.caption).foregroundStyle(.secondary)
            }
            if offer.state == "pending", offer.recipientUserId == projection.selfProjection.userId {
              HStack {
                Button("Decline", role: .destructive) {
                  Task { await model.declineOffer(offer.offerId) }
                }
                .buttonStyle(.bordered)
                Button("Review Acceptance") { offerToAccept = offer }
                  .buttonStyle(.borderedProminent)
              }
            }
          }
          .padding(BoothSpacing.medium)
          .background(Color.orange.opacity(0.1), in: .rect(cornerRadius: 12))
        }
      }
      .alert(
        "Accept this non-binding offer?",
        isPresented: Binding(get: { offerToAccept != nil }, set: { if !$0 { offerToAccept = nil } })
      ) {
        Button("Cancel", role: .cancel) { offerToAccept = nil }
        Button("Accept Offer") {
          guard let offerToAccept else { return }
          Task { await model.acceptOffer(offerToAccept.offerId) }
          self.offerToAccept = nil
        }
      } message: {
        Text(
          "Coins become pending now and settle after any valid ballot. You remain free to vote for anyone, and accepted coins are not reclaimed for betrayal."
        )
      }
    }
  }

  private func name(_ id: UUID) -> String {
    projection.roster.first(where: { $0.userId == id })?.displayName ?? "Contestant"
  }
}

struct BribeComposerView: View {
  @Environment(\.dismiss) private var dismiss
  let model: LiveMatchModel
  let projection: MatchProjection
  let fixedRecipient: UUID?
  @State private var recipient: UUID?
  @State private var target: UUID?
  @State private var amount = 50
  @State private var message = ""
  @State private var confirmsOffer = false

  init(model: LiveMatchModel, projection: MatchProjection, fixedRecipient: UUID? = nil) {
    self.model = model
    self.projection = projection
    self.fixedRecipient = fixedRecipient
    _recipient = State(initialValue: fixedRecipient)
  }

  var body: some View {
    Form {
      Section("Recipient") {
        Picker("Contestant", selection: $recipient) {
          Text("Choose").tag(UUID?.none)
          ForEach(recipients) { player in Text(player.displayName).tag(Optional(player.userId)) }
        }
        .disabled(fixedRecipient != nil)
      }
      Section("Requested vote") {
        Picker("Target", selection: $target) {
          Text("Choose").tag(UUID?.none)
          ForEach(targets) { player in Text(player.displayName).tag(Optional(player.userId)) }
        }
      }
      Section("Booth Coins") {
        Stepper(value: $amount, in: 50...max(50, maximumAmount), step: 50) {
          LabeledContent("Amount", value: amount.formatted())
        }
        LabeledContent(
          "Remaining allowance", value: (model.wallet?.matchAllowance?.remaining ?? 0).formatted())
        LabeledContent("Spendable wallet", value: (model.wallet?.spendable ?? 0).formatted())
      }
      Section("Optional message") {
        TextField("Keep it concise", text: $message, axis: .vertical)
          .lineLimit(1...4)
      }
      Section {
        Button("Review Offer") { confirmsOffer = true }
          .buttonStyle(BoothPrimaryButtonStyle())
          .disabled(
            recipient == nil || target == nil || maximumAmount < 50 || model.commandInFlight)
      } footer: {
        Text(
          "An offer describes a promise. It never controls or preselects the recipient's ballot.")
      }
    }
    .navigationTitle("Make an Offer")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
    .alert("Send a non-binding offer?", isPresented: $confirmsOffer) {
      Button("Keep Editing", role: .cancel) {}
      Button("Send Offer") {
        guard let recipient, let target else { return }
        Task {
          await model.createOffer(
            recipient: recipient,
            target: target,
            amount: amount,
            message: message
          )
          dismiss()
        }
      }
    } message: {
      Text(
        "If the recipient accepts and casts any valid ballot, they keep the coins even when they vote differently from this request."
      )
    }
  }

  private var recipients: [MatchSnapshot.RosterEntry] {
    projection.roster.filter {
      $0.status == "active" && $0.userId != projection.selfProjection.userId
    }
  }

  private var targets: [MatchSnapshot.RosterEntry] {
    projection.roster.filter { $0.status == "active" && $0.userId != recipient }
  }

  private var maximumAmount: Int {
    min(model.wallet?.spendable ?? 0, model.wallet?.matchAllowance?.remaining ?? 0)
  }
}
