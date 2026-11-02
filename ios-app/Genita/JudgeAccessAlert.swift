import SwiftUI

/// A02-J · Judge access (PRD v12 D41): the stock iOS alert with a text field, no new design. The code comes
/// from the submission form / README; the server answers with a session for that code's demo account, then
/// the usual CS01 consent applies. A failure is a second stock alert (wrong code / too many tries / offline).
struct JudgeAccessAlert: ViewModifier {
    @Bindable var model: AppState
    @Binding var isPresented: Bool
    @State private var code = ""
    @State private var sending = false
    @State private var failure: Failure?
    #if DEBUG
    /// Simulator / Mac debug runs: point the app at a server on this machine (README "Run locally").
    @State private var serverURL = UserDefaults.standard.string(forKey: "genita.api.url") ?? ""
    #endif

    struct Failure: Equatable {
        var title: String
        var message: String
    }

    func body(content: Content) -> some View {
        content
            .alert("Judge access", isPresented: $isPresented) {
                TextField("Code", text: $code)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityIdentifier("judgeCodeField")
                #if DEBUG
                TextField("Server URL (debug)", text: $serverURL)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    .accessibilityIdentifier("judgeServerField")
                #endif
                Button("Continue") { submit() }
                    .disabled(code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Enter the code from the submission form. No Apple ID needed.")
            }
            .alert(failure?.title ?? "", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } }), presenting: failure) { _ in
                Button("Try Again") { isPresented = true }
                Button("Cancel", role: .cancel) {}
            } message: { f in
                Text(f.message)
            }
    }

    private func submit() {
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sending, !trimmed.isEmpty else { return }
        sending = true
        #if DEBUG
        Self.applyDebugServer(serverURL)
        #endif
        Task { @MainActor in
            defer { sending = false }
            do {
                let r = try await GenitaAuthClient().signInWithJudgeCode(trimmed)
                code = ""
                model.signedIn(userId: r.me.user.id, consented: r.me.consented)
            } catch GenitaAuthError.unauthorized {
                failure = Failure(title: "Code Not Accepted", message: "Check the code and try again.")
            } catch GenitaAuthError.server(let status, _) where status == 429 {
                failure = Failure(title: "Too Many Tries", message: "Wait 10 minutes and try again.")
            } catch GenitaAuthError.offline {
                failure = Failure(title: "Can’t Reach the Server", message: "Check your connection and try again.")
            } catch {
                failure = Failure(title: "Judge Access Unavailable", message: "Try again in a few minutes.")
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

extension View {
    /// A02-J Judge access (D41): stock alert with a code field.
    func judgeAccessAlert(isPresented: Binding<Bool>, model: AppState) -> some View {
        modifier(JudgeAccessAlert(model: model, isPresented: isPresented))
    }
}
