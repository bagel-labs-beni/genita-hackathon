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
    /// Screen review only (GENITA_REVIEW_VARIANT=scan-NN): holds V03 at NN % with the face mesh, no animation
    var reviewScan: Double?
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
    /// M02-X (Figma 82:2): A02 shows "Your account and data are deleted." once, after a deletion
    var accountDeletedNotice = false
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
        flowError = nil
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
        accountDeletedNotice = false
        // an error from the signed-out session must not follow into the new one (QA build 5: N3 kept "Please sign in again.")
        flowError = nil
        authGeneration += 1
        signInRouting?.cancel(); signInRouting = nil
        onHandoffAccountChange?(userId)
        storage.removeObject(forKey: Self.signedOutKey)
        if let userId {
            if let previous = storage.string(forKey: Self.userKey), previous != userId { resetLocalProfile() }
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
            setup = fresh
            history = []
            story = nil; storyChanged = [:]; storyFailed = false; hisyPage = 0
            prep = nil; sceneImage = nil
        }
        setup.accountId = id
    }
    /// CS01 agreed: back to the call if the account is set up, else on to A03 (name).
    func consentAccepted() {
        consentRecorded()
        if history.contains(.conversation) || setup.hasOnboarded { returnTo(.conversation) } else { go(.name) }
    }
    /// CS01 agreed on the server: a restart no longer shows CS01 (or A02).
    func consentRecorded() {
        storage.removeObject(forKey: Self.signedOutKey)
        storage.removeObject(forKey: Self.needsConsentKey)
    }
    /// M02 account deleted: nothing of it stays on this iPhone.
    func accountDeleted() {
        resetLocalProfile()
        storage.removeObject(forKey: Self.userKey)
        signedOut()
        accountDeletedNotice = true
    }
    func resetLocalProfile() {
        storage.removeObject(forKey: Self.storageKey)
        try? FileManager.default.removeItem(at: imageURL)
        history = []
        setup = SavedSetup()
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
        // V03 face scan review: GENITA_REVIEW_VARIANT=scan-0 / scan-55 / scan-100 holds the scan there over the review
        // photo, with the live SAM geometry for that photo (11/4)
        if reviewStage == .imageCheck, variant.hasPrefix("scan-"), let pct = Double(variant.dropFirst("scan-".count)) {
            if let url = Bundle.main.url(forResource: "companion", withExtension: "png") { setup.imageData = try? Data(contentsOf: url) }
            reviewScan = pct / 100
            if pct > 0 {
                imageCheck = try? JSONDecoder().decode(ImageCheck.self, from: Data(#"{"imageId":"review","passed":true,"type":"human","checks":{"oneFaceFrontFacing":true,"sharpAndLit":true,"noText":true},"reasons":[],"faceOutline":[[0.5018,0.2643],[0.542,0.3343],[0.5806,0.3409],[0.6161,0.3516],[0.659,0.3595],[0.7078,0.3705],[0.7326,0.3941],[0.7655,0.4184],[0.7707,0.4479],[0.7546,0.4762],[0.7542,0.5068],[0.7289,0.5333],[0.695,0.5566],[0.6609,0.582],[0.6122,0.598],[0.5588,0.6093],[0.5018,0.6124],[0.4448,0.6093],[0.3945,0.5938],[0.3516,0.5745],[0.3147,0.5533],[0.2946,0.5259],[0.2715,0.5016],[0.2573,0.4753],[0.2526,0.4479],[0.2573,0.4205],[0.2725,0.3944],[0.2999,0.3719],[0.3301,0.3512],[0.3639,0.3317],[0.377,0.2783],[0.4382,0.2678]],"facePoints":{"leftEye":[[0.3613,0.384],[0.3884,0.3756],[0.4245,0.3756],[0.4516,0.384],[0.4245,0.3923],[0.3884,0.3923]],"rightEye":[[0.5845,0.3897],[0.61,0.3804],[0.644,0.3804],[0.6695,0.3897],[0.644,0.3989],[0.61,0.3989]],"leftBrow":[[0.3523,0.358],[0.3884,0.3485],[0.4245,0.3485],[0.4607,0.3566]],"rightBrow":[[0.576,0.3638],[0.61,0.3549],[0.644,0.3549],[0.678,0.3625]],"nose":[[0.5167,0.3868],[0.5167,0.467],[0.4595,0.4559],[0.574,0.4559],[0.5167,0.4759]],"lips":[[0.4219,0.5224],[0.4546,0.5055],[0.4874,0.4982],[0.5037,0.504],[0.5201,0.4982],[0.5528,0.5055],[0.5855,0.5224],[0.5446,0.5467],[0.5037,0.5491],[0.4628,0.5467]]},"headBox":{"nx1":0.16153028692879914,"ny1":0.12858851674641147,"nx2":0.8799149840595112,"ny2":0.6130382775119617}}"#.utf8))
            }
        }
        // V03 face scan motion review (CI recordings): GENITA_REVIEW_VARIANT=anim-human / anim-animal / anim-character runs
        // the real scan over a review photo and answers after 2.6 s with that photo's live SAM geometry (11/4)
        if reviewStage == .imageCheck, variant.hasPrefix("anim-") {
            let kind = String(variant.dropFirst("anim-".count))
            let (resource, ext, geometry): (String, String, String) = kind == "animal" ? ("review-animal", "jpg", #""faceOutline":[[0.5418,0.2701],[0.5988,0.2733],[0.6535,0.2826],[0.7058,0.2962],[0.7705,0.3056],[0.8145,0.3318],[0.8545,0.3614],[0.8977,0.3944],[0.9185,0.4342],[0.9113,0.4755],[0.8899,0.5152],[0.8288,0.542],[0.7423,0.5469],[0.6987,0.5662],[0.6499,0.5809],[0.5969,0.5899],[0.5418,0.5936],[0.4854,0.5936],[0.4291,0.5872],[0.3779,0.5722],[0.33,0.5533],[0.248,0.5446],[0.1902,0.5161],[0.1686,0.4759],[0.1612,0.4342],[0.1947,0.3954],[0.2317,0.362],[0.2632,0.3295],[0.3057,0.3014],[0.3766,0.2952],[0.4289,0.2809],[0.4843,0.2714]],"facePoints":{"leftEye":[[0.3656,0.3916],[0.3829,0.3762],[0.406,0.3762],[0.4233,0.3916],[0.406,0.4069],[0.3829,0.4069]],"rightEye":[[0.6211,0.3909],[0.6394,0.3756],[0.6639,0.3756],[0.6822,0.3909],[0.6639,0.4063],[0.6394,0.4063]],"leftBrow":[[0.3598,0.3563],[0.3829,0.3456],[0.406,0.3456],[0.4291,0.3548]],"rightBrow":[[0.615,0.3557],[0.6394,0.345],[0.6639,0.345],[0.6883,0.3542]],"nose":[[0.5231,0.3913],[0.5231,0.4979],[0.4538,0.4831],[0.5923,0.4831],[0.5231,0.5098]],"lips":[[0.4389,0.5575],[0.4702,0.5448],[0.5016,0.5394],[0.5172,0.5437],[0.5329,0.5394],[0.5642,0.5448],[0.5956,0.5575],[0.5564,0.5756],[0.5172,0.5774],[0.4781,0.5756]]},"headBox":{"nx1":0.13666666666666666,"ny1":0.268125,"nx2":0.9555555555555556,"ny2":0.595}"#)
                : kind == "character" ? ("review-character", "jpg", #""faceOutline":[[0.5185,0.3003],[0.5775,0.2995],[0.6343,0.3092],[0.6867,0.3249],[0.7133,0.3569],[0.7476,0.3804],[0.7731,0.4072],[0.7773,0.4376],[0.7824,0.4666],[0.7773,0.4955],[0.7526,0.5211],[0.7292,0.5458],[0.6977,0.5674],[0.6691,0.5934],[0.629,0.6167],[0.5793,0.6385],[0.5185,0.6419],[0.4577,0.6385],[0.4054,0.6202],[0.3632,0.5973],[0.3311,0.572],[0.2981,0.5494],[0.2895,0.5199],[0.2846,0.4927],[0.2801,0.4666],[0.27,0.4387],[0.2844,0.412],[0.288,0.3799],[0.3224,0.3563],[0.3645,0.3369],[0.4101,0.3193],[0.4629,0.3093]],"facePoints":{"leftEye":[[0.3378,0.4244],[0.3698,0.41],[0.4124,0.41],[0.4444,0.4244],[0.4124,0.4388],[0.3698,0.4388]],"rightEye":[[0.5711,0.4216],[0.6028,0.4069],[0.645,0.4069],[0.6767,0.4216],[0.645,0.4363],[0.6028,0.4363]],"leftBrow":[[0.3271,0.3892],[0.3698,0.378],[0.4124,0.378],[0.4551,0.3876]],"rightBrow":[[0.5606,0.3863],[0.6028,0.3752],[0.645,0.3752],[0.6872,0.3847]],"nose":[[0.5075,0.423],[0.5075,0.514],[0.4464,0.5013],[0.5686,0.5013],[0.5075,0.5241]],"lips":[[0.4233,0.5572],[0.4582,0.5517],[0.4931,0.5494],[0.5106,0.5512],[0.528,0.5494],[0.5629,0.5517],[0.5978,0.5572],[0.5542,0.565],[0.5106,0.5658],[0.4669,0.565]]},"headBox":{"nx1":0.17444444444444446,"ny1":0.17375,"nx2":0.8222222222222222,"ny2":0.644375}"#) : ("companion", "png", #""faceOutline":[[0.5018,0.2643],[0.542,0.3343],[0.5806,0.3409],[0.6161,0.3516],[0.659,0.3595],[0.7078,0.3705],[0.7326,0.3941],[0.7655,0.4184],[0.7707,0.4479],[0.7546,0.4762],[0.7542,0.5068],[0.7289,0.5333],[0.695,0.5566],[0.6609,0.582],[0.6122,0.598],[0.5588,0.6093],[0.5018,0.6124],[0.4448,0.6093],[0.3945,0.5938],[0.3516,0.5745],[0.3147,0.5533],[0.2946,0.5259],[0.2715,0.5016],[0.2573,0.4753],[0.2526,0.4479],[0.2573,0.4205],[0.2725,0.3944],[0.2999,0.3719],[0.3301,0.3512],[0.3639,0.3317],[0.377,0.2783],[0.4382,0.2678]],"facePoints":{"leftEye":[[0.3613,0.384],[0.3884,0.3756],[0.4245,0.3756],[0.4516,0.384],[0.4245,0.3923],[0.3884,0.3923]],"rightEye":[[0.5845,0.3897],[0.61,0.3804],[0.644,0.3804],[0.6695,0.3897],[0.644,0.3989],[0.61,0.3989]],"leftBrow":[[0.3523,0.358],[0.3884,0.3485],[0.4245,0.3485],[0.4607,0.3566]],"rightBrow":[[0.576,0.3638],[0.61,0.3549],[0.644,0.3549],[0.678,0.3625]],"nose":[[0.5167,0.3868],[0.5167,0.467],[0.4595,0.4559],[0.574,0.4559],[0.5167,0.4759]],"lips":[[0.4219,0.5224],[0.4546,0.5055],[0.4874,0.4982],[0.5037,0.504],[0.5201,0.4982],[0.5528,0.5055],[0.5855,0.5224],[0.5446,0.5467],[0.5037,0.5491],[0.4628,0.5467]]},"headBox":{"nx1":0.16153028692879914,"ny1":0.12858851674641147,"nx2":0.8799149840595112,"ny2":0.6130382775119617}"#)
            if let url = Bundle.main.url(forResource: resource, withExtension: ext) { setup.imageData = try? Data(contentsOf: url) }
            let json = #"{"imageId":"review-\#(kind)","passed":true,"type":"\#(kind)","checks":{"oneFaceFrontFacing":true,"sharpAndLit":true,"noText":true},"reasons":[],"# + geometry + "}"
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(2600))
                self?.imageCheck = try? JSONDecoder().decode(ImageCheck.self, from: Data(json.utf8))
            }
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
