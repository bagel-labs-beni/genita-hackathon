import AppKit
import SwiftUI
import Foundation

/// F9 · #118 · The Mac call client: who is signed in, which companion the account has, and when the shared
/// `CallController` (the same session, mic, playback and barge-in as the iPhone) runs on this Mac.
///
/// - The call runs while this Mac holds the conversation (`MacHandoff.ownership`): the iPhone moving here
///   (touch, button, or Continue on this Mac) starts or resumes it; the conversation leaving suspends it
///   (`MacHandoff.ownerChanged` already stops sharing, media and sound first — #2/#147, unchanged).
/// - Account: the session JWT GenitaKit keeps in the keychain (MAC-1 web sign-in, `/auth/exchange`).
///   Local/debug runs can use the dev token instead (`GENITA_SESSION_TOKEN`, as the call client does).
/// - Companion: `GET /v1/companion` (name, persona, profile, face) — the Mac has no onboarding of its own.
@MainActor final class MacCall: ObservableObject {
    static let shared = MacCall()

    enum Account: Equatable {
        case checking
        /// MAC-1
        case signedOut
        case signingIn
        /// server unreachable or an unexpected answer; `refresh()` again
        case offline(String)
        /// MAC-2: no consent or no companion yet ("Set up on iPhone")
        case noCompanion
        case ready(CompanionCallPlan)
    }

    @Published private(set) var account: Account = .checking
    /// The companion's scene picture from the server (prep `sceneUrl`), shown as the face until the
    /// Muse Image face layer (#151/#152, lane L4) replaces the still.
    @Published private(set) var face: NSImage?
    let call = CallController.shared
    let auth = GenitaAuthClient()
    private var signIn: WebSignIn?
    private var wantsCall = false

    var companionName: String? { if case let .ready(plan) = account { return plan.name } else { return nil } }

    init() {
        // The call socket and /v1/watch use the same host as the accounts API (deployed server by default).
        UserDefaults.standard.register(defaults: ["genita.server.url": Self.sessionURL(api: auth.baseURL).absoluteString])
    }

    static func sessionURL(api: URL) -> URL {
        var c = URLComponents(url: api, resolvingAgainstBaseURL: false) ?? URLComponents()
        c.scheme = c.scheme == "http" ? "ws" : "wss"
        c.path = "/v1/session"
        c.query = nil
        return c.url ?? URL(string: "wss://d72kt0jfmscyj.cloudfront.net/v1/session")!
    }

    // MARK: account

    /// /me → StartRouter (Mac) → /v1/companion. Safe to call again (sign-in, wake, retry).
    func refresh() async {
        if account != .signingIn { account = .checking }
        guard let token = CallEndpoint.current().token, !token.isEmpty else { account = .signedOut; return }
        do {
            let me: GenitaMe = try await get("/me", token: token)
            switch StartRouter.route(.active(me), device: .mac) {
            case .macNoCompanion: account = .noCompanion; return
            default: break
            }
            let data = try await getData("/v1/companion", token: token)
            guard let plan = CompanionCallPlan(companionJSON: data) else { account = .noCompanion; return }
            account = .ready(plan)
            call.companionName = plan.name
            loadFace(plan, token: token)
            if wantsCall { startCall() }
        } catch MacCallError.status(401) {
            account = .signedOut
        } catch MacCallError.status(404) {
            account = .noCompanion
        } catch {
            account = .offline((error as? MacCallError)?.message ?? "Can’t reach Genita")
        }
    }

    /// MAC-1 · Sign in with Apple on the web (Developer ID apps can't use the native sheet).
    func signInWithApple() {
        guard let anchor = NSApp.keyWindow ?? NSApp.windows.first else { return }
        let flow = WebSignIn(anchor: anchor)
        signIn = flow
        account = .signingIn
        Task {
            do {
                try await flow.signIn(client: auth, device: .mac)
                await refresh()
            } catch GenitaAuthError.cancelled {
                account = .signedOut
            } catch {
                account = .offline("Sign in didn’t finish. Try again.")
            }
            signIn = nil
        }
    }

