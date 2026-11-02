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
        /// CS01: signed in (Apple or Judge access), AI-data consent not given yet
        case needsConsent
        /// MAC-2: no companion yet ("Set up on iPhone")
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
    /// Bumped on sign-out: answers to requests started before it are dropped (no call with an old token).
    private var generation = 0
    /// This Mac's turns, kept when the conversation moves away so coming back resumes it.
    private var history: [ClientMessage.HistoryItem] = []

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
        let gen = generation
        if account != .signingIn { account = .checking }
        guard let token = CallEndpoint.current().token, !token.isEmpty else { account = .signedOut; return }
        let next: Account
        var plan: CompanionCallPlan?
        do {
            let me: GenitaMe = try await get("/me", token: token)
            if !me.consented {
                next = .needsConsent
            } else if StartRouter.route(.active(me), device: .mac) == .macNoCompanion {
                next = .noCompanion
            } else if let p = CompanionCallPlan(companionJSON: try await getData("/v1/companion", token: token)) {
                plan = p; next = .ready(p)
            } else { next = .noCompanion }
        } catch MacCallError.status(401) {
            next = .signedOut
        } catch MacCallError.status(404) {
            next = .noCompanion
        } catch {
            next = .offline((error as? MacCallError)?.message ?? "Can’t reach Genita")
        }
        guard gen == generation else { return } // signed out meanwhile
        account = next
        guard let plan else { return }
        call.companionName = plan.name
        loadFace(plan, token: token, generation: gen)
        if wantsCall { startCall() }
    }

    /// MAC-1 · Sign in with Apple on the web (Developer ID apps can't use the native sheet).
    func signInWithApple() {
        guard let anchor = NSApp.keyWindow ?? NSApp.windows.first else { return }
        let flow = WebSignIn(anchor: anchor)
        signIn = flow
        account = .signingIn
        let gen = generation
        Task {
            do {
                try await flow.signIn(client: auth, device: .mac)
                // signed out while the browser sheet was open: drop the session GenitaKit just stored
                guard gen == generation else { auth.store.clear(); return }
                await refresh()
            } catch GenitaAuthError.cancelled {
                account = .signedOut
            } catch {
                account = .offline("Sign in didn’t finish. Try again.")
            }
            signIn = nil
        }
    }

    /// A02-J · Judge access: a code from the submission form instead of an Apple ID. nil = signed in.
    func signInWithJudgeCode(_ code: String) async -> String? {
        let gen = generation
        guard let req = JudgeAccess.request(code: code, base: auth.baseURL) else { return JudgeAccess.message(status: 401) }
        guard let (data, response) = try? await URLSession.shared.data(for: req) else { return JudgeAccess.message(status: nil) }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if let message = JudgeAccess.message(status: status) { return message }
        guard let signedIn = try? JSONDecoder().decode(GenitaSignInResponse.self, from: data) else { return JudgeAccess.message(status: 500) }
        // a sign-out (or another sign-in) happened while this was on its way: don't bring this session back
        guard gen == generation else { return nil }
        generation += 1
        auth.store.save(signedIn.token)
        await refresh()
        return nil
    }

    /// CS01 · Agree and continue → POST /me/consent → on to the call (or MAC-2).
    func consent() async -> Bool {
        let gen = generation
        do {
            try await auth.consent()
            if gen == generation { await refresh() }
            return true
        } catch GenitaAuthError.unauthorized {
            // the session expired or was revoked (GenitaKit already cleared it): back to A02
            if gen == generation { generation += 1; account = .signedOut; face = nil; history = [] }
            return true
        } catch { return false }
    }

    func signOut() {
        generation += 1
        account = .signedOut
        face = nil
        history = []
        call.end()
        // Clear now and revoke exactly this token, so a sign-in right after can't be undone by a slow logout.
        let old = auth.store.load()
        auth.store.clear()
        guard let old else { return }
        var req = URLRequest(url: auth.baseURL.appendingPathComponent("auth/logout"))
        req.httpMethod = "POST"
        req.timeoutInterval = 15
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.setValue("Bearer \(old)", forHTTPHeaderField: "authorization")
        req.httpBody = Data("{}".utf8)
        Task.detached { _ = try? await URLSession.shared.data(for: req) }
    }

    /// The server closed the call for a reason reconnecting can't fix (4401 / 4403 / 4001).
    func callStopped(_ stop: CallStop) {
        call.end()
        switch stop {
        case .signIn:
            generation += 1
            history = []
            auth.store.clear()
            account = .signedOut
            face = nil
        case .consent:
            account = .needsConsent
        case .timeLimit:
            break
        }
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

    /// The conversation left this Mac. MacHandoff already suspended it (mic, camera, sound off, barge-in sent);
    /// the session is closed too, so nothing that was still on its way (a greeting, a late reply) can play here
    /// while the iPhone talks. Coming back opens a new session.
    func conversationLeft() {
        wantsCall = false
        if !call.historySnapshot.isEmpty { history = call.historySnapshot }
        call.end()
    }

    private func startCall() {
        guard case let .ready(plan) = account else { return }
        call.companionName = plan.name
        var start = plan.start
        start.history = history.isEmpty ? nil : Array(history.suffix(20))
        call.begin(start)
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
        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw MacCallError.status(status) }
        return data
    }

    private func get<T: Decodable>(_ path: String, token: String) async throws -> T {
        do { return try JSONDecoder().decode(T.self, from: try await getData(path, token: token)) } catch let e as MacCallError { throw e } catch is DecodingError { throw MacCallError.decode }
    }

    private func loadFace(_ plan: CompanionCallPlan, token: String, generation gen: Int) {
        guard let url = plan.faceURL(base: auth.baseURL) else { return }
        Task {
            var req = URLRequest(url: url)
            if url.host == auth.baseURL.host { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
            guard let (data, response) = try? await URLSession.shared.data(for: req), (response as? HTTPURLResponse)?.statusCode == 200,
                  let image = NSImage(data: data), gen == generation else { return }
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
            case .needsConsent: Text("Agree to the AI data terms to continue.").foregroundStyle(.secondary)
            case .ready(let plan):
                HStack(spacing: 8) {
                    Text("Calling with \(plan.name)").foregroundStyle(.secondary)
                    Button("Sign out") { call.signOut() }.buttonStyle(.link)
                }
            }
        }
        .font(.callout)
        .task { if call.account == .checking { await call.refresh() } }
        // 4401 → MAC-1, 4403 → MAC-2 (the control window is always there, so this sees every stop)
        .onChange(of: CallController.shared.stopped) { _, stop in if let stop { call.callStopped(stop) } }
    }
}
