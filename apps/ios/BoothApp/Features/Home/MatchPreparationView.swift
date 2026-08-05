import SwiftUI

struct MatchPreparationView: View {
    let projection: HomeProjection

    var body: some View {
        List {
            Section {
                LabeledContent("Wallet balance") {
                    Text(projection.spendableBalance, format: .number)
                        .fontWeight(.semibold)
                }
                LabeledContent("Match allowance") {
                    Text(projection.configuredMatchOutflowCap, format: .number)
                        .fontWeight(.semibold)
                }
            } header: {
                Text("Your coins")
            } footer: {
                Text("The allowance limits outgoing offers in this match. Receiving coins never increases it.")
            }

            Section("How a match works") {
                PreparationRule(
                    systemImage: "person.3.fill",
                    title: "Six live contestants",
                    detail: "Matchmaking groups you with five other players for one synchronous game."
                )
                PreparationRule(
                    systemImage: "timer",
                    title: "Server deadlines keep moving",
                    detail: "Leaving the app or reconnecting never pauses a round timer."
                )
                PreparationRule(
                    systemImage: "hand.raised.fill",
                    title: "Bribes are non-binding",
                    detail: "A player who accepts your offer can still vote however they choose."
                )
                PreparationRule(
                    systemImage: "checkmark.seal.fill",
                    title: "Voting settles accepted offers",
                    detail: "Any valid ballot lets the recipient keep accepted coins, even after a betrayal."
                )
            }

            Section {
                Label(
                    "Opening this page does not start matchmaking.",
                    systemImage: "shield.checkered"
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Before you play")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct PreparationRule: View {
    let systemImage: String
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: BoothSpacing.medium) {
            Image(systemName: systemImage)
                .frame(width: 24)
                .foregroundStyle(Color.boothAccent)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.headline)
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}
