import Foundation

actor AccessTokenProvider {
    private var token: String?

    func update(_ token: String?) {
        self.token = token
    }

    func current() -> String? {
        token
    }
}
