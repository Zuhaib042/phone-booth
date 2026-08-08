import SwiftUI

struct RootView: View {
  @Environment(AppModel.self) private var app

  var body: some View {
    #if DEBUG
      if let scenario = ProcessInfo.processInfo.environment["BOOTH_UI_TEST_MATCHMAKING"] {
        MatchmakingUITestHarness(scenario: scenario)
      } else {
        authenticatedContent
      }
    #else
      authenticatedContent
    #endif
  }

  private var authenticatedContent: some View {
    Group {
      switch app.session.state {
      case .restoring:
        LoadingStateView(title: "Opening the booth")
      case .signedOut:
        SignInView()
      case .signedIn:
        NavigationShell()
      case .failed(let message):
        ErrorStateView(message: message) {
          await app.restoreSession()
        }
      }
    }
    .background(Color.boothBackground)
    .tint(.boothAccent)
  }
}
