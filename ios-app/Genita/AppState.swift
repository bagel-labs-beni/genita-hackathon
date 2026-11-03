import Foundation
import Observation

enum Stage: String, Codable, CaseIterable {
    case welcome, signIn, name, prompt, paste, preparing, preferences, image, voice
    case depth, help, relationship, challenge, tempo, initiative, boundaries, presence, summary, connecting, conversation
    /// CS01 AI data consent (F1-L8): after the first sign-in, or when the call closes 4403
    case consent
    /// V03 analyzing → V02-T passed with type / V02-F failed with reasons (F3)
    case imageCheck
    /// NM01 "Give them a name." (D21): after V04, before D01
    case companionName
    /// PREP-1 "Bringing {name} to life" (D38): after SUM, before S07
    case bringing
    /// N1–N3: the I01 "I don’t use an AI assistant" path (D33, D44)
    case skipTopics, skipReplies, skipAvoid
}
enum SetupDepth: String, Codable, CaseIterable { case quick, right, deep
    var title: String { switch self { case .quick: "Quick start"; case .right: "Make it feel right"; case .deep: "Deep setup" } }
    var detail: String { switch self { case .quick: "About 3 minutes"; case .right: "About 8 minutes · recommended"; case .deep: "About 15 minutes" } }
    var path: [Stage] {
        switch self {
        case .quick: [.depth, .help, .relationship, .presence, .summary]
        case .right: [.depth, .help, .relationship, .challenge, .tempo, .presence, .summary]
        case .deep: [.depth, .help, .relationship, .challenge, .tempo, .initiative, .boundaries, .presence, .summary]
        }
    }
}
struct SavedSetup: Codable {
    var stage: Stage = .welcome
    var name = ""
    var response = ""
    var depth: SetupDepth = .right
    var voice: Int?
    var answers: [String: String] = [:]
    var boundaries: Set<String> = []
    var presence: Set<String> = []
    var presenceCardIDs: Set<String>? = nil
    var imageData: Data?
    var hasOnboarded = false
    // Server wiring (11/2 L2). Optional so older saved setups still decode.
    /// NM01: the companion's name, used everywhere as {name} (never a hard-coded "Jin")
    var companionName: String?
    /// The server-checked image (`POST /v1/companion/image`) and its type (human | animal | character)
    var imageId: String?
    var imageType: String?
    /// I04's six rows and the profile text the call sends as `start.user.profile` (the pasted reply stays on device)
    var styleRows: [StyleRow]?
    var styleProfile: String?
    var stylePartial: Bool?
    /// The companion exists on the server (prep started at "Use this image", D28)
    var companionCreated: Bool?
    /// The companion voice picked on V04 (server speaker id, saved on the companion with PUT /v1/companion/voice)
    var voiceId: String?
    var voiceName: String?
    /// The silent offline fallback for calls the server can't voice (an installed en-US voice; never shown in V04)
    var deviceVoice: String?
    /// N1–N3 answers
    var skipInterests: [String]?
    var skipReplies: String?
    var skipAvoid: [String]?
    /// N3 taste picker (Figma 144:2): tapped once = liked (here), tapped twice = avoided (`skipAvoid`)
    var skipLikes: [String]?
    /// The first call after onboarding waits up to 2 s for the user to speak first (D21, `start.greetAfterMs`)
    var firstCallPending: Bool?
    /// The persona card the server wrote from the setup answers (`POST /v1/companion/prefs` → session.persona)
    var serverPersona: ClientMessage.Persona?
    /// The account this setup belongs to (`/me` user id). Another account on this phone starts clean.
    var accountId: String?
    /// The judge account's ready-made companion (server `demo: true`), labelled "Demo companion"
    var companionDemo: Bool?
    enum CodingKeys: String, CodingKey { case stage, name, response, depth, voice, answers, boundaries, presence, presenceCardIDs, hasOnboarded,
        companionName, imageId, imageType, styleRows, styleProfile, stylePartial, companionCreated, voiceId, voiceName, deviceVoice, skipInterests, skipReplies, skipAvoid, skipLikes, firstCallPending, serverPersona, accountId, companionDemo }

}
/// A launch response belongs to the token and authentication lifetime that requested it.
struct LaunchAuthSnapshot: Equatable, Sendable {
    let token: String?
    let generation: Int

