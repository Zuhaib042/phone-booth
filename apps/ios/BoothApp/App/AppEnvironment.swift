import Foundation

enum AppEnvironment: String, Sendable {
  case development
  case staging
  case production

  static var current: AppEnvironment {
    let value = ProcessInfo.processInfo.environment["BOOTH_ENVIRONMENT"] ?? "development"
    return AppEnvironment(rawValue: value) ?? .development
  }

  var apiBaseURL: URL {
    if let override = ProcessInfo.processInfo.environment["BOOTH_API_BASE_URL"],
      let url = URL(string: override)
    {
      return url
    }
    return switch self {
    case .development: URL(string: "http://127.0.0.1:3000")!
    case .staging: URL(string: "https://staging-api.projectbooth.example")!
    case .production: URL(string: "https://api.projectbooth.example")!
    }
  }

  var realtimeURL: URL {
    var components = URLComponents(url: apiBaseURL, resolvingAgainstBaseURL: false)!
    components.scheme = components.scheme == "https" ? "wss" : "ws"
    components.path = "/v1/realtime"
    components.query = nil
    return components.url!
  }
}
