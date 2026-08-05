import Foundation

actor RealtimeClient {
    struct Configuration: Sendable {
        var heartbeatInterval: Duration = .seconds(20)
        var maximumBackoff: Duration = .seconds(30)
    }

    private let session: URLSession
    private let configuration: Configuration
    private var connectionTask: Task<Void, Never>?

    init(session: URLSession = .shared, configuration: Configuration = .init()) {
        self.session = session
        self.configuration = configuration
    }

    func messages(
        url: URL,
        accessToken: String,
        afterCursor: @escaping @Sendable () async -> Int
    ) -> AsyncThrowingStream<RealtimeMessage, Error> {
        connectionTask?.cancel()
        return AsyncThrowingStream { continuation in
            let task = Task { [weak self] in
                guard let self else { return }
                await self.run(
                    url: url,
                    accessToken: accessToken,
                    afterCursor: afterCursor,
                    continuation: continuation
                )
            }
            connectionTask = task
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func disconnect() {
        connectionTask?.cancel()
        connectionTask = nil
    }

    private func run(
        url: URL,
        accessToken: String,
        afterCursor: @escaping @Sendable () async -> Int,
        continuation: AsyncThrowingStream<RealtimeMessage, Error>.Continuation
    ) async {
        var attempt = 0
        while !Task.isCancelled {
            do {
                var request = URLRequest(url: url)
                request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
                let socket = session.webSocketTask(with: request)
                socket.resume()
                let cursor = await afterCursor()
                let resumeData = try JSONEncoder().encode(ConnectionResume(afterCursor: cursor))
                try await socket.send(.data(resumeData))
                attempt = 0

                let heartbeat = Task {
                    while !Task.isCancelled {
                        try await Task.sleep(for: configuration.heartbeatInterval)
                        try await socket.sendPingAsync()
                    }
                }
                defer {
                    heartbeat.cancel()
                    socket.cancel(with: .goingAway, reason: nil)
                }
                while !Task.isCancelled {
                    let message = try await socket.receive()
                    let data: Data
                    switch message {
                    case .data(let value): data = value
                    case .string(let value): data = Data(value.utf8)
                    @unknown default: continue
                    }
                    continuation.yield(try decode(data))
                }
            } catch is CancellationError {
                break
            } catch {
                attempt += 1
                let seconds = min(pow(2, Double(attempt - 1)), configuration.maximumBackoff.seconds)
                do { try await Task.sleep(for: .seconds(seconds)) } catch { break }
            }
        }
        continuation.finish()
    }

    private func decode(_ data: Data) throws -> RealtimeMessage {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        if let event = try? decoder.decode(RealtimeEvent.self, from: data) {
            return .event(event)
        }
        return .protocolError(try decoder.decode(RealtimeProtocolError.self, from: data))
    }
}

private extension URLSessionWebSocketTask {
    func sendPingAsync() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            sendPing { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }
}

private extension Duration {
    var seconds: Double {
        let value = components
        return Double(value.seconds) + Double(value.attoseconds) / 1e18
    }
}
