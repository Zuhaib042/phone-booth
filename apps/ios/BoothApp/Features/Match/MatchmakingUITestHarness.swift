import SwiftUI

#if DEBUG
  struct MatchmakingUITestHarness: View {
    let scenario: String
    @State private var state: String

    init(scenario: String) {
      self.scenario = scenario
      _state = State(initialValue: scenario)
    }

    var body: some View {
      NavigationStack {
        VStack(spacing: BoothSpacing.large) {
          switch state {
          case "searching":
            ProgressView()
            Text("Finding five contestants").font(.title2.bold())
            Button("Cancel Search") { state = "cancelled" }
              .buttonStyle(.bordered)
          case "cancelled":
            Label("Search cancelled", systemImage: "xmark.circle")
            Text("No match was joined and no coins moved.")
          case "ready":
            Text("Your booth is ready").font(.title2.bold())
            ServerTimerView(deadline: Date().addingTimeInterval(15), label: "Confirm within")
            Button("I'm Ready") { state = "confirmed" }
              .buttonStyle(BoothPrimaryButtonStyle())
              .accessibilityIdentifier("matchmaking.ready")
          case "confirmed":
            Label("Ready confirmed", systemImage: "checkmark.circle.fill")
          case "timeout":
            Text("Your booth is ready").font(.title2.bold())
            ServerTimerView(deadline: Date(timeIntervalSince1970: 0), label: "Confirm within")
            Text("The ready window expired. Refreshing matchmaking safely.")
          case "matched":
            Text("The Booth").font(.largeTitle.bold())
            Text("Negotiation").font(.title2)
            Button("Red Phone") {}
              .buttonStyle(BoothPrimaryButtonStyle())
              .accessibilityIdentifier("booth.red-phone")
          default:
            Text("Unknown test scenario")
          }
        }
        .padding(BoothSpacing.large)
        .navigationTitle("Matchmaking")
      }
    }
  }
#endif