    func accepts(_ current: LaunchAuthSnapshot) -> Bool { token != nil && self == current }
}

@MainActor @Observable final class AppState {
    var setup: SavedSetup { didSet { if oldValue.imageData != setup.imageData { saveImage() }; save() } }
    var history: [Stage] = []
    var settingsOpen = false
    var menuOpen = false
    // Onboarding on the server (OnboardingFlow.swift). Transient: not saved.
    var importing = false
    /// I02-E line ("I couldn't read this one…"); the pasted text stays
    var importError: String?
    /// I01 → ChatGPT / Claude → back: I02 opens with the paste button focused (transient)
    var pasteFocusRequested = false
    var checkingImage = false
    var imageCheck: ImageCheck?
    /// V01 "I have the right to use this image" (D26 / SUB-8): off for every new image, must be on to check it. Transient.
    var rightsAcked = false
    var imageCheckError: String?
    /// Photo polish (V03 → V02-T confirm): the polished result, its bytes, the wait, and an error line. Transient.
    var polished: PolishedImage?
    var polishedImage: Data?
    var polishing = false
    var polishError: String?
    /// "Try again" left for this upload (server: first polish + two retries); polishAttempts = polish calls made for it
    var polishRetriesLeft = 0
    var polishAttempts = 0
    var creatingCompanion = false
    var suggestingName = false
    var savingName = false
    var savingVoice = false
    /// V04's PUT did not reach the server; NM01 tries once more before the name goes up
    var voiceUnsaved = false
    var nameError: String?
    var savingPrefs = false
    var setupSummary: SetupSummary?
    var prep: PrepProgress?
    /// NM01-0 "Use {name}": the server's suggestion, kept after the field is cleared
    var suggestedCompanionName: String?
    /// PREP-1e Try again in flight
    var retryingPrep = false
    /// PREP-1e: the one line under the buttons when Try again itself failed
    var prepError: String?
    /// PREP-1: the server's call scene (not saved; the call uses the uploaded photo until the face set lands),
    /// keyed by account + scene URL so another account's face never shows (see `sceneKey`).
    var sceneImage: (key: String, data: Data)?
    var sceneKey: String? { prep?.sceneURL.map { "\(setup.accountId ?? "-")|\($0.absoluteString)" } }
    var sceneImageData: Data? { sceneImage.flatMap { $0.key == sceneKey ? $0.data : nil } }
    /// A02-E-style one-line error for any onboarding call (offline, server)
    var flowError: String?
    /// D47 HISY v2 cards (I03 → HISY-0 … HISY-7, N1–N3 → S0 … S4). Transient: after a relaunch they're read
    /// again (`GET /v1/profile/story`).
    var story: [StoryCard]?
    /// import | skip — which opener (HISY-0 or S0) and copy the cards get
    var storySource: String?
    var storyLoading = false
    /// no story could be had: HISY-0 "Show me" goes straight to HISY-7
    var storyFailed = false
    /// C3: the texts the last correction made new, by card id (drawn with the blue border)
    var storyChanged: [String: [String]] = [:]
    /// HISY page: 0 = opener (HISY-0 / S0), 1…n = the cards, n + 1 = HISY-7 "Now give me a face."
    var hisyPage = 0
    @ObservationIgnored var importTask: Task<Void, Never>?
    @ObservationIgnored var companionTask: Task<Void, Never>?
    @ObservationIgnored var imageCheckTask: Task<Void, Never>?
    @ObservationIgnored var imageCheckTicket: UUID?
    /// Changes whenever sign-in state changes, so old account responses cannot affect the new account.
    @ObservationIgnored private var onboardingSession = OnboardingSessionGeneration()
    /// After a sign-in, where to go is asked from the server (`/me`): a returning account gets its companion back
    /// and goes to the call instead of A03. nil = `routeOnLaunch()`; tests swap it.
    @ObservationIgnored var routeAfterSignIn: (() async -> Void)?
    @ObservationIgnored private(set) var signInRouting: Task<Void, Never>?
    /// Bumped on every sign-in and sign-out: server answers asked under an older value are dropped.
    @ObservationIgnored private(set) var authGeneration = 0
    @ObservationIgnored var onboarding = OnboardingClient()
    var launchAuthSnapshot: LaunchAuthSnapshot { LaunchAuthSnapshot(token: onboarding.auth.token, generation: authGeneration) }
    var storage: UserDefaults
    @ObservationIgnored private let onHandoffAccountChange: ((String?) -> Void)?
    let imageURL: URL
    nonisolated static var defaultImageURL: URL { URL.applicationSupportDirectory.appending(path: "Genita/companion.jpg") }

