import SwiftUI

struct HomeView: View {
    let model: HomeModel

    var body: some View {
        Group {
            switch model.state {
            case .idle, .loading:
                LoadingStateView(title: "Preparing your booth")
            case .failed(let message):
                ErrorStateView(message: message) { await model.load() }
            case .loaded(let projection):
                HomeContentView(projection: projection)
                    .refreshable { await model.load() }
            }
        }
        .navigationTitle("Booth")
    }
}

private struct HomeContentView: View {
    let projection: HomeProjection

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: BoothSpacing.large) {
                VStack(alignment: .leading, spacing: BoothSpacing.small) {
                    Text("Welcome back")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    PlayerSummaryCard(projection: projection)
                }

                VStack(alignment: .leading, spacing: BoothSpacing.medium) {
                    Text("Your coins")
                        .font(.title2.bold())

                    HStack(alignment: .top, spacing: BoothSpacing.medium) {
                        CoinSummaryCard(
                            title: "Wallet balance",
                            value: projection.spendableBalance,
                            detail: "Available Booth Coins",
                            systemImage: "wallet.bifold.fill",
                            accessibilityIdentifier: "home.wallet.balance"
                        )
                        CoinSummaryCard(
                            title: "Match allowance",
                            value: projection.configuredMatchOutflowCap,
                            detail: "Maximum outgoing per match",
                            systemImage: "gauge.with.dots.needle.67percent",
                            accessibilityIdentifier: "home.match.allowance"
                        )
                    }

                    Text("Your wallet carries between matches. The match allowance is a separate cap on how many coins you can promise during one match.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                if projection.restricted {
                    Label(
                        "Coin offers are temporarily restricted for this account.",
                        systemImage: "exclamationmark.lock.fill"
                    )
                    .font(.subheadline)
                    .foregroundStyle(.orange)
                    .padding(BoothSpacing.medium)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.orange.opacity(0.12), in: .rect(cornerRadius: 14))
                }

                NavigationLink {
                    MatchPreparationView(projection: projection)
                } label: {
                    Label("Play", systemImage: "phone.fill")
                }
                .buttonStyle(BoothPrimaryButtonStyle())
                .accessibilityHint("Reviews the live match rules before matchmaking")
            }
            .padding(BoothSpacing.medium)
        }
    }
}

struct PlayerSummaryCard: View {
    let projection: HomeProjection

    var body: some View {
        HStack(spacing: BoothSpacing.medium) {
            Image(systemName: "person.crop.circle.fill")
                .font(.system(size: 48))
                .foregroundStyle(Color.boothAccent)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(projection.displayName)
                    .font(.headline)
                Text("Level \(projection.progressionLevel)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(BoothSpacing.medium)
        .background(Color.boothSurface, in: .rect(cornerRadius: 16))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(projection.displayName), level \(projection.progressionLevel)")
    }
}

private struct CoinSummaryCard: View {
    let title: String
    let value: Int
    let detail: String
    let systemImage: String
    let accessibilityIdentifier: String

    var body: some View {
        VStack(alignment: .leading, spacing: BoothSpacing.small) {
            Label(title, systemImage: systemImage)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value, format: .number)
                .font(.title2.bold().monospacedDigit())
            Text(detail)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(BoothSpacing.medium)
        .frame(maxWidth: .infinity, minHeight: 128, alignment: .topLeading)
        .background(Color.boothSurface, in: .rect(cornerRadius: 16))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue("\(value) Booth Coins. \(detail)")
        .accessibilityIdentifier(accessibilityIdentifier)
    }
}
