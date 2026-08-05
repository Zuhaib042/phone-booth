import Foundation

actor URLSessionSnapshotLoader: MatchSnapshotLoading {
    private let baseURL: URL
    private let session: URLSession

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func snapshot(matchId: UUID, accessToken: String) async throws -> MatchSnapshot {
        var request = URLRequest(
            url: baseURL.appending(path: "/v1/matches/\(matchId.uuidString)/snapshot")
        )
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw APIClientError.unexpectedStatus(status) }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(MatchSnapshot.self, from: data)
    }
}
