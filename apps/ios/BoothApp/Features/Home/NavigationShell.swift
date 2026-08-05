import SwiftUI

struct NavigationShell: View {
    var body: some View {
        TabView {
            NavigationStack {
                ContentUnavailableView(
                    "The booth is ready",
                    systemImage: "phone.fill",
                    description: Text("Matchmaking arrives in M10.")
                )
                .navigationTitle("Booth")
            }
            .tabItem { Label("Booth", systemImage: "phone") }

            NavigationStack {
                ContentUnavailableView("Profile", systemImage: "person.crop.circle")
                    .navigationTitle("Profile")
            }
            .tabItem { Label("Profile", systemImage: "person") }
        }
    }
}
