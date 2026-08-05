import SwiftUI

struct NavigationShell: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        TabView {
            NavigationStack {
                HomeView(model: app.home)
            }
            .tabItem { Label("Booth", systemImage: "phone") }

            NavigationStack {
                ProfileSummaryView(model: app.home) {
                    await app.logout()
                }
            }
            .tabItem { Label("Profile", systemImage: "person") }
        }
        .task { await app.home.load() }
    }
}
