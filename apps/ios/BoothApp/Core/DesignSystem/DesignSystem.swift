import SwiftUI

extension Color {
    static let boothBackground = Color(uiColor: .systemBackground)
    static let boothSurface = Color(uiColor: .secondarySystemBackground)
    static let boothAccent = Color(uiColor: .systemRed)
    static let boothSeparator = Color(uiColor: .separator)
}

enum BoothSpacing {
    static let small: CGFloat = 8
    static let medium: CGFloat = 16
    static let large: CGFloat = 24
}

struct BoothPrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .frame(maxWidth: .infinity, minHeight: 50)
            .foregroundStyle(.white)
            .background(Color.boothAccent.opacity(configuration.isPressed ? 0.75 : 1))
            .clipShape(.rect(cornerRadius: 14))
    }
}
