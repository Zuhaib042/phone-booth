import AuthenticationServices
import SwiftUI

struct SignInView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        VStack(spacing: BoothSpacing.large) {
            Image(systemName: "phone.fill")
                .font(.system(.largeTitle, design: .rounded, weight: .bold))
                .foregroundStyle(Color.boothAccent)
                .accessibilityHidden(true)
            Text("Project Booth")
                .font(.largeTitle.bold())
            Text("Six strangers. One red phone. Every promise is optional.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            SignInWithAppleButton(.signIn) { request in
                request.requestedScopes = []
            } onCompletion: { result in
                guard case .success(let authorization) = result,
                      let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                      let identityToken = credential.identityToken,
                      let token = String(data: identityToken, encoding: .utf8) else {
                    return
                }
                Task { await app.session.signIn(credential: token) }
            }
            .signInWithAppleButtonStyle(.black)
            .frame(maxWidth: 360, minHeight: 50)
            .clipShape(.rect(cornerRadius: 10))
            .accessibilityHint("Creates or restores your Project Booth account")
        }
        .padding(BoothSpacing.large)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
