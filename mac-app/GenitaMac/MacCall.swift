import AppKit
import SwiftUI
import Foundation
import Observation

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

    @Published private(set) var account: Account = .checking {
        // Mac v2 Settings: never show the previous account's address once its session is gone (Codex review)
        didSet { if account == .signedOut || account == .signingIn { accountLabel = nil } }
    }
    /// MAC-1's footnote line after a sign-in that didn't finish (stays on MAC-1, never the home's offline state).
    @Published private(set) var signInMessage: String?
    /// Genita ▸ Sign Out is on while an account is signed in on this Mac.
    var isSignedIn: Bool {
        switch account { case .checking, .signedOut, .signingIn: false; default: true }
    }
    /// The companion's scene picture from the server (prep `sceneUrl`), shown as the face until the
    /// Muse Image face layer (#151/#152, lane L4) replaces the still.
    @Published private(set) var face: NSImage?
    /// Mac v2 Settings' Account row: the signed-in address (Apple's relay address included), else the provider.
    @Published private(set) var accountLabel: String?
    #if DEBUG
    /// watch-shots review renders only
    func reviewAccountLabel(_ label: String) { accountLabel = label }
    #endif
    let call = CallController.shared
    let auth = GenitaAuthClient()
    private var signIn: WebSignIn?
    private var wantsCall = false
    /// Bumped on sign-out: answers to requests started before it are dropped (no call with an old token).
    private var generation = 0
    private var handoffAccountID: String?
    /// This Mac's turns, kept when the conversation moves away so coming back resumes it.
    private var history: [ClientMessage.HistoryItem] = []

    var companionName: String? { if case let .ready(plan) = account { return plan.name } else { return nil } }

    init() {
        // The call socket and /v1/watch use the same host as the accounts API (deployed server by default).
        UserDefaults.standard.register(defaults: ["genita.server.url": Self.sessionURL(api: auth.baseURL).absoluteString])
        watchStops()
        watchLock()
    }

    /// AU-86: 4401 → MAC-1, 4403 → CS01, 4001 → ended. Watched here, not in a window: the home window can be closed
    /// while the call runs (#511), and a stop it never saw left the call dead (begin() refused until end()).
    private func watchStops() {
        withObservationTracking { _ = call.stopped } onChange: { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                if let stop = self.call.stopped, !self.call.isEnded { self.callStopped(stop) }
                self.watchStops()
            }
        }
    }

    /// AU-55 / IC-02 step 4 on the Mac: locking the screen or sleeping pauses the call like Home on the iPhone (mic,
    /// camera and sound off; back within the grace the same call goes on, past it the call hangs up with `stop`).
    /// Unlocking after a hang-up calls again while the conversation is still on this Mac.
    private func watchLock() {
        let distributed = DistributedNotificationCenter.default()
        let workspace = NSWorkspace.shared.notificationCenter
        lockObservers = [
            distributed.addObserver(forName: .init("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.away(locked: true) }
            },
            distributed.addObserver(forName: .init("com.apple.screenIsUnlocked"), object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.back(locked: true) }
            },
            workspace.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.away(locked: false) }
            },
            // waking is not unlocking: a Mac that asks for the password stays paused until screenIsUnlocked (Codex P1)
            workspace.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.back(locked: false) }
            },
        ]
    }
    private var lockObservers: [NSObjectProtocol] = []
    private var screenLocked = false
    private var asleep = false
    /// Locked or asleep: no call runs, starts or resumes (a move that lands now starts the call on return).
    private var screenAwayNow: Bool { screenLocked || asleep }

    private func away(locked: Bool) {
        if locked { screenLocked = true } else { asleep = true }
        guard !call.isEnded else { return }
        call.sceneActivityChanged(.background)
    }

    private func back(locked: Bool) {
        let wasAway = screenAwayNow
        if locked { screenLocked = false } else { asleep = false }
        guard wasAway, !screenAwayNow else { return }
        call.sceneActivityChanged(.active)
        if call.isEnded, call.stopped == nil, wantsCall, MacHandoff.shared.ownership.isOwner { startCall() }
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
        // keep the screen on view until the answer is in (only the first launch shows the empty window);
        // the 10 s re-check on MAC-2 must not blink the window
        guard let token = CallEndpoint.current().token, !token.isEmpty else { generation += 1; account = .signedOut; useHandoffAccount(nil); return }
        let next: Account
        var accountID: String?
        var plan: CompanionCallPlan?
        do {
            let me: GenitaMe = try await get("/me", token: token)
            accountID = me.user.id
            if gen == generation { accountLabel = me.user.email ?? me.user.displayName ?? (me.user.provider == "apple" ? "Apple ID" : me.user.provider.capitalized) }
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
            next = .offline((error as? MacCallError)?.message ?? "Check your connection and try again.")
        }
        guard gen == generation else { return } // signed out meanwhile
        account = next
        if next == .signedOut { generation += 1; useHandoffAccount(nil) }
        else if let accountID { useHandoffAccount(accountID) }
        guard let plan else { return }
        call.companionName = plan.name
        loadFace(plan, token: token, generation: gen)
        // same presence: the animated face set is ready before the conversation moves here (no still on arrival)
        call.prepareFace(reduceMotion: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)
        if wantsCall { startCall() }
    }

    /// MAC-1 · Sign in with Apple on the web (Developer ID apps can't use the native sheet).
    func signInWithApple() {
        guard let anchor = NSApp.keyWindow ?? NSApp.windows.first else { return }
        let flow = WebSignIn(anchor: anchor)
        signIn = flow
        account = .signingIn
        signInMessage = nil
        let gen = generation
        Task {
            do {
                let client = GenitaAuthClient(baseURL: auth.baseURL, store: InMemoryTokenStore())
                let signedIn = try await flow.signIn(client: client, device: .mac)
                guard gen == generation else { return }
                generation += 1
                useHandoffAccount(nil)
                auth.store.save(signedIn.token)
                await refresh()
            } catch GenitaAuthError.cancelled {
                guard gen == generation else { return }
                account = .signedOut
            } catch {
                guard gen == generation else { return }
                account = .signedOut
                signInMessage = "Sign in didn’t finish. Try again."
            }
            signIn = nil
        }
    }

    /// A02-M · Continue with email, step 1: the server mails a 6-digit code. nil = sent (wait `resendAfterSec`), else the line to show.
    func startEmailSignIn(_ email: String) async -> (message: String?, resendAfterSec: Int) {
        do { return (nil, try await auth.startEmailSignIn(email: email).resendAfterSec) } catch { return (EmailSignInCopy.message(for: error, sendingCode: true), 0) }
    }

    /// A02-M · step 2: the code → the same session as Apple. nil = signed in, else the line to show.
    func signInWithEmail(_ email: String, code: String) async -> String? {
        let gen = generation
        // a scratch store: the token reaches the keychain only if no sign-out (or other sign-in) happened meanwhile
        let client = GenitaAuthClient(baseURL: auth.baseURL, store: InMemoryTokenStore())
        let signedIn: GenitaSignInResponse
        do { signedIn = try await client.signInWithEmailCode(email: email, code: code, device: .mac) } catch { return EmailSignInCopy.message(for: error, sendingCode: false) }
        guard gen == generation else { return nil }
        generation += 1
        useHandoffAccount(nil)
        auth.store.save(signedIn.token)
        await refresh()
        return nil
    }

    /// A02-J · Judge access: a code from the submission form instead of an Apple ID. nil = signed in.
    func signInWithJudgeCode(_ code: String) async -> String? {
        let gen = generation
        guard let req = JudgeAccess.request(code: code, base: auth.baseURL) else { return JudgeAccess.message(status: 401) }
        guard let (data, response) = try? await URLSession.shared.data(for: req) else { return JudgeAccess.message(status: nil) }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let wait = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Retry-After").flatMap { Int($0) }
        if let message = JudgeAccess.message(status: status, retryAfterSec: wait) { return message }
        guard let signedIn = try? JSONDecoder().decode(GenitaSignInResponse.self, from: data) else { return JudgeAccess.message(status: 500) }
        // a sign-out (or another sign-in) happened while this was on its way: don't bring this session back
        guard gen == generation else { return nil }
        generation += 1
        useHandoffAccount(nil)
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
            if gen == generation { generation += 1; account = .signedOut; useHandoffAccount(nil) }
            return true
        } catch { return false }
    }

    func signOut() {
        generation += 1
        MacHandoff.shared.sharing.resetForSignOut()
        useHandoffAccount(nil)
        account = .signedOut
        face = nil
        accountLabel = nil
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
            useHandoffAccount(nil)
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

    /// Only a verified /me user can activate handoff; no old call intent crosses accounts.
    private func useHandoffAccount(_ accountID: String?) {
        let changed = handoffAccountID != accountID
        if changed || accountID == nil {
            wantsCall = false; history = []; face = nil
            call.end()
        }
        handoffAccountID = accountID
        MacHandoff.shared.setAccount(accountID)
        if changed, accountID != nil {
            wantsCall = MacHandoff.shared.ownership.isOwner && MacHandoff.shared.ownership.state.epoch > 0
        }
    }

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
        guard !screenAwayNow else { return }   // back(locked:) starts it once the Mac is unlocked
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
        var message: String { "Genita isn’t answering right now. Try again in a moment." }
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
        .font(.custom("PretendardVariable-Regular", fixedSize: 13)) // Figma: Pretendard everywhere but the serif titles
        .task { if call.account == .checking { await call.refresh() } }
    }
}
