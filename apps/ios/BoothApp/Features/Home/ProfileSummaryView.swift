import SwiftUI

struct ProfileSummaryView: View {
    let model: HomeModel
    let signOut: () async -> Void

    var body: some View {
        Group {
            switch model.state {
            case .idle, .loading:
                LoadingStateView(title: "Loading profile")
            case .failed(let message):
                ErrorStateView(message: message) { await model.load() }
            case .loaded(let projection):
                ScrollView {
                    VStack(alignment: .leading, spacing: BoothSpacing.large) {
                        PlayerSummaryCard(projection: projection)

                        VStack(alignment: .leading, spacing: BoothSpacing.small) {
                            Text("Profile")
                                .font(.title2.bold())
                            LabeledContent("Display name", value: projection.displayName)
                            Divider()
                            LabeledContent("Progression level", value: "\(projection.progressionLevel)")
                        }
                        .padding(BoothSpacing.medium)
                        .background(Color.boothSurface, in: .rect(cornerRadius: 16))

                        Button("Sign Out", role: .destructive) {
                            Task { await signOut() }
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .padding(BoothSpacing.medium)
                }
                .refreshable { await model.load() }
            }
        }
        .navigationTitle("Profile")
    }
}
