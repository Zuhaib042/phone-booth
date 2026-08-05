import Foundation

enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
        else { self = .object(try container.decode([String: JSONValue].self)) }
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

struct RealtimeEvent: Codable, Equatable, Sendable {
    let schemaVersion: Int
    let eventId: UUID
    let type: String
    let occurredAt: Date
    let matchId: UUID
    let matchVersion: Int
    let recipientCursor: Int
    let audience: String
    let recipientUserId: UUID?
    let payload: [String: JSONValue]
}

struct RealtimeProtocolError: Codable, Equatable, Sendable {
    let type: String
    let code: String
    let retryable: Bool
    let resumeFromCursor: Int?
}

enum RealtimeMessage: Equatable, Sendable {
    case event(RealtimeEvent)
    case protocolError(RealtimeProtocolError)
}

struct ConnectionResume: Encodable, Sendable {
    let schemaVersion = 1
    let type = "connection.resume"
    let afterCursor: Int
}