    func signOut() {
        call.end()
        Task { await auth.logout(); account = .signedOut; face = nil }
    }

    // MARK: the call follows the conversation

    /// The conversation is on this Mac now (ownership → mac).
    func conversationArrived() {
        wantsCall = true
        switch account {
        case .ready: startCall()
        case .checking, .signingIn: break // refresh() starts it when the account is known
        default: Task { await refresh() }
        }
    }

    /// The conversation left this Mac. MacHandoff already suspended the call (mic, camera, sound off, barge-in
    /// sent); the socket stays so coming back is instant.
    func conversationLeft() { wantsCall = false }

    private func startCall() {
        guard case let .ready(plan) = account else { return }
        call.companionName = plan.name
        call.begin(plan.start)
        // B12: the mic comes back the way the user left it.
        if Self.micRemembered, !call.micOn { call.toggleMic() }
    }

    static var micRemembered: Bool {
        get { UserDefaults.standard.bool(forKey: "genita.mac.micOn") }
        set { UserDefaults.standard.set(newValue, forKey: "genita.mac.micOn") }
    }

    // MARK: HTTP (same bearer as the call socket)

    enum MacCallError: Error {
        case status(Int)
        case decode
        var message: String { if case let .status(code) = self { return "Genita answered \(code)" } else { return "Unexpected answer from Genita" } }
    }

    private func getData(_ path: String, token: String) async throws -> Data {
        var req = URLRequest(url: auth.baseURL.appendingPathComponent(String(path.dropFirst())))
        req.timeoutInterval = 15
        req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        #if DEBUG
        // dev token runs: the server keys the user by this header (genita-server auth/accounts.ts)
        if let user = ProcessInfo.processInfo.environment["GENITA_DEV_USER"] { req.setValue(user, forHTTPHeaderField: "x-genita-user") }
        #endif
        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw MacCallError.status(status) }
        return data
    }

    private func get<T: Decodable>(_ path: String, token: String) async throws -> T {
        do { return try JSONDecoder().decode(T.self, from: try await getData(path, token: token)) } catch let e as MacCallError { throw e } catch is DecodingError { throw MacCallError.decode }
    }

    private func loadFace(_ plan: CompanionCallPlan, token: String) {
        guard let url = plan.faceURL(base: auth.baseURL) else { return }
        Task {
            var req = URLRequest(url: url)
            if url.host == auth.baseURL.host { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
            guard let (data, response) = try? await URLSession.shared.data(for: req), (response as? HTTPURLResponse)?.statusCode == 200,
                  let image = NSImage(data: data) else { return }
            face = image
        }
    }
}

/// MAC-1 / MAC-2 on the Mac's control window: the account the call uses.
struct MacAccountRow: View {
    @ObservedObject private var call = MacCall.shared
    var body: some View {
        Group {
            switch call.account {
            case .checking: ProgressView().controlSize(.small)
            case .signingIn: Text("Finish signing in in the window that opened.").foregroundStyle(.secondary)
            case .signedOut:
                Button { call.signInWithApple() } label: { Label("Sign in with Apple", systemImage: "apple.logo") }
                    .buttonStyle(.borderedProminent).tint(.black).accessibilityIdentifier("macSignIn")
            case .offline(let reason):
                HStack { Text(reason).foregroundStyle(.secondary); Button("Try again") { Task { await call.refresh() } } }
            case .noCompanion: Text("Set up Genita on your iPhone first.").foregroundStyle(.secondary)
            case .ready(let plan):
                HStack(spacing: 8) {
                    Text("Calling with \(plan.name)").foregroundStyle(.secondary)
                    Button("Sign out") { call.signOut() }.buttonStyle(.link)
                }
            }
        }
        .font(.callout)
        .task { if call.account == .checking { await call.refresh() } }
    }
}
