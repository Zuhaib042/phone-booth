import BoothAPI
import Foundation
import OpenAPIURLSession

actor BoothAPIClient {
  private let client: Client
  private let baseURL: URL
  private let session: URLSession
  private let tokenProvider: AccessTokenProvider
  private let decoder: JSONDecoder

  init(
    baseURL: URL,
    tokenProvider: AccessTokenProvider,
    session: URLSession = .shared
  ) {
    self.baseURL = baseURL
    self.session = session
    self.tokenProvider = tokenProvider
    decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    client = Client(
      serverURL: baseURL,
      transport: URLSessionTransport(configuration: .init(session: session)),
      middlewares: [BearerAuthMiddleware(tokenProvider: tokenProvider)]
    )
  }

  private func request<Response: Decodable>(
    _ method: String,
    path: String,
    queryItems: [URLQueryItem] = [],
    body: Data? = nil,
    expectedStatuses: Set<Int>
  ) async throws -> Response {
    let data = try await requestData(
      method,
      path: path,
      queryItems: queryItems,
      body: body,
      expectedStatuses: expectedStatuses
    )
    do {
      return try decoder.decode(Response.self, from: data)
    } catch {
      throw APIClientError.invalidPayload
    }
  }

  @discardableResult
  private func requestData(
    _ method: String,
    path: String,
    queryItems: [URLQueryItem] = [],
    body: Data? = nil,
    expectedStatuses: Set<Int>
  ) async throws -> Data {
    var components = URLComponents(
      url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)
    components?.queryItems = queryItems.isEmpty ? nil : queryItems
    guard let url = components?.url else { throw APIClientError.invalidPayload }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.setValue(
      "Bearer \(await tokenProvider.current() ?? "")", forHTTPHeaderField: "Authorization")
    if let body {
      request.httpBody = body
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    if method != "GET" {
      request.setValue(UUID().uuidString.lowercased(), forHTTPHeaderField: "Idempotency-Key")
    }
    let (data, response) = try await session.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard expectedStatuses.contains(status) else {
      let envelope = try? decoder.decode(ServerErrorEnvelope.self, from: data)
      throw APIClientError.server(
        status, envelope?.error.message ?? "The server could not complete that action.")
    }
    return data
  }

  private func encode<Value: Encodable>(_ value: Value) throws -> Data {
    try JSONEncoder().encode(value)
  }

  func isLive() async throws -> Bool {
    switch try await client.getLiveHealth() {
    case .ok:
      true
    case .undocumented(let statusCode, _):
      throw APIClientError.unexpectedStatus(statusCode)
    }
  }

  func loadHome() async throws -> HomeProjection {
    async let account = currentAccount()
    async let wallet = coinWallet()
    let (accountValue, walletValue) = try await (account, wallet)
    guard let configuredMatchOutflowCap = walletValue.configuredMatchOutflowCap else {
      throw APIClientError.invalidPayload
    }
    return HomeProjection(
      avatarKey: accountValue.profile.avatarKey,
      configuredMatchOutflowCap: configuredMatchOutflowCap,
      displayName: accountValue.profile.displayName,
      progressionLevel: accountValue.profile.progressionLevel,
      restricted: walletValue.restricted,
      spendableBalance: walletValue.spendable
    )
  }

  private func currentAccount() async throws -> Components.Schemas.Account {
    switch try await client.getCurrentAccount() {
    case .ok(let response): try response.body.json
    case .unauthorized: throw APIClientError.unexpectedStatus(401)
    case .notFound: throw APIClientError.unexpectedStatus(404)
    case .serviceUnavailable: throw APIClientError.unexpectedStatus(503)
    case .undocumented(let statusCode, _): throw APIClientError.unexpectedStatus(statusCode)
    }
  }

  private func coinWallet() async throws -> Components.Schemas.CoinWallet {
    switch try await client.getCoinWallet() {
    case .ok(let response): try response.body.json
    case .unauthorized: throw APIClientError.unexpectedStatus(401)
    case .forbidden: throw APIClientError.unexpectedStatus(403)
    case .notFound: throw APIClientError.unexpectedStatus(404)
    case .serviceUnavailable: throw APIClientError.unexpectedStatus(503)
    case .undocumented(let statusCode, _): throw APIClientError.unexpectedStatus(statusCode)
    }
  }
}

enum APIClientError: Error, Equatable {
  case invalidPayload
  case server(Int, String)
  case unexpectedStatus(Int)

  var userMessage: String {
    switch self {
    case .invalidPayload:
      "The server returned an unreadable response. Please try again."
    case .server(_, let message):
      message
    case .unexpectedStatus:
      "The server could not complete that action. Please try again."
    }
  }
}

extension BoothAPIClient: HomeDataLoading {}

extension BoothAPIClient: MatchExperienceAPI {
  func createMatchmakingTicket() async throws -> MatchmakingTicket {
    try await request(
      "POST",
      path: "/v1/matchmaking/tickets",
      body: encode(MatchmakingRequest(compatibilityVersion: 1, language: "en", region: "global")),
      expectedStatuses: [200, 201]
    )
  }

  func matchmakingTicket(_ ticketId: UUID) async throws -> MatchmakingTicket {
    try await request("GET", path: "/v1/matchmaking/tickets/\(ticketId)", expectedStatuses: [200])
  }

  func cancelMatchmakingTicket(_ ticketId: UUID) async throws -> MatchmakingTicket {
    try await request(
      "POST", path: "/v1/matchmaking/tickets/\(ticketId)/cancel", expectedStatuses: [200])
  }

  func confirmMatchmakingReady(_ ticketId: UUID) async throws -> MatchmakingTicket {
    try await request(
      "POST", path: "/v1/matchmaking/tickets/\(ticketId)/ready", expectedStatuses: [200])
  }

  func confirmBoothReady(_ matchId: UUID) async throws -> MatchReadyProjection {
    try await request("POST", path: "/v1/matches/\(matchId)/ready", expectedStatuses: [200])
  }

  func matchSnapshot(_ matchId: UUID) async throws -> MatchSnapshot {
    try await request("GET", path: "/v1/matches/\(matchId)/snapshot", expectedStatuses: [200])
  }

  func matchWallet(_ matchId: UUID) async throws -> CoinWalletProjection {
    try await request(
      "GET",
      path: "/v1/economy/wallet",
      queryItems: [URLQueryItem(name: "matchId", value: matchId.uuidString.lowercased())],
      expectedStatuses: [200]
    )
  }

  func quickPhrases() async throws -> [QuickPhrase] {
    let response: QuickPhraseList = try await request(
      "GET", path: "/v1/chat/quick-phrases", expectedStatuses: [200]
    )
    return response.quickPhrases
  }

  func chatThreads(_ matchId: UUID) async throws -> [ChatThreadProjection] {
    let response: ThreadList = try await request(
      "GET", path: "/v1/matches/\(matchId)/chat/threads", expectedStatuses: [200]
    )
    return response.threads
  }

  func chatMessages(matchId: UUID, threadId: UUID) async throws -> [ChatMessageProjection] {
    let response: MessageList = try await request(
      "GET",
      path: "/v1/matches/\(matchId)/chat/threads/\(threadId)/messages",
      expectedStatuses: [200]
    )
    return response.messages
  }

  func sendChatMessage(matchId: UUID, threadId: UUID, text: String) async throws
    -> ChatMessageAttempt
  {
    try await sendMessage(
      matchId: matchId, threadId: threadId, body: .typed(kind: "typed", text: text))
  }

  func sendQuickPhrase(matchId: UUID, threadId: UUID, key: String) async throws
    -> ChatMessageAttempt
  {
    try await sendMessage(
      matchId: matchId,
      threadId: threadId,
      body: .quickPhrase(kind: "quick_phrase", quickPhraseKey: key)
    )
  }

  private func sendMessage(
    matchId: UUID,
    threadId: UUID,
    body: SendMessageRequest
  ) async throws -> ChatMessageAttempt {
    try await request(
      "POST",
      path: "/v1/matches/\(matchId)/chat/threads/\(threadId)/messages",
      body: encode(body),
      expectedStatuses: [201, 422, 429]
    )
  }

  func muteUser(matchId: UUID, userId: UUID) async throws {
    _ = try await requestData(
      "POST", path: "/v1/matches/\(matchId)/chat/users/\(userId)/mute", expectedStatuses: [200]
    )
  }

  func blockUser(matchId: UUID, userId: UUID) async throws {
    _ = try await requestData(
      "POST", path: "/v1/matches/\(matchId)/chat/users/\(userId)/block", expectedStatuses: [200]
    )
  }

  func reportUser(matchId: UUID, userId: UUID, category: String) async throws {
    _ = try await requestData(
      "POST",
      path: "/v1/matches/\(matchId)/chat/users/\(userId)/report",
      body: encode(ReportRequest(category: category)),
      expectedStatuses: [201]
    )
  }

  func reportMessage(matchId: UUID, messageId: UUID, category: String) async throws {
    _ = try await requestData(
      "POST",
      path: "/v1/matches/\(matchId)/chat/messages/\(messageId)/report",
      body: encode(ReportRequest(category: category)),
      expectedStatuses: [201]
    )
  }

  func bribeOffers(_ matchId: UUID) async throws -> [BribeOfferProjection] {
    let response: OfferList = try await request(
      "GET", path: "/v1/matches/\(matchId)/bribes", expectedStatuses: [200]
    )
    return response.offers
  }

  func createBribeOffer(
    matchId: UUID,
    recipientUserId: UUID,
    targetUserId: UUID,
    amount: Int,
    message: String?
  ) async throws -> BribeOfferProjection {
    try await request(
      "POST",
      path: "/v1/matches/\(matchId)/bribes",
      body: encode(
        CreateOfferRequest(
          amount: amount,
          message: message?.isEmpty == true ? nil : message,
          recipientUserId: recipientUserId,
          requestedTargetUserId: targetUserId
        )
      ),
      expectedStatuses: [200, 201]
    )
  }

  func acceptBribeOffer(_ offerId: UUID) async throws -> BribeOfferProjection {
    try await request("POST", path: "/v1/bribes/\(offerId)/accept", expectedStatuses: [200])
  }

  func declineBribeOffer(_ offerId: UUID) async throws -> BribeOfferProjection {
    try await request("POST", path: "/v1/bribes/\(offerId)/decline", expectedStatuses: [200])
  }

  func submitBallot(matchId: UUID, targetUserId: UUID) async throws -> BallotAcknowledgement {
    try await request(
      "POST",
      path: "/v1/matches/\(matchId)/ballot",
      body: encode(TargetRequest(targetUserId: targetUserId)),
      expectedStatuses: [200]
    )
  }

  func submitRunoffBallot(matchId: UUID, targetUserId: UUID) async throws -> BallotAcknowledgement {
    try await request(
      "POST",
      path: "/v1/matches/\(matchId)/runoff-ballot",
      body: encode(TargetRequest(targetUserId: targetUserId)),
      expectedStatuses: [200]
    )
  }

  func submitFinalPlea(matchId: UUID, text: String) async throws -> FinalPleaAcknowledgement {
    try await request(
      "POST",
      path: "/v1/matches/\(matchId)/final-plea",
      body: encode(PleaRequest(text: text)),
      expectedStatuses: [200]
    )
  }

  func submitJuryBallot(matchId: UUID, finalistUserId: UUID) async throws -> BallotAcknowledgement {
    try await request(
      "POST",
      path: "/v1/matches/\(matchId)/jury-ballot",
      body: encode(JuryRequest(finalistUserId: finalistUserId)),
      expectedStatuses: [200]
    )
  }

  func dossier(_ matchId: UUID) async throws -> MatchDossier {
    try await request("GET", path: "/v1/matches/\(matchId)/dossier", expectedStatuses: [200])
  }
}

private struct ServerErrorEnvelope: Decodable {
  struct Details: Decodable { let message: String }
  let error: Details
}

private struct MatchmakingRequest: Encodable {
  let compatibilityVersion: Int
  let language: String
  let region: String
}

private struct QuickPhraseList: Decodable { let quickPhrases: [QuickPhrase] }
private struct ThreadList: Decodable { let threads: [ChatThreadProjection] }
private struct MessageList: Decodable { let messages: [ChatMessageProjection] }
private struct OfferList: Decodable { let offers: [BribeOfferProjection] }
private struct ReportRequest: Encodable { let category: String }
private struct TargetRequest: Encodable { let targetUserId: UUID }
private struct PleaRequest: Encodable { let text: String }
private struct JuryRequest: Encodable { let finalistUserId: UUID }

private struct CreateOfferRequest: Encodable {
  let amount: Int
  let message: String?
  let recipientUserId: UUID
  let requestedTargetUserId: UUID
}

private enum SendMessageRequest: Encodable {
  case typed(kind: String, text: String)
  case quickPhrase(kind: String, quickPhraseKey: String)

  func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .typed(let kind, let text):
      try container.encode(kind, forKey: .kind)
      try container.encode(text, forKey: .text)
    case .quickPhrase(let kind, let quickPhraseKey):
      try container.encode(kind, forKey: .kind)
      try container.encode(quickPhraseKey, forKey: .quickPhraseKey)
    }
  }

  private enum CodingKeys: String, CodingKey { case kind, quickPhraseKey, text }
}