    static let storageKey = "genita.native.setup.v1"
    /// I01's prompt. One source: the repo's prompt v3 (docs/profile-import/prompt-v3.txt), bundled as
    /// Resources/import-prompt.txt and byte-identical to what the server serves at GET /v1/import/prompt
    /// (genita-server test "import prompt copies are identical").
    static let prompt: String = Bundle.main.url(forResource: "import-prompt", withExtension: "txt")
        .flatMap { try? String(contentsOf: $0, encoding: .utf8) }?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    init(storage: UserDefaults = .standard, reset: Bool = false, imageURL: URL = AppState.defaultImageURL, onHandoffAccountChange: ((String?) -> Void)? = nil) {
        self.storage = storage
        self.onHandoffAccountChange = onHandoffAccountChange
        self.imageURL = imageURL
        if reset { storage.removeObject(forKey: Self.storageKey); storage.removeObject(forKey: Self.signedOutKey); try? FileManager.default.removeItem(at: imageURL) }
        if let data = storage.data(forKey: Self.storageKey), let saved = try? JSONDecoder().decode(SavedSetup.self, from: data) { setup = saved } else { setup = SavedSetup() }
        setup.imageData = try? Data(contentsOf: imageURL)
        // auth state first (a restart must not skip a pending A02 / CS01 by restoring the call)
        if storage.bool(forKey: Self.signedOutKey) { setup.stage = .signIn }
        else if storage.bool(forKey: Self.needsConsentKey) { setup.stage = .consent }
        else if setup.hasOnboarded { setup.stage = .conversation }
        else if setup.stage == .preparing { setup.stage = .paste }
        else if setup.stage == .imageCheck { setup.stage = .image }
        else if setup.stage == .connecting { setup.stage = setup.companionCreated == true ? .bringing : .summary }
        #if DEBUG
        // UI tests against ios-app/Tools/onboarding-stub: a signed-in session without the keychain (unsigned CI builds)
        if ProcessInfo.processInfo.arguments.contains("--stub-signin") {
            onboarding = OnboardingClient(auth: GenitaAuthClient(store: InMemoryTokenStore("stub-token")))
        }
        if let raw = ProcessInfo.processInfo.environment["GENITA_REVIEW_STAGE"], let reviewStage = Stage(rawValue: raw) {
            applyReviewFixture(stage: reviewStage, variant: ProcessInfo.processInfo.environment["GENITA_REVIEW_VARIANT"] ?? "")
        }
        #endif
    }
    var stage: Stage { setup.stage }
    /// {name} everywhere: what NM01 saved (or the server renamed in a call, `companion.named`). Never a hard-coded "Jin".
    var companionDisplayName: String {
        let n = CompanionName.clean(setup.companionName ?? "")
        return n.isEmpty ? "your companion" : n
    }
    var validResponse: Bool { !setup.response.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    var validName: Bool { !setup.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private func saveImage() {
        guard let data = setup.imageData else { try? FileManager.default.removeItem(at: imageURL); return }
        try? FileManager.default.createDirectory(at: imageURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: imageURL, options: [.atomic, .completeFileProtection])
    }
    func save() { if let data = try? JSONEncoder().encode(setup) { storage.set(data, forKey: Self.storageKey) } }
    func go(_ stage: Stage) {
        // D01 default follows the import path chosen at I01 (set when the path starts, never when an answer arrives):
        // skippers (N1–N3) start on Quick start, people who paste an AI profile on Make it feel right.
        if stage == .skipTopics { setup.depth = .quick } else if stage == .paste { setup.depth = .right }
        // The processing screen is transient: back from the next screen must not replay it.
        if setup.stage == .preparing { if stage != .preferences { history.append(.preferences) } }
        else { history.append(setup.stage) }
        setup.stage = stage
    }
    func back() {
        if let previous = history.popLast() { setup.stage = previous; return }
        let fallback: [Stage: Stage] = [.signIn: .welcome, .name: .signIn, .prompt: .name, .paste: .prompt, .preferences: .paste, .image: .preferences,
                                        .imageCheck: .image, .voice: .image, .companionName: .voice, .depth: .companionName, .bringing: .summary,
                                        .skipTopics: .prompt, .skipReplies: .skipTopics, .skipAvoid: .skipReplies]
        if let previous = fallback[stage] { setup.stage = previous }
        else if let i = setup.depth.path.firstIndex(of: stage), i > 0 { setup.stage = setup.depth.path[i - 1] }
    }
    static let signedOutKey = "genita.signedOut"
    static let needsConsentKey = "genita.needsConsent"
    static let userKey = "genita.userId"
    func onboardingSnapshot() -> OnboardingSessionGeneration.Snapshot {
        onboardingSession.snapshot(token: onboarding.auth.token)
    }
    func ownsOnboardingResponse(_ snapshot: OnboardingSessionGeneration.Snapshot, allowingClearedSession: Bool = false) -> Bool {
        onboardingSession.isCurrent(snapshot, token: onboarding.auth.token, allowingClearedSession: allowingClearedSession)
    }
    private func invalidateOnboardingWork() {
        onboardingSession.invalidate()
        importTask?.cancel(); importTask = nil
        companionTask?.cancel(); companionTask = nil
        imageCheckTask?.cancel(); imageCheckTask = nil; imageCheckTicket = nil
        importing = false; creatingCompanion = false; checkingImage = false; polishing = false
    }
    /// CS01 "Not now", an expired session (4401) or sign-out: A02, and a restart stays there.
    func signedOut() {
        invalidateOnboardingWork()
        authGeneration += 1
        signInRouting?.cancel(); signInRouting = nil
        onHandoffAccountChange?(nil)
        storage.set(true, forKey: Self.signedOutKey)
        prep = nil; sceneImage = nil
        storage.removeObject(forKey: Self.needsConsentKey)
        returnTo(.signIn)
    }
    /// Past A02. `userId` = the signed-in account: another account than last time starts with a fresh local
    /// profile (name, photo, preferences belong to the account that made them). Consent pending → CS01.
    /// `consented` has no default on purpose: every caller states whether CS01 was already agreed (#218).
    func signedIn(userId: String? = nil, consented: Bool) {
        invalidateOnboardingWork()
        authGeneration += 1
        signInRouting?.cancel(); signInRouting = nil
        onHandoffAccountChange?(userId)
        storage.removeObject(forKey: Self.signedOutKey)
        if let userId {
            // N1–N3 picks not sent to any account yet (picked signed out, QA build 5 h14) go on to this account
            if let previous = storage.string(forKey: Self.userKey), previous != userId { resetLocalProfile(keepUnsentSkipPicks: true) }
            storage.set(userId, forKey: Self.userKey)
        }
        if !consented { storage.set(true, forKey: Self.needsConsentKey); go(.consent); return }
        if setup.hasOnboarded { returnTo(.conversation) } else { go(.name) }
        // two accounts on one iPhone: the other account's companion lives on the server, not in this phone's setup
        // (signing in used to land a returning account on A03 until the app was relaunched)
        if userId != nil {
            #if os(iOS)
            let route = routeAfterSignIn ?? { [weak self] in await self?.routeOnLaunch(afterSignIn: true) }
            #else
            let route = routeAfterSignIn ?? {}   // the Mac target has no OnboardingFlow (its own start screen routes)
            #endif
            signInRouting = Task { await route() }
        }
    }
    /// Signed in as `id`: if this phone's saved setup (name, photo, imported style) belongs to another
    /// account, drop it — one account's data never goes out under another's token.
    func adopt(accountId id: String) {
        onHandoffAccountChange?(id)
        guard setup.accountId != id else { return }
        if setup.accountId != nil || setup.companionCreated == true || setup.styleRows != nil {
            var fresh = SavedSetup(); fresh.stage = setup.stage == .consent ? .consent : .name
            // unsent N1–N3 picks stay (same rule as resetLocalProfile)
            if setup.styleRows == nil && setup.companionCreated != true {
                fresh.skipInterests = setup.skipInterests; fresh.skipReplies = setup.skipReplies
                fresh.skipAvoid = setup.skipAvoid; fresh.skipLikes = setup.skipLikes
            }
            setup = fresh
            history = []
            story = nil; storyChanged = [:]; storyFailed = false; hisyPage = 0
            prep = nil; sceneImage = nil
        }
        setup.accountId = id
    }
    /// CS01 agreed: back to the call if the account is set up, else on to A03 (name).
    func consentAccepted() {
        storage.removeObject(forKey: Self.signedOutKey)
        storage.removeObject(forKey: Self.needsConsentKey)
        if history.contains(.conversation) || setup.hasOnboarded { returnTo(.conversation) } else { go(.name) }
    }
    /// M02 account deleted: nothing of it stays on this iPhone.
    func accountDeleted() {
        resetLocalProfile()
        storage.removeObject(forKey: Self.userKey)
        signedOut()
    }
    /// `keepUnsentSkipPicks`: N1–N3 answers that no account has received yet (no imported style, no companion) are
    /// this person's, picked before signing in — they stay for the new account (QA build 5 device171: the skip sent
    /// only N3 after a sign-in wiped N1·N2). An account delete drops everything.
    func resetLocalProfile(keepUnsentSkipPicks: Bool = false) {
        let old = setup
        let carry = keepUnsentSkipPicks && old.styleRows == nil && old.companionCreated != true
        storage.removeObject(forKey: Self.storageKey)
        try? FileManager.default.removeItem(at: imageURL)
        history = []
        setup = SavedSetup()
        if carry {
            setup.skipInterests = old.skipInterests; setup.skipReplies = old.skipReplies
            setup.skipAvoid = old.skipAvoid; setup.skipLikes = old.skipLikes
        }
        story = nil; storyChanged = [:]; storyFailed = false; hisyPage = 0
        prep = nil; sceneImage = nil
    }
    /// The call stopped for a reason reconnecting can't fix (server close 4401 / 4403, F1-L7).
    func route(_ stop: CallStop?) {
        switch stop {
        case .signIn?:
            // the token is dead (expired, revoked, account deleted): drop it so the next call doesn't reuse it
            KeychainTokenStore().clear()
            if stage != .signIn { signedOut() }
        case .consent?:
            storage.set(true, forKey: Self.needsConsentKey)
            if stage != .consent { go(.consent) }
        default: break
        }
    }
    func returnTo(_ stage: Stage) {
        if let index = history.lastIndex(of: stage) { history = Array(history.prefix(index)) }
        else { history.removeAll() }
        setup.stage = stage
    }
    func nextPreference() {
        let path = setup.depth.path
        if let i = path.firstIndex(of: stage), i + 1 < path.count { go(path[i + 1]) }
    }
    func complete() {
        if !setup.hasOnboarded { setup.firstCallPending = true }
        setup.hasOnboarded = true; setup.stage = .conversation; history = []
    }
    func answer(_ key: String, _ value: String) { setup.answers[key] = value }
    func toggleBoundary(_ value: String) { if setup.boundaries.contains(value) { setup.boundaries.remove(value) } else { setup.boundaries.insert(value) } }
    func togglePresence(_ value: String) { if setup.presence.contains(value) { setup.presence.remove(value) } else { setup.presence.insert(value) } }
}

#if DEBUG
extension AppState {
    /// What the app knows at review stage `reviewStage` (name, imported style, answers, face), with the demo companion's name.
    /// One source for the GENITA_REVIEW_STAGE launch environment (UI tests, screen review) and the browser preview menu.
    func applyReviewFixture(stage reviewStage: Stage, variant: String) {
        setup.name = variant == "empty" ? "" : "Dyno"
        // screen review fixture: the demo companion's name ({name} in the copy, never hard-coded in the UI)
        setup.companionName = variant == "empty" ? nil : (ProcessInfo.processInfo.environment["GENITA_REVIEW_NAME"] ?? "Jin")
        setup.response = variant == "empty" ? "" : "Communication style\n• Warm, direct, and informal.\nResponse preferences\n• Specific feedback and clear alternatives.\nInterests\n• Visual design and building products.\nLikes & dislikes\n• Concrete examples over generic praise.\nBoundaries\n• Ask before taking action for me."
        setup.voice = variant == "empty" ? nil : 0
        setup.depth = SetupDepth(rawValue: variant) ?? .right
        if variant != "empty" {
            setup.answers = ["help": "Think with me", "relationship": "Trusted partner", "challenge": "2", "tempo": "2", "initiative": "2"]
            setup.boundaries = ["Message anyone for me"]
            setup.presence = ["Calm"]
        }
        if variant == "image" || reviewStage == .conversation || reviewStage == .connecting,
           let url = Bundle.main.url(forResource: "companion", withExtension: "png") { setup.imageData = try? Data(contentsOf: url) }
        else { setup.imageData = nil }
        // photo polish review: GENITA_REVIEW_VARIANT=polished shows V02-T confirming the polished picture (two "Try again" left)
        if reviewStage == .imageCheck, variant == "polished" || variant == "polished-last" {
            if let url = Bundle.main.url(forResource: "companion", withExtension: "png") { setup.imageData = try? Data(contentsOf: url); polishedImage = setup.imageData }
            let left = variant == "polished" ? 2 : 0
            imageCheck = try? JSONDecoder().decode(ImageCheck.self, from: Data(#"{"imageId":"review","passed":false,"type":"human","checks":{"oneFaceFrontFacing":false,"sharpAndLit":true,"noText":true},"reasons":[{"code":"side_view","label":"Side view"}],"polish":true}"#.utf8))
            polished = try? JSONDecoder().decode(PolishedImage.self, from: Data(#"{"imageId":"review-p","sourceImageId":"review","passed":true,"type":"human","checks":{"oneFaceFrontFacing":true,"sharpAndLit":true,"noText":true},"reasons":[],"attempt":\#(3 - left),"retriesLeft":\#(left)}"#.utf8))
            polishRetriesLeft = left
        }
        // V02-F review (D26): GENITA_REVIEW_VARIANT=fail-public_figure shows the well-known-person refusal
        if reviewStage == .imageCheck, variant.hasPrefix("fail-") {
            if let url = Bundle.main.url(forResource: "companion", withExtension: "png") { setup.imageData = try? Data(contentsOf: url) }
            let code = String(variant.dropFirst("fail-".count))
            let label = code == "public_figure" ? "This looks like a well-known person" : code == "no_face" ? "No face found" : "Too blurry to make a face from"
            let json = #"{"imageId":"review","passed":false,"type":"human","checks":{"oneFaceFrontFacing":\#(code == "no_face" ? "false" : "true"),"sharpAndLit":\#(code == "too_blurry" ? "false" : "true"),"noText":true},"reasons":[{"code":"\#(code)","label":"\#(label)"}]}"#
            imageCheck = try? JSONDecoder().decode(ImageCheck.self, from: Data(json.utf8))
        }
        setup.stage = reviewStage
    }
}
#endif
