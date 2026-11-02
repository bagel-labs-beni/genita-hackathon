import SwiftUI

/// A02-J · Judge access (PRD v12 D41): a plain text-entry sheet over A02. The code comes from the
/// submission form / README; the server answers with a session for that code's demo account, then the
/// usual CS01 consent applies. No new design: this reuses the consent sheet's type, ink and buttons.
struct JudgeCodeSheet: View {
    @Bindable var model: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @State private var sending = false
    @State private var message: String?
    #if DEBUG
    /// Simulator / Mac debug runs: point the app at a server on this machine (README "Run locally").
    @State private var serverURL = UserDefaults.standard.string(forKey: "genita.api.url") ?? ""
    #endif
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Judge access").font(TypeStyle.title(28)).foregroundStyle(CallInk.ink).padding(.top, 32)
                .accessibilityAddTraits(.isHeader)
            Text("Enter the code from the submission form. No Apple ID needed.")
                .font(TypeStyle.body(16)).foregroundStyle(CallInk.mute).padding(.top, 12).fixedSize(horizontal: false, vertical: true)
            TextField("Access code", text: $code)
                .textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.go).focused($focused)
                .font(TypeStyle.body(16)).foregroundStyle(CallInk.ink)
                .padding(.horizontal, 16).frame(height: 50)
                .background(CallInk.field, in: RoundedRectangle(cornerRadius: 12))
                .padding(.top, 24).onSubmit { submit() }
                .accessibilityIdentifier("judgeCodeField")
            #if DEBUG
            TextField("Server URL (debug), e.g. http://localhost:8787", text: $serverURL)
                .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                .font(TypeStyle.body(14)).foregroundStyle(CallInk.ink)
                .padding(.horizontal, 16).frame(height: 44)
                .background(CallInk.field, in: RoundedRectangle(cornerRadius: 12))
                .padding(.top, 12).accessibilityIdentifier("judgeServerField")
            #endif
            if let message {
                Text(message).font(TypeStyle.body(14, .medium)).foregroundStyle(CallInk.ink).padding(.top, 12)
                    .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("judgeCodeError")
            }
            Spacer(minLength: 24)
            Button { submit() } label: {
                ZStack {
                    if sending { ProgressView().tint(CallInk.onInk) } else { Text("Continue") }
                }.font(TypeStyle.body(16, .medium)).foregroundStyle(CallInk.onInk)
                    .frame(maxWidth: .infinity).frame(height: 50).background(CallInk.ink, in: RoundedRectangle(cornerRadius: 12))
            }.buttonStyle(.plain).disabled(sending || code.trimmingCharacters(in: .whitespaces).isEmpty).accessibilityIdentifier("judgeCodeContinue")
            Button("Cancel") { dismiss() }
                .font(TypeStyle.body(16, .medium)).foregroundStyle(CallInk.ink).frame(maxWidth: .infinity).frame(height: 50)
                .disabled(sending).accessibilityIdentifier("judgeCodeCancel").padding(.bottom, 8)
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(CallInk.sheet.ignoresSafeArea())
        .preferredColorScheme(.light)
        .presentationDetents([.medium, .large])
        .onAppear { focused = true }
    }

    private func submit() {
        guard !sending, !code.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        sending = true
        message = nil
        #if DEBUG
        Self.applyDebugServer(serverURL)
        #endif
        Task { @MainActor in
            defer { sending = false }
            do {
                let r = try await GenitaAuthClient().signInWithJudgeCode(code)
                dismiss()
                model.signedIn(userId: r.me.user.id, consented: r.me.consented)
            } catch GenitaAuthError.unauthorized {
                message = "That code didn’t work. Check it and try again."
            } catch GenitaAuthError.server(let status, _) where status == 429 {
                message = "Too many tries. Wait 10 minutes and try again."
            } catch GenitaAuthError.offline {
                message = "Couldn’t reach the server. Check your connection."
            } catch {
                message = "Judge access isn’t available right now."
            }
        }
    }

    #if DEBUG
    /// "http://localhost:8787" → API base for sign-in and ws://localhost:8787/v1/session for the call. Empty = the deployed server.
    static func applyDebugServer(_ text: String, defaults: UserDefaults = .standard) {
        let raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty, var c = URLComponents(string: raw), c.host != nil else {
            defaults.removeObject(forKey: "genita.api.url"); defaults.removeObject(forKey: "genita.server.url"); return
        }
        defaults.set(raw, forKey: "genita.api.url")
        c.scheme = c.scheme == "https" ? "wss" : "ws"
        c.path = "/v1/session"
        if let ws = c.string { defaults.set(ws, forKey: "genita.server.url") }
    }
    #endif
}
