import AVFoundation
import Foundation
import Observation
import os

/// The one line of call status at the top of S09 (full-flow board §5). Never a subtitle.
enum CallCue: Equatable {
    case none
    case listening      // S09-L
    case thinking       // reply on its way (no board frame yet; same pill with a spinner)
    case speaking       // S09-S
    case interrupted    // S09-X, held 1.2 s
    case reconnecting   // S09-R
    case answerFailed   // S09-F, with Try again
    case micBlocked     // E02 stand-in until the permission sheet lands

    enum Link: Equatable { case idle, connecting, live, reconnecting }

    /// One slot, highest priority first: failure and reconnect > interrupted > talking/listening.
    static func derive(link: Link, phase: Phase, playing: Bool, awaitingFirstAudio: Bool, micOn: Bool,
                       interruptedHold: Bool, answerFailed: Bool, micDenied: Bool) -> CallCue {
        switch link {
        case .reconnecting: return .reconnecting
        case .idle, .connecting: return .none
        case .live: break
        }
        if answerFailed { return .answerFailed }
        if micDenied { return .micBlocked }
        if interruptedHold || phase == .interrupted { return .interrupted }
        if playing { return .speaking }
        switch phase {
        case .thinking: return .thinking
        case .speaking: return awaitingFirstAudio ? .thinking : .speaking
        case .interrupted: return .interrupted
        case .listening: return micOn ? .listening : .none
        }
    }
}

/// Where the session server is and who is calling. Read again on every (re)connect, so a sign-in during
/// the call is picked up. F0-I1 adds the deployed URL.
///
/// Token (F1-L5): the signed-in user's session JWT first, then the shared dev token for local runs
/// (launch env `GENITA_SESSION_TOKEN`, or defaults `genita.session.token`).
struct CallEndpoint {
    var url: URL
    var token: String?

    /// The user's session JWT. Defaults to the keychain item GenitaKit's `KeychainTokenStore` writes (#103);
    /// once GenitaKit Auth is on this branch, set it to `{ GenitaAuthClient().token }`.
    nonisolated(unsafe) static var userToken: () -> String? = { KeychainSessionToken.load() }

    /// The deployed server (AWS CloudFront → EC2, deploy/aws). Local runs set GENITA_SERVER_URL.
    static let defaultURL = "wss://d72kt0jfmscyj.cloudfront.net/v1/session"

    static func current(environment: [String: String] = ProcessInfo.processInfo.environment, defaults: UserDefaults = .standard) -> CallEndpoint {
        let raw = environment["GENITA_SERVER_URL"] ?? defaults.string(forKey: "genita.server.url") ?? defaultURL
        let token = userToken() ?? environment["GENITA_SESSION_TOKEN"] ?? defaults.string(forKey: "genita.session.token")
        return CallEndpoint(url: URL(string: raw) ?? URL(string: defaultURL)!, token: token)
    }
}

/// Reads the session token saved by GenitaKit's KeychainTokenStore (service ai.thebeni.genita.session,
/// account session). Read-only: sign-in owns writing and clearing it.
enum KeychainSessionToken {
    static func load() -> String? {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "ai.thebeni.genita.session",
                                kSecAttrAccount as String: "session", kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        #if os(iOS)
        q[kSecUseDataProtectionKeychain as String] = true
        #endif
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

/// Why the call stopped trying (server close codes, PROTOCOL.md).
enum CallStop: Equatable {
    case signIn      // 4401: no, bad, expired or revoked token, or the account was deleted → A02
    case consent     // 4403: signed in, no AI-data consent yet → CS01
    case timeLimit   // 4001: max call length
    case companionReset   // 4410: the companion was reset (POST /v1/companion/reset) → iPhone V01, Mac "Set up on iPhone"
}

/// F4-L10 + F4-U-S09 · One live call: WebSocket session, mic uplink, reply playback, camera frames,
/// and the state the call screen draws. Shared by iPhone and Mac.
@MainActor @Observable final class CallController {
    static let shared = CallController()

    private(set) var link: CallCue.Link = .idle
    private(set) var phase: Phase = .listening
    private(set) var micOn = false
    private(set) var micDenied = false
    private(set) var cameraOn = false
    /// D22: the next camera start faces back (the self view was double-tapped while the camera was off)
    @ObservationIgnored private var startCameraBack = false
    /// The front camera's preview is mirrored, the frames sent to the server are not: boxes need to know (CAM-H).
    private(set) var cameraFront = true
    private(set) var cameraDenied = false
    private(set) var mode: ConversationMode = .chat { didSet { finds.interpreting = mode == .interpret } }
    private(set) var playing = false
    private(set) var awaitingFirstAudio = false
    private(set) var interruptedHold = false
    private(set) var answerFailed = false
    private(set) var lip: LipPlan?
    /// `ready.tts`: who speaks the reply. `device` = `say` text spoken with the system voice (DeviceVoice).
    private(set) var tts: TtsMode = .server
    /// Set when the server ended the call for a reason reconnecting can't fix. The app routes on it
    /// (F1-L7 StartRouter: signIn → A02, consent → CS01).
    private(set) var stopped: CallStop?
    /// `ready.sessionId` of the live call: the Mac's screen share opens `/v1/watch?session=` with it (F5).
    private(set) var sessionId: String?
    /// The server and token this call uses (also for /v1/watch and Finds REST).
    var currentEndpoint: CallEndpoint { fixedEndpoint ?? .current() }
    private(set) var emotion: String?
    /// Web lookups this call (More → Finds). The F10 sheet lists them.
    private(set) var findsCount = 0
    /// Client-side latency per answered turn: ASR end of speech → reply audio playing.
    private(set) var latencies: [Int] = []
    var companionName = ""
    /// D48 ①: "Updated: no cilantro" — a correction said in the call was saved (`profile.updated`). Shown for
    /// `profileChipMs`, then nil. A second one replaces the first and restarts the clock.
    private(set) var profileChip: String?
    /// One per `profile.updated`: the chip view restarts (and re-times its exit) even when the words repeat.
    private(set) var profileChipSerial = 0
    /// GK-1 "Getting to know you · {topic}": the companion just asked this call's question (`profile.asking`).
    /// A soft chip for `askingChipMs`, or until the answer is saved (CC-1 "Noted: …").
    private(set) var askingChip: String?
    /// F8 interpretation screens (INT-1~6, INT-M1/M2), from interpret.* events.
    private(set) var interpretBoard = InterpretBoard()
    /// Mac call interpretation: plays utterances whose route is whisper/speaker (InterpretAudioOutput).
    /// Unset = everything plays through CallAudio as usual.
    /// The app saves a name the server changed in the call (`companion.named`).
    @ObservationIgnored var onCompanionNamed: ((String) -> Void)?
    /// A recovered authenticated call is also an opportunity to retry missing handoff identity.
    @ObservationIgnored var onConnected: (() -> Void)?
    @ObservationIgnored var routeInterpretAudio: ((Data, InterpretBoard.Route, Int) -> Void)?
    @ObservationIgnored var flushRoutedAudio: (() -> Void)?
    @ObservationIgnored private var routed: Set<Int> = []

    var cue: CallCue {
        CallCue.derive(link: link, phase: phase, playing: playing, awaitingFirstAudio: awaitingFirstAudio, micOn: micOn,
                       interruptedHold: interruptedHold, answerFailed: answerFailed, micDenied: micDenied)
    }
    var canFlipCamera: Bool { cameraOn && camera.canFlip }
    var cameraSession: AVCaptureSession { camera.session }

    /// F10-U-SHEET: result cards of this call and the sheet's state.
    let finds = FindsModel()

    /// Live captions r01: the user's words and the reply's, from server events; drawn by CallCaptionLayer every tick.
    @ObservationIgnored private var captions = LiveCaptions()
    static func captionClock() -> Double { ProcessInfo.processInfo.systemUptime * 1000 }
    /// One display tick of the captions: the local mic level (nil while the mic is off) and the reply's playhead.
    func captionFrame(now: Double = CallController.captionClock()) -> LiveCaptions.Frame {
        if tts == .device { captions.markDevice() }
        var playhead: Double?
        if let id = captions.reply?.utteranceId, !routed.contains(id), !cancelled.contains(id) { playhead = audio.playbackPositionMs(utteranceId: id) }
        return captions.frame(now: now, level: micOn ? inputLevel : nil, playheadMs: playhead)
    }
    #if DEBUG
    /// Review renders only (Mac CI capture): a finished turn on screen.
    func reviewCaptions(_ c: LiveCaptions) { captions = c }
    #endif

    @ObservationIgnored let camera = CallCamera()
    /// PERC-2: face crops for the server's perception, only while `ready.perception` is true.
    @ObservationIgnored private let perception = PerceptionSampler()
    @ObservationIgnored private var perceptionOn = false
    @ObservationIgnored private let audio: any CallAudioPlaying
    @ObservationIgnored private let voice: any CallVoiceRendering
    @ObservationIgnored private let makeSocket: () -> any CallConnection
    @ObservationIgnored private var socket: (any CallConnection)? { didSet { uplink.socket = socket } }
    /// The mic thread's way to the socket.
    @ObservationIgnored private let uplink = Uplink()
    @ObservationIgnored private var start: ClientMessage.Start?
    @ObservationIgnored private var history: [ClientMessage.HistoryItem] = []
    @ObservationIgnored private var lastUserText: String?
    @ObservationIgnored private var seqToUtterance: [UInt32: Int] = [:]
    @ObservationIgnored private var cancelled: Set<Int> = []
    /// Utterances the server sent as `say` while `ready.tts` is server (voice GPU full or failed): complete them
    /// after the device voice has rendered them, not when `reply` arrives.
    @ObservationIgnored private var saidOnDevice: Set<Int> = []
    @ObservationIgnored private var currentUtterance: Int?
    @ObservationIgnored private var lookedUp: Set<Int> = []
    @ObservationIgnored private var playingUtterance: Int?
    @ObservationIgnored private var speechEndAt: Date?
    @ObservationIgnored private var userAudioEndAt: Date?
    @ObservationIgnored private var firstFrame: String?
    @ObservationIgnored private var reconnectSince: Date?
    @ObservationIgnored private var reconnectTask: Task<Void, Never>?
    @ObservationIgnored private var holdTask: Task<Void, Never>?
    @ObservationIgnored private var profileChipTask: Task<Void, Never>?
    @ObservationIgnored private var askingChipTask: Task<Void, Never>?
    @ObservationIgnored private var pingTask: Task<Void, Never>?
    @ObservationIgnored private var graceTask: Task<Void, Never>?
    @ObservationIgnored private var micBeforeBackground = false
    @ObservationIgnored private var userEnded = true
    @ObservationIgnored private var capturePermissions = CapturePermissionRequests()
    @ObservationIgnored private var fixedEndpoint: CallEndpoint?
    @ObservationIgnored let log = Logger(subsystem: "ai.thebeni.genita", category: "call")
    #if DEBUG
    @ObservationIgnored var fixture: FixtureMic?
    /// Debug tap on everything the server sends (session recording for replay tests).
    @ObservationIgnored var onServerMessage: ((CallSocket.Incoming) -> Void)?
    /// Tests: reply PCM goes here instead of the speaker.
    @ObservationIgnored var playbackSink: ((Data, Int) -> Void)?
    #endif

    /// L4: the companion's animated Meta face (nil → the still). Fed from the reply events below.
    private(set) var face: FaceDriver?
    @ObservationIgnored private var faceKey: String?
    /// `audio` events waiting for their binary PCM frame (same seq), for the face.
    @ObservationIgnored private var faceAudio: [UInt32: ServerEvent.Audio] = [:]
    @ObservationIgnored private var faceOnScreen = false
    @ObservationIgnored private var faceAnimates = true
    @ObservationIgnored private var faceReduceMotion = false
    @ObservationIgnored private var faceLoad: Task<Void, Never>?
    /// a face set download is in flight (from prepareFace or showFace)
    @ObservationIgnored private var faceLoading = false
    /// which load `faceLoading` belongs to (AU-25 × #524)
    @ObservationIgnored private var faceLoadGeneration = 0
    /// the account the load in flight is for
    @ObservationIgnored private var faceLoadOwner: String?
    /// The account the face set belongs to (JWT `sub`); another account never sees it.
    @ObservationIgnored private var faceOwner: String?
    /// Utterance ids restart with each session; the face sees `faceIdBase + id` so they only grow.
    @ObservationIgnored private var faceIdBase = 0
    @ObservationIgnored private var faceIdMax = -1
    /// Device voice: ms of speech rendered so far per reply (the next buffer's offset).
    @ObservationIgnored private var faceDeviceMs: [Int: Int] = [:]
    /// Events of a later reply held while the face's current reply is still being heard (queued
    /// interpretations): switching early would close the mouth on audio that is still playing.
    @ObservationIgnored private var facePending: [(utterance: Int, apply: (FaceDriver) -> Void)] = []
    /// One rendered frame when the face doesn't animate (UI review stills); rendered off the main thread.
    private(set) var faceStill: CGImage?
    /// Same presence (Mac): the face set's own rest frame, drawn under the live face so the very first frame on
    /// arrival is this face in this crop (not the prep still, then a jump). Drawn per face set and reduce-motion setting.
    private(set) var facePoster: CGImage?
    /// The live face's seed and the reduce-motion setting its poster was drawn with.
    @ObservationIgnored private var faceSeed: UInt64 = 1
    @ObservationIgnored private var posterReduceMotion: Bool?
    @ObservationIgnored private var faceSetForPoster: FaceSet?

    convenience init() {
        self.init(audio: CallAudio(), voice: DeviceVoice(), makeSocket: { CallSocket() })
    }

    init(audio: any CallAudioPlaying, voice: any CallVoiceRendering, makeSocket: @escaping () -> any CallConnection) {
        self.audio = audio
        self.voice = voice
        self.makeSocket = makeSocket
        audio.onMicFrame = { [uplink] frame in uplink.send(frame) }
        audio.onPlaybackStarted = { [weak self] id in self?.playbackStarted(id) }
        audio.onUtterancePlayed = { [weak self] id in self?.utterancePlayed(id) }
        audio.onInterrupted = { [weak self] in self?.suspend() }
        voice.onPCM = { [weak self] pcm, id in
            guard let self, !self.cancelled.contains(id), self.mayPlayHere else { return }
            self.feedFaceDevicePCM(pcm, utteranceId: id)
            self.audio.enqueue(pcm: pcm, utteranceId: id)
        }
        voice.onRendered = { [weak self] id in
            guard let self, !self.cancelled.contains(id) else { return }
            self.audio.markComplete(utteranceId: id)
        }
        finds.send = { [weak self] message in self?.socket?.send(message) }
        finds.persistFrames = { id, frames in FindFrameStore.save(id: id, frames: frames) }
        finds.saveRemote = { [weak self] id, saved in await self?.saveFind(id, saved) ?? false }
    }

    @ObservationIgnored private var findsOwner: String?

    /// `sub` of a session JWT (the account id); "dev" for the shared dev token; nil when signed out.
    nonisolated static func tokenSubject(_ token: String?) -> String? {
        guard let token, !token.isEmpty else { return nil }
        let parts = token.split(separator: ".")
        guard parts.count == 3 else { return "dev" }
        var b64 = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        guard let data = Data(base64Encoded: b64), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return obj["sub"] as? String
    }

    /// POST /v1/finds/:id/save (bookmark), so it survives a restart and shows on the other device.
    func saveFind(_ id: String, _ saved: Bool) async -> Bool {
        guard let url = findsURL("/v1/finds/\(id)/save") else { return false }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["saved": saved])
        guard let (_, res) = try? await URLSession.shared.data(for: req) else { return false }
        return (res as? HTTPURLResponse)?.statusCode == 200
    }

    /// REST client for the Finds tab, on the same host and token as the call.
    var findsAPI: HTTPFindsAPI { HTTPFindsAPI(endpoint: fixedEndpoint ?? .current(), user: Self.installId) }

    /// Stable per install until login (F1-L5): the owner of this user's saved Finds on the server.
    static var installId: String {
        let key = "genita.install.id"
        if let id = UserDefaults.standard.string(forKey: key) { return id }
        let id = UUID().uuidString
        UserDefaults.standard.set(id, forKey: key)
        return id
    }

    /// A server-relative Finds URL ("/v1/finds/<id>/images/hero") on the session's host, with the token.
    func findsURL(_ path: String) -> URL? {
        let endpoint = fixedEndpoint ?? .current()
        guard var c = URLComponents(url: endpoint.url, resolvingAgainstBaseURL: false) else { return nil }
        c.scheme = c.scheme == "wss" ? "https" : "http"
        let parts = path.split(separator: "?", maxSplits: 1)
        c.path = String(parts[0])
        c.queryItems = endpoint.token.map { [URLQueryItem(name: "token", value: $0)] }
        return c.url
    }

    /// Stop the companion's sound now: server audio and device speech alike (barge-in, cancel, background).
    private func flushPlayback() {
        voice.cancel()
        audio.flush()
    }

    // MARK: lifecycle

    /// Opens the call. The mic starts as the user left it last time (B12; off the very first time).
    func begin(_ start: ClientMessage.Start, endpoint: CallEndpoint? = nil) {
        guard userEnded else { return }
        userEnded = false
        stopped = nil
        fixedEndpoint = endpoint
        // Finds kept in memory belong to whoever was signed in: another account (or a sign-out) starts empty
        let owner = Self.tokenSubject((endpoint ?? .current()).token)
        if owner != findsOwner { finds.reset(); findsOwner = owner }
        var s = start
        s.mic = false
        var user = s.user ?? .init()
        user.id = user.id ?? Self.installId
        user.timeZone = user.timeZone ?? TimeZone.current.identifier
        s.user = user
        self.start = s
        history = s.history ?? []
        mode = s.mode ?? .chat
        uplink.callFraming = mode == .interpret && s.interpret?.source == .call
        audio.start()
        connect()
        #if DEBUG
        installFixtures()
        #endif
        // B12: mic on again if it was on when the last call ended (asks for permission the usual way)
        if Self.micWasOn && mode == .chat { toggleMic() }
    }

    /// True between `end()` (or before the first `begin`) and the next `begin`.
    var isEnded: Bool { userEnded }

    /// The conversation came back to this device while its call socket stayed open (handoff return, AU-83/AU-84).
    /// The open server session only knows the turns from before the move, so it is replaced by a new one: the server
    /// seeds that from the session the other device just used. Closed without `stop` (a move back is not a hang-up),
    /// and the mic comes back the way the user left it (B12, the same rule as a new call).
    func rejoin() {
        guard !userEnded, stopped == nil else { return }
        reconnectTask?.cancel(); pingTask?.cancel()
        let old = socket
        socket = nil
        old?.disconnect()
        perception.stop()
        flushPlayback()
        restFace()
        playing = false; awaitingFirstAudio = false; reconnectSince = nil
        phase = .listening
        connect()
        if !micOn && (Self.micWasOn || mode == .interpret) { toggleMic() }
    }

    /// The turns of this call (last 20 go into every reconnect's `start`). The Mac keeps them across a move
    /// away and back, so the conversation resumes where it was (#118).
    var historySnapshot: [ClientMessage.HistoryItem] { history }

    func end() {
        capturePermissions.invalidate()
        userEnded = true
        graceTask?.cancel(); graceTask = nil; micBeforeBackground = false
        reconnectTask?.cancel(); pingTask?.cancel(); holdTask?.cancel(); profileChipTask?.cancel(); profileChip = nil; askingChipTask?.cancel(); askingChip = nil
        socket?.close()
        socket = nil
        voice.cancel()
        audio.stop()
        camera.stop()
        perception.stop(); perceptionOn = false
        micOn = false; cameraOn = false; playing = false; link = .idle
        reconnectSince = nil; cancelled = []; seqToUtterance = [:]; lookedUp = []; findsCount = 0
        routed = []; interpretBoard = InterpretBoard(companionName: companionName); uplink.callFraming = false
        restFace()
        finds.callEnded()
        phase = .listening; awaitingFirstAudio = false; interruptedHold = false; answerFailed = false
        #if DEBUG
        fixture?.stop()
        #endif
    }

    /// Background, screen off, or a phone call: stop the sound and close the mic and camera.
    func suspend() {
        capturePermissions.invalidate()
        suspendCapture()
    }

    /// A system permission alert is inactive, but not backgrounded. Keep its answer until active;
    /// a real background transition still invalidates it, as do end(), handoff and audio interruption.
    /// Only `.background` closes capture (AU-47): a permission alert, Control Center, Notification Center or the app
    /// switcher makes the scene `.inactive` for a moment, and the mic and the companion's voice carry on through it.
    ///
    /// Home or lock (IC-02 step 4, RV-01 step 2): the call pauses — mic, camera and sound off, the session stays. Back
    /// within `backgroundGraceMs` the same call goes on (same session, no greeting) with the mic as it was. Past the
    /// grace the call hangs up with `stop`, so the next call greets as a new one. A swipe-kill ends it at once (app).
    func sceneActivityChanged(_ activity: CapturePermissionRequests.Activity) {
        let answers = capturePermissions.updateActivity(activity, callEnded: userEnded, isOwner: ownsConversation)
        if activity == .background, !userEnded {
            if graceTask == nil { micBeforeBackground = micOn }
            suspendCapture()
            graceTask?.cancel()
            graceTask = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(Self.backgroundGraceMs))
                guard let self, !Task.isCancelled, self.graceTask != nil else { return }
                self.log.info("background grace over: hang up")
                self.end()
            }
        }
        for answer in answers { applyCapturePermission(answer) }
        if activity == .active, let grace = graceTask {
            grace.cancel(); graceTask = nil
            // interpretation keeps its mic too (its screen has no mic button)
            if !userEnded, micBeforeBackground, !micOn { toggleMic() }
            micBeforeBackground = false
        }
    }

    /// How long a call paused by Home or lock waits for the user before it hangs up (coordinator 11/4: 30 s).
    nonisolated(unsafe) static var backgroundGraceMs = 30_000
    /// The paused call is waiting for the user to come back.
    var inBackgroundGrace: Bool { graceTask != nil }

    private func suspendCapture() {
        guard !userEnded else { return }
        if micOn { setMic(false) }
        if cameraOn { toggleCamera() }
        if playing || phase == .speaking || phase == .thinking { socket?.send(.bargeIn) }
        silenceCurrentReply()
        flushPlayback()
        restFace()
        playing = false
    }

    /// AU-50: a local stop (tap, background, handoff) tombstones the reply that was playing, so frames and `say`
    /// lines already on their way for it are dropped here instead of playing again until `utterance.cancelled`.
    private func silenceCurrentReply() {
        for id in Set([currentUtterance, playingUtterance].compactMap { $0 }) {
            cancelled.insert(id)
            saidOnDevice.remove(id)
            face?.cancel(utteranceId: faceId(id))
        }
    }

    /// GATE-A (AU-82): the companion is heard only on the device that holds the conversation. Audio and `say` lines
    /// that reach this iPhone after the conversation moved to the Mac (the rest of a reply, a search card's line)
    /// are dropped here. The Mac closes its call when the conversation leaves it. Nothing plays while a call is
    /// paused in the background either (a greeting that lands during the grace stays silent).
    private var mayPlayHere: Bool {
        guard graceTask == nil else { return false }
        #if os(iOS)
        return ownsConversation
        #else
        return true
        #endif
    }

    // MARK: user actions

    private var ownsConversation: Bool {
        #if os(iOS)
        PhoneHandoff.shared.ownership.isOwner
        #else
        MacHandoff.shared.ownership.isOwner
        #endif
    }

    func toggleMic() {
        if micOn { setMic(false); Self.micWasOn = false; return }
        guard !userEnded, ownsConversation else { return }
        micDenied = false
        #if DEBUG
        if fixture != nil { setMic(true); Self.micWasOn = true; return }
        #endif
        let generation = capturePermissions.generation
        Self.requestMicrophone { [weak self] granted in
            self?.receiveCapturePermission(.microphone, granted: granted, generation: generation)
        }
    }

    /// B12: the mic starts the way the user left it in the last call (their own toggle; a background
    /// suspend doesn't count). UI tests start with it off.
    static var micWasOn: Bool {
        get {
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--uitesting") || BrowserPreview.isActive { return false }
            #endif
            return UserDefaults.standard.bool(forKey: "genita.mic.lastOn")
        }
        set { UserDefaults.standard.set(newValue, forKey: "genita.mic.lastOn") }
    }
    /// #2 handoff (iPhone): ARKit tracking may hold the rear camera; it lets go before the call's camera starts,
    /// and tracking re-evaluates when the call's camera changes. The call owns camera and mic (one owner).
    @ObservationIgnored var beforeCameraStart: (() -> Void)?
    @ObservationIgnored var onCameraChange: (() -> Void)?

    func toggleCamera() {
        if cameraOn { camera.stop(); cameraOn = false; finds.boxes.clear(); onCameraChange?(); return }
        guard !userEnded, ownsConversation else { return }
        cameraDenied = false
        let generation = capturePermissions.generation
        let apply: @MainActor @Sendable (Bool) -> Void = { [weak self] granted in
            self?.receiveCapturePermission(.camera, granted: granted, generation: generation)
        }
        #if DEBUG
        if camera.fixture != nil { apply(true); return }
        #endif
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: apply(true)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { ok in DispatchQueue.main.async { MainActor.assumeIsolated { apply(ok) } } }
        default: apply(false)
        }
    }

    private func receiveCapturePermission(_ media: CapturePermissionRequests.Media, granted: Bool, generation: UInt64) {
        guard let answer = capturePermissions.resolve(media, granted: granted, generation: generation,
                                                     callEnded: userEnded, isOwner: ownsConversation) else { return }
        applyCapturePermission(answer)
    }

    private func applyCapturePermission(_ answer: CapturePermissionRequests.Answer) {
        switch answer.media {
        case .microphone:
            if answer.granted { setMic(true); Self.micWasOn = true } else { micDenied = true }
        case .camera:
            // a back-camera request that didn't start the camera doesn't carry over to the next camera-on (Codex P2)
            guard answer.granted else { startCameraBack = false; cameraDenied = true; return }
            guard camera.available else { startCameraBack = false; return }
            beforeCameraStart?()
            camera.start()
            if startCameraBack { startCameraBack = false; camera.flip() }
            cameraFront = camera.front
            cameraOn = true
            onCameraChange?()
        }
    }

    func flipCamera() { camera.flip(); cameraFront = camera.front; finds.boxes.clear() }
    /// PRD D22: the self view double-tapped → the back camera. Off → it turns on facing back (after the usual
    /// permission); on and facing front → it flips.
    func useBackCamera() {
        if cameraOn { if cameraFront { flipCamera() }; return }
        startCameraBack = true
        toggleCamera()
    }

    /// PERC-2: ~2 fps look at the camera; a face crop goes up when it changed (≥ 1 s apart) or every 2.5 s.
    private func startPerception() {
        guard !perception.isRunning else { return }
        perception.start(
            frame: { [weak self] in self?.camera.latestFrontImage() },
            active: { [weak self] in
                guard let self else { return false }
                return PerceptionGate.active(serverOn: self.perceptionOn, cameraOn: self.cameraOn, front: self.camera.front, mode: self.mode, live: self.link == .live)
            },
            send: { [weak self] image in self?.socket?.send(.perceptionFrame(image: image)) }
        )
    }

    /// S09-X hold. Debug UI tests on slow simulators can lengthen it (GENITA_INTERRUPT_HOLD_MS).
    static var interruptedHoldMs: Int {
        #if DEBUG
        if let ms = ProcessInfo.processInfo.environment["GENITA_INTERRUPT_HOLD_MS"].flatMap(Int.init) { return ms }
        #endif
        return 1200
    }

    /// ⋮ Interpret a conversation (INT-0), or Mac INT-M0 with `.init(source: .call, app: "FaceTime")`.
    func setInterpreting(_ on: Bool, options: InterpretOptions? = nil) {
        let next: ConversationMode = on ? .interpret : .chat
        let opts = on ? options : nil
        let changed = next != mode || opts != start?.interpret
        mode = next
        start?.mode = next
        start?.interpret = opts
        uplink.callFraming = opts?.source == .call
        if changed {
            if let opts { socket?.send(.modeInterpret(opts)) } else { socket?.send(.mode(next)) }
        }
        if on {
            interpretBoard.active = true
            interpretBoard.companionName = companionName
            // the rail (and its mic button) is hidden while interpreting; interpretation needs the mic
            if !micOn { toggleMic() }
        } else {
            if interpretBoard.holding { socket?.send(.hold(on: false)) }
            interpretBoard = InterpretBoard(companionName: companionName)
        }
    }

    /// Hold to talk (INT-4) / Hold to reply (INT-M2).
    func setHold(_ on: Bool) {
        guard interpretBoard.holding != on else { return }
        interpretBoard.holding = on
        if on && !micOn { toggleMic() }
        socket?.send(.hold(on: on))
    }

    /// Mac call interpretation: where the call app's sound goes (ScreenCaptureKit chunks, PCM s16le 24 kHz).
    /// Callable from the capture queue.
    var callSoundSink: @Sendable (Data) -> Void {
        let uplink = uplink
        return { uplink.sendCall($0) }
    }

    /// Tap on the face while the companion talks: stop now, the server cancels the reply.
    func interrupt() {
        guard playing || phase == .speaking || phase == .thinking else { return }
        silenceCurrentReply()
        flushPlayback()
        restFace()   // the mouth rests at once, before the server's utterance.cancelled
        playing = false
        socket?.send(.bargeIn)
    }

    /// S09-F Try again: ask again with the user's last words. No other model is tried.
    func retryAnswer() {
        answerFailed = false
        guard let text = lastUserText else { return }
        socket?.send(.text(.init(text: text, frames: nil)))
    }

    /// FD-01 step 6 (AU-71): a link the user pasted (More ▸ Paste link on iPhone, Edit ▸ Paste Link on the Mac) goes
    /// out as the user's words; the server makes the link card (F10-13 summary / F10-14 couldn't open).
    /// false = nothing sent (no link in it, the call isn't live, or interpreting, where typed words are translated).
    @discardableResult func sendLink(_ pasted: String) -> Bool {
        guard let url = Self.firstLink(in: pasted), link == .live, mode != .interpret, let socket else { return false }
        socket.send(.text(.init(text: url, frames: nil)))
        return true
    }

    /// The first http(s) link in pasted text, trailing punctuation dropped (the server's findUrl reads the same).
    nonisolated static func firstLink(in text: String) -> String? {
        guard let r = text.range(of: #"https?://[^\s<>"')]+"#, options: [.regularExpression, .caseInsensitive]) else { return nil }
        var url = String(text[r])
        while let last = url.last, ".,!?".contains(last) { url.removeLast() }
        return url.count > 10 && url.count <= 2000 ? url : nil
    }

    /// IC-4 Look again: drop the card, take a fresh frame, ask the same words again (frames go with the next turn).
    func lookAgain() {
        let question = finds.lookAgain() ?? lastUserText
        guard let text = question else { return }
        if cameraOn, let frame = camera.snapshotBase64() {
            finds.latestFrames = [frame]
            socket?.send(.frames(.init(images: [frame])))
        }
        socket?.send(.text(.init(text: text, frames: nil)))
    }

    func dismissMicBlocked() { micDenied = false }
    /// E01/E02 sheet closed (Mac).
    func dismissDenied() { micDenied = false; cameraDenied = false }

    private func setMic(_ on: Bool) {
        if on {
            #if DEBUG
            if let fixture {
                fixture.enabled = true
                micOn = true
                socket?.send(.audioStart)
                fixture.micTurnedOn()
                return
            }
            #endif
            guard audio.openMic() else { micDenied = true; return }
            micOn = true
            socket?.send(.audioStart)
        } else {
            micOn = false
            #if DEBUG
            fixture?.enabled = false
            #endif
            audio.closeMic()
            socket?.send(.audioStop)
        }
    }

    private static func requestMicrophone(_ done: @escaping @MainActor (Bool) -> Void) {
        #if os(iOS)
        switch AVAudioApplication.shared.recordPermission {
        case .granted: done(true)
        case .denied: done(false)
        default:
            AVAudioApplication.requestRecordPermission { ok in DispatchQueue.main.async { MainActor.assumeIsolated { done(ok) } } }
        }
        #else
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: done(true)
        case .notDetermined: AVCaptureDevice.requestAccess(for: .audio) { ok in DispatchQueue.main.async { MainActor.assumeIsolated { done(ok) } } }
        default: done(false)
        }
        #endif
    }

    // MARK: connection

    private func connect() {
        let socket = makeSocket()
        self.socket = socket
        link = reconnectSince == nil ? .connecting : .reconnecting
        socket.onOpen = { [weak self, weak socket] in
            guard let self, let socket, self.socket === socket, var start = self.start else { return }
            start.history = Array(self.history.suffix(20))
            start.mode = self.mode
            start.mic = self.micOn
            socket.send(.start(start))
        }
        socket.onMessage = { [weak self, weak socket] message in
            guard let self, let socket, self.socket === socket else { return }
            #if DEBUG
            self.onServerMessage?(message)
            #endif
            switch message {
            case let .text(text): self.handle(text)
            case let .binary(data): self.handle(binary: data)
            }
        }
        socket.onClose = { [weak self, weak socket] closure in
            guard let self, let socket, self.socket === socket else { return }
            self.lost(closure)
        }
        let endpoint = fixedEndpoint ?? .current()
        socket.connect(url: endpoint.url, token: endpoint.token)
    }

    private func lost(_ closure: CallSocket.Closure) {
        log.info("socket closed: \(String(describing: closure), privacy: .public)")
        socket = nil
        pingTask?.cancel()
        perception.stop() // a new `ready` restarts it (Codex P2)
        flushPlayback()
        restFace()
        playing = false
        awaitingFirstAudio = false
        guard !userEnded else { return }
        if case let .server(code, _) = closure, let stop: CallStop = code == 4401 ? .signIn : code == 4403 ? .consent : code == 4001 ? .timeLimit : code == 4410 ? .companionReset : nil {
            // Reconnecting can't fix these; hand them to the router.
            stopped = stop
            link = .idle
            reconnectSince = nil
            if micOn { setMic(false) }
            return
        }
        // S09-R: keep trying. After 10 s the text fallback (S08-O, F4-L21) takes over once it exists.
        if reconnectSince == nil { reconnectSince = Date() }
        link = .reconnecting
        let waited = Date().timeIntervalSince(reconnectSince ?? Date())
        let delay = waited < 2 ? 0.5 : waited < 10 ? 1.5 : 3
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, !Task.isCancelled, !self.userEnded else { return }
            self.connect()
        }
    }

    private func keepAlive() {
        pingTask?.cancel()
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard let self, !Task.isCancelled else { return }
                self.socket?.send(.ping(t: Date().timeIntervalSince1970))
            }
        }
    }

    // MARK: server events

    func handle(_ text: String) {
        guard let event = try? ServerEvent.decode(text) else {
            log.error("undecodable event: \(text.prefix(120), privacy: .public)")
            return
        }
        handle(event)
    }

    func handle(_ event: ServerEvent) {
        captions.apply(event, now: Self.captionClock())   // live captions r01 (LiveCaptions.swift): reads events, changes nothing here
        switch event {
        case let .ready(r):
            // The new server session numbers utterances and audio sequences from the start again.
            // Cancel old render/player callbacks before clearing the previous session's tombstones.
            voice.cancel()
            audio.resetSession()
            flushRoutedAudio?()
            cancelled.removeAll()
            seqToUtterance.removeAll()
            saidOnDevice.removeAll()
            routed.removeAll()
            lookedUp.removeAll()
            currentUtterance = nil
            playingUtterance = nil
            playing = false
            awaitingFirstAudio = false
            speechEndAt = nil
            userAudioEndAt = nil
            firstFrame = nil
            emotion = nil
            holdTask?.cancel()
            interpretBoard = InterpretBoard(companionName: companionName)
            link = .live
            if r.sessionId != sessionId {
                // the old session's searches died with it: no result comes on this one (AU-62, AU-72)
                if sessionId != nil { finds.interrupted() }
                // A new session counts utterances from the start: ids of the old one mean nothing now.
                faceIdBase = faceIdMax + 1
                cancelled = []; routed = []; seqToUtterance = [:]; faceAudio = [:]; facePending = []; faceDeviceMs = [:]
            }
            start?.greetAfterMs = nil   // D21: only the very first connect waits; a reconnect doesn't greet again
            sessionId = r.sessionId
            reconnectSince = nil
            answerFailed = false
            interruptedHold = false
            lip = r.lip
            tts = r.tts ?? .server
            mode = r.mode
            interpretBoard.apply(event)
            phase = .listening
            keepAlive()
            perceptionOn = r.perception == true
            if perceptionOn { startPerception() } else { perception.stop() }
            log.info("ready session=\(r.sessionId, privacy: .public) lip=\(r.lip.active.rawValue, privacy: .public) tts=\(self.tts.rawValue, privacy: .public)")
            onConnected?()
        case let .state(s):
            setPhase(s.state)
        case .speechStart:
            answerFailed = false
            finds.userStartedTalking()
            if cameraOn, let frame = camera.snapshotBase64() {
                firstFrame = frame
                finds.latestFrames = [frame]
                socket?.send(.frames(.init(images: [frame])))
            } else {
                // a question asked with the camera off has no frames: an earlier question's never ride along (AU-75)
                finds.latestFrames = []
            }
        case .speechEnd:
            speechEndAt = Date()
            if cameraOn, let frame = camera.snapshotBase64() {
                // Two frames, ~start and ~end of the question, replace the single one sent at speech start.
                let images = [firstFrame, frame].compactMap { $0 }
                finds.latestFrames = images
                socket?.send(.frames(.init(images: images)))
            }
            firstFrame = nil
        case let .transcript(t):
            if t.final {
                lastUserText = t.text
                finds.latestQuestion = t.text
                history.append(.init(role: .user, text: t.text))
                if t.source == .text { speechEndAt = Date() }
            }
        case let .audio(a):
            seqToUtterance[a.seq] = a.utteranceId
            currentUtterance = a.utteranceId
            if face != nil, !cancelled.contains(a.utteranceId) {
                if faceAudio.count > 64 { faceAudio.removeAll() }   // frames that never came
                faceAudio[a.seq] = a
            }
        case let .say(sentence):
            // Device voice mode: speak it into the call's player (same AEC, flush and playback_done as server audio).
            guard !cancelled.contains(sentence.utteranceId), mayPlayHere else { break }
            currentUtterance = sentence.utteranceId
            saidOnDevice.insert(sentence.utteranceId)
            voice.say(sentence)
        case let .reply(r):
            if !r.interpret, !r.text.isEmpty { history.append(.init(role: .assistant, text: r.text)) }
            if !cancelled.contains(r.utteranceId), !routed.contains(r.utteranceId) {
                // Device mode: complete once every `say` of the reply is rendered into the player.
                if tts == .device || saidOnDevice.remove(r.utteranceId) != nil { voice.replyArrived(r.utteranceId) } else { audio.markComplete(utteranceId: r.utteranceId) }
            }
        case let .utteranceCancelled(c):
            cancelled.insert(c.utteranceId)
            face?.cancel(utteranceId: faceId(c.utteranceId))
            faceAudio = faceAudio.filter { $0.value.utteranceId != c.utteranceId }
            facePending.removeAll { $0.utterance == c.utteranceId }
            faceDeviceMs[c.utteranceId] = nil
            saidOnDevice.remove(c.utteranceId)
            flushPlayback()
            if routed.contains(c.utteranceId) { flushRoutedAudio?() }
            playing = false
            awaitingFirstAudio = false
            log.info("cancelled utterance=\(c.utteranceId) reason=\(c.reason.rawValue, privacy: .public)")
        case let .speaking(s):
            if s.on { emotion = s.emotion }
            if !cancelled.contains(s.utteranceId) { var e = s; e.utteranceId = faceId(s.utteranceId); feedFace(s.utteranceId) { $0.handle(speaking: e) } }
        case let .turnMetrics(m):
            log.info("turn.metrics utterance=\(m.utteranceId) server speechEnd→firstAudio=\(m.speechEndToFirstAudioMs ?? -1)ms firstToken=\(m.replyStartToFirstTokenMs ?? -1)ms audio=\(m.audioMs)ms speculative=\(m.speculative ?? "-", privacy: .public)")
        case let .tool(t):
            if t.name == "web_search", lookedUp.insert(t.utteranceId).inserted { findsCount += 1 }
        case let .error(e):
            log.error("server error \(e.code, privacy: .public): \(e.message, privacy: .public)")
            // daily_limit (D41 judge cap): the turn got no answer either; same "couldn't answer" state
            if e.code == "spark_unavailable" || e.code == "daily_limit" { answerFailed = true }
        case let .modeChanged(m):
            mode = m.mode
            if m.mode == .chat { start?.interpret = nil; uplink.callFraming = false }
            interpretBoard.companionName = companionName
            interpretBoard.apply(event)
        case .interpretPair, .interpretBubble:
            interpretBoard.companionName = companionName
            interpretBoard.apply(event)
        case let .lipChanged(l):
            lip = l.lip
        case .findStarted, .findProgress, .findItems, .observeBoxes, .findCreated, .findImage, .findFailed:
            finds.apply(event)
        case let .replyDelta(d):
            // Text shapes the mouth until (or unless) the audio brings word timings.
            if !cancelled.contains(d.utteranceId), !routed.contains(d.utteranceId) {
                var e = d; e.utteranceId = faceId(d.utteranceId)
                feedFace(d.utteranceId) { $0.handle(replyDelta: e) }
            }
        case let .audioTiming(t):
            // Server aligner (#210): word + phoneme times for one clause; they win where they cover.
            if !cancelled.contains(t.utteranceId), !routed.contains(t.utteranceId) {
                let id = faceId(t.utteranceId)
                let words = t.words.map(LipWordTiming.init)
                let phonemes = t.phonemes.map { LipPhonemeTiming(phoneme: $0.p, startMs: $0.s, endMs: $0.e) }
                feedFace(t.utteranceId) { $0.handle(timing: id, words: words, phonemes: phonemes) }
            }
        case let .companionNamed(n):
            // F2-L26: "Call yourself Max" — saved on the server; every {name} label follows
            companionName = n.name
            start?.persona.name = n.name   // a reconnect's start carries the new name too
            interpretBoard.companionName = n.name
            onCompanionNamed?(n.name)
        case let .profileUpdated(p):
            // CC-1 "Updated: …" / "Noted: …" (it answers the GK-1 question, so that chip goes)
            askingChip = nil; askingChipTask?.cancel()
            showProfileChip(p.text)
        case let .profileAsking(a):
            showAskingChip(a.topic)
        case let .expression(x):
            // expression layer (11/3, #284): one clause's feeling → the face's expression stills (eyes, brows, cheeks)
            if !cancelled.contains(x.utteranceId), !routed.contains(x.utteranceId) {
                let id = faceId(x.utteranceId)
                feedFace(x.utteranceId) { $0.handle(expression: x.tag, intensity: x.intensity, startMs: x.startMs, endMs: x.endMs, utteranceId: id) }
            }
        case .interpretDetected, .asrStatus, .pong, .unknown:
            break
        case let .backchannel(b):
            // convo P1 #345: the server's soft "mm-hm" in the companion's own voice, played beside (never as) a reply
            if let audio = b.audio, let pcm = Data(base64Encoded: audio) { self.audio.playCue(pcm: pcm) }
        }
    }

    func handle(binary data: Data) {
        guard let header = AudioFrameHeader(frame: data) else { return }
        guard header.kind == GenitaProtocol.frameKindTTSPCM else { return }
        let utterance = seqToUtterance.removeValue(forKey: header.seq) ?? currentUtterance ?? -1
        let timing = faceAudio.removeValue(forKey: header.seq)
        guard !cancelled.contains(utterance), mayPlayHere else { return }
        let route = interpretBoard.route(utteranceId: utterance)
        if route != .normal, let routeInterpretAudio {
            routed.insert(utterance)
            routeInterpretAudio(AudioFrameHeader.payload(of: data), route, utterance)
            return
        }
        // The face moves with what plays on this speaker; its clock is the same player's playhead.
        if let timing, timing.utteranceId == utterance {
            var e = timing; e.utteranceId = faceId(utterance)
            let pcm = AudioFrameHeader.payload(of: data)
            feedFace(utterance) { $0.handle(audio: e, pcm: pcm) }
        }
        #if DEBUG
        if let playbackSink { playbackSink(AudioFrameHeader.payload(of: data), utterance); return }
        #endif
        audio.enqueue(pcm: AudioFrameHeader.payload(of: data), utteranceId: utterance)
    }

    /// `profile.updated` chip: 2.5 s (PROTOCOL.md). Debug UI tests on slow simulators can lengthen it (GENITA_PROFILE_CHIP_MS).
    static var profileChipMs: Int {
        #if DEBUG
        if let ms = ProcessInfo.processInfo.environment["GENITA_PROFILE_CHIP_MS"].flatMap(Int.init) { return ms }
        #endif
        return 2500
    }

    /// GK-1 time on screen. Debug UI tests can change it (GENITA_ASKING_CHIP_MS).
    static var askingChipMs: Int {
        #if DEBUG
        if let ms = ProcessInfo.processInfo.environment["GENITA_ASKING_CHIP_MS"].flatMap(Int.init) { return ms }
        #endif
        return 6000
    }

    private func showAskingChip(_ raw: String) {
        let topic = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !topic.isEmpty else { return }
        askingChip = "Getting to know you · " + String(topic.prefix(48))
        askingChipTask?.cancel()
        askingChipTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(Self.askingChipMs))
            guard !Task.isCancelled else { return }
            self?.askingChip = nil
        }
        log.info("profile.asking chip")
    }

    private func showProfileChip(_ raw: String) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        profileChip = String(text.prefix(60))
        profileChipSerial += 1
        profileChipTask?.cancel()
        profileChipTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(Self.profileChipMs))
            guard !Task.isCancelled else { return }
            self?.profileChip = nil
        }
        log.info("profile.updated chip")
    }

    private func setPhase(_ next: Phase) {
        phase = next
        switch next {
        case .thinking:
            awaitingFirstAudio = true
            interruptedHold = false
            holdTask?.cancel()
        case .interrupted:
            // S09-X: "Stopped. Go ahead." for 1.2 s, then Listening. The server goes straight on to listening.
            interruptedHold = true
            awaitingFirstAudio = false
            holdTask?.cancel()
            holdTask = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(Self.interruptedHoldMs))
                guard !Task.isCancelled else { return }
                self?.interruptedHold = false
            }
        case .listening, .speaking:
            break
        }
        log.info("state \(next.rawValue, privacy: .public)")
    }


    /// Motion details cards 1 and 2: the user's voice (mic ring) and the reply (pill bars), 0…1, read every frame.
    var inputLevel: Float {
        #if DEBUG
        // motion lane evidence recordings: the simulator has no mic, so a speech-like envelope stands in (never in TestFlight)
        if micOn, ProcessInfo.processInfo.environment["GENITA_MOTION_DEMO_LEVEL"] == "1" {
            let t = Date.timeIntervalSinceReferenceDate
            return Float(max(0, sin(t * 2.2) * (0.55 + 0.45 * sin(t * 9.0))))
        }
        #endif
        return audio.inputLevel
    }
    var outputLevel: Float { audio.outputLevel }

    /// Device voice mouth hook: openness 0…1 of the speech playing now (from the rendered buffers), or nil.
    func deviceMouthLevel() -> Float? {
        guard tts == .device, let id = playingUtterance, let position = audio.playbackPositionMs(utteranceId: id) else { return nil }
        return voice.mouthLevel(utteranceId: id, positionMs: position)
    }

    private func playbackStarted(_ utteranceId: Int) {
        playingUtterance = utteranceId
        playing = true
        awaitingFirstAudio = false
        let now = Date()
        if let speechEndAt {
            let ms = Int(now.timeIntervalSince(speechEndAt) * 1000)
            latencies.append(ms)
            log.info("latency utterance=\(utteranceId) speech.end→playing=\(ms)ms")
        }
        #if DEBUG
        if let userAudioEndAt {
            log.info("latency utterance=\(utteranceId) userAudioEnd→playing=\(Int(now.timeIntervalSince(userAudioEndAt) * 1000))ms")
        }
        fixture?.playbackStarted()
        #endif
        speechEndAt = nil
        userAudioEndAt = nil
    }

    private func utterancePlayed(_ utteranceId: Int) {
        voice.forget(utteranceId)
        if playingUtterance == utteranceId { playingUtterance = nil }
        playing = audio.isPlaying
        flushFacePending()
        socket?.send(.playbackDone(utteranceId: utteranceId))
        #if DEBUG
        fixture?.utteranceDone()
        #endif
    }

    // MARK: face (L4)

    /// Shows this face set (nil → the still). The driver reads the speaker's playhead for the mouth.
    func useFace(_ set: FaceSet?, key: String?, owner: String? = nil, reduceMotion: Bool) {
        face?.stop()
        faceKey = key
        faceOwner = owner
        faceAudio = [:]
        facePending = []
        faceStill = nil
        facePoster = nil
        faceSetForPoster = set
        guard let set else { face = nil; return }
        let size = CompanionFace.outputSize(for: set)
        // one seed for the live face and its poster: same overscan and motion, so the poster → live step doesn't jump
        let seed = UInt64.random(in: 1...UInt64.max)
        faceSeed = seed
        posterReduceMotion = nil
        let driver = FaceDriver(faceSet: set, outputSize: size, reduceMotion: reduceMotion, seed: seed)
        driver.playbackClock = { [weak self, weak driver] in
            guard let self, let driver else { return nil }
            self.flushFacePending()
            guard let id = driver.currentUtteranceId else { return nil }
            return self.audio.playbackPositionMs(utteranceId: id - self.faceIdBase)
        }
        face = driver
        if faceOnScreen && faceAnimates { driver.start() }
        if !faceAnimates { renderFaceStill(set, size: size, for: driver) }
        // iPhone too since build 8: the generated face's rest frame shows before it moves (no upload-photo flash)
        renderFacePoster(set, size: size, seed: seed, reduceMotion: reduceMotion, for: driver)
    }

    /// The live renderer's settings (seed, reduce motion → same overscan and motion), at rest, off the main thread.
    private func renderFacePoster(_ set: FaceSet, size: CGSize, seed: UInt64, reduceMotion: Bool, for driver: FaceDriver) {
        posterReduceMotion = reduceMotion
        Task { [weak self] in
            let image = await Task.detached(priority: .utility) {
                FaceRenderer(faceSet: set, outputSize: size, seed: seed, reduceMotion: reduceMotion).render(at: 0, lip: .rest)
            }.value
            // a newer draw (reduce motion changed meanwhile) wins
            guard let self, self.face === driver, self.posterReduceMotion == reduceMotion else { return }
            self.facePoster = image
        }
    }

    /// Same presence (Mac, 11/3): load the companion's face set while the conversation is still on the iPhone, so
    /// the face that arrives here already moves on its first frame. Nothing animates until `showFace`.
    func prepareFace(reduceMotion: Bool) {
        guard !CompanionFace.clipLoopFace, !faceOnScreen else { return }
        faceReduceMotion = reduceMotion
        cancelFaceLoad()
        faceLoad = Task { [weak self] in await self?.loadFace() }
    }

    private func renderFaceStill(_ set: FaceSet, size: CGSize, for driver: FaceDriver) {
        Task { [weak self] in
            let image = await Task.detached(priority: .userInitiated) {
                FaceRenderer(faceSet: set, outputSize: size, seed: 1, reduceMotion: true).render(at: 0, lip: .rest)
            }.value
            guard let self, self.face === driver else { return }
            self.faceStill = image
        }
    }

    /// Barge-in, background, socket loss, hang-up: the mouth rests now and nothing queued for it stays.
    private func restFace() {
        face?.cancel()
        faceAudio = [:]
        facePending = []
        faceDeviceMs = [:]
    }

    /// The id the face driver sees for a server utterance id (grows across sessions).
    private func faceId(_ utterance: Int) -> Int {
        let id = faceIdBase + utterance
        faceIdMax = max(faceIdMax, id)
        return id
    }

    /// Device voice (`say`): the rendered PCM moves the mouth like server audio. Its offset in the reply is the
    /// audio rendered so far; the shapes come from the reply's `reply.delta` text.
    private func feedFaceDevicePCM(_ pcm: Data, utteranceId: Int) {
        guard !routed.contains(utteranceId) else { return }
        // Count every buffer that goes to the player, face or not, so a face that loads mid-reply stays in time.
        let offset = faceDeviceMs[utteranceId] ?? 0
        let ms = Int(PCM.durationMs(bytes: pcm.count).rounded())
        faceDeviceMs[utteranceId] = offset + ms
        if faceDeviceMs.count > 16 { faceDeviceMs = faceDeviceMs.filter { $0.key >= utteranceId - 4 } }
        guard face != nil else { return }
        let event = ServerEvent.Audio(utteranceId: faceId(utteranceId), seq: 0, sentence: 0, offsetMs: offset, durationMs: ms,
                                      sampleRate: GenitaProtocol.sampleRate, model: "device", words: [], mouth: nil)
        feedFace(utteranceId) { $0.handle(audio: event, pcm: pcm) }
    }

    /// The server utterance the face is on now.
    private var faceUtterance: Int? { face?.currentUtteranceId.map { $0 - faceIdBase } }

    private func feedFace(_ utterance: Int, _ apply: @escaping (FaceDriver) -> Void) {
        guard let face else { return }
        if facePending.contains(where: { $0.utterance == utterance }) || stillHearing(before: utterance) {
            if facePending.count > 512 { facePending.removeAll() }
            facePending.append((utterance, apply))
            return
        }
        apply(face)
    }

    /// True while the face's current reply is still audible and `utterance` is a later one whose own audio
    /// hasn't started yet.
    private func stillHearing(before utterance: Int) -> Bool {
        guard let current = faceUtterance, utterance > current,
              let heard = audio.playbackPositionMs(utteranceId: current), heard >= 0 else { return false }
        if let next = audio.playbackPositionMs(utteranceId: utterance), next >= 0 { return false }
        return true
    }

    /// Hands the earliest held reply to the face once its audio is what plays.
    private func flushFacePending() {
        guard let face, let first = facePending.first, !stillHearing(before: first.utterance) else { return }
        let ready = facePending.filter { $0.utterance == first.utterance }
        facePending.removeAll { $0.utterance == first.utterance }
        ready.forEach { $0.apply(face) }
    }

    /// The call screen appeared: load the companion's face set (if it has one) and animate it while the screen
    /// is up. `animate: false` (UI review stills) draws one frame and no display link.
    func showFace(reduceMotion: Bool, animate: Bool = true) {
        // Another account (or signed out) never sees the face set loaded for the one before.
        if face != nil, Self.tokenSubject(currentEndpoint.token) != faceOwner { useFace(nil, key: nil, reduceMotion: reduceMotion) }
        faceOnScreen = true
        #if DEBUG
        faceDebugShows += 1
        #endif
        faceAnimates = animate
        faceReduceMotion = reduceMotion
        face?.reduceMotion = reduceMotion
        refreshFacePoster()
        if animate { face?.start() }
        guard !CompanionFace.clipLoopFace else { return }
        // a load started while connecting (prepareFace) keeps going: restarting it was what left the upload photo
        // on screen for the first ~4 s of the call (build 6 device)
        // … unless it's for the account before (a sign-in meanwhile): that one never lands here
        if faceLoading, faceLoadOwner == Self.tokenSubject(currentEndpoint.token) { return }
        cancelFaceLoad()
        faceLoad = Task { [weak self] in await self?.loadFace() }
    }

    /// The call screen went away: no more frames.
    func hideFace() {
        faceOnScreen = false
        cancelFaceLoad()
        face?.stop()
    }

    /// Stops the load in flight and says so at once: a hide → show right after must start a new load, not wait for a
    /// cancelled one (AU-25 × #524 `faceLoading`).
    private func cancelFaceLoad() {
        faceLoad?.cancel()
        faceLoad = nil
        faceLoading = false
        faceLoadGeneration += 1
    }

    func setFaceReduceMotion(_ on: Bool) {
        faceReduceMotion = on
        face?.reduceMotion = on
        refreshFacePoster()
    }

    /// Reduce motion changed since the poster was drawn (it sets the overscan): draw it again to match (Codex P2).
    private func refreshFacePoster() {
        guard let face, let set = faceSetForPoster, let drawn = posterReduceMotion, drawn != faceReduceMotion else { return }
        renderFacePoster(set, size: CompanionFace.outputSize(for: set), seed: faceSeed, reduceMotion: faceReduceMotion, for: face)
    }

    /// AU-25 · S09-P (D28): a call that starts before the face set is made checks again this often while the call
    /// screen is up, so the mouth starts moving in that same call once prep finishes (or the network comes back).
    @ObservationIgnored var faceRetryInterval: Duration = .seconds(5)
    #if DEBUG
    /// UI-test diagnostics for the face pipeline (why a call shows the still instead of the face)
    var faceDebugShows = 0
    var faceDebugAttempts = 0
    var faceDebugLastError = ""
    var faceDebug: String {
        "shows=\(faceDebugShows) attempts=\(faceDebugAttempts) loading=\(faceLoading) onScreen=\(faceOnScreen) face=\(face != nil) poster=\(facePoster != nil) err=\(faceDebugLastError)"
    }
    #endif
    #if DEBUG
    /// Tests: the face set loader (stub server, temp cache) instead of the live one.
    @ObservationIgnored var faceLoaderOverride: ((CallEndpoint) -> CompanionFaceLoader)?
    #endif

    /// Loads the face set; while it isn't made yet (or the request failed) and the call screen is up, tries again
    /// every `faceRetryInterval` until it loads. `hideFace` (and a newer load) cancels the wait.
    private func loadFace() async {
        // #524: a load in flight makes showFace wait for it instead of restarting it. Only the newest load may say
        // it's over (a cancelled one finishing late must not clear a newer one's flag); cancels clear it at once.
        faceLoadGeneration += 1
        let generation = faceLoadGeneration
        faceLoading = true
        faceLoadOwner = Self.tokenSubject(currentEndpoint.token)
        defer { if faceLoadGeneration == generation { faceLoading = false } }
        while await loadFaceOnce() {
            try? await Task.sleep(for: faceRetryInterval)
            guard !Task.isCancelled, faceOnScreen, face == nil else { return }
        }
    }

    private func makeFaceLoader() -> CompanionFaceLoader {
        #if DEBUG
        if let faceLoaderOverride { return faceLoaderOverride(currentEndpoint) }
        #endif
        return CompanionFaceLoader(endpoint: currentEndpoint)
    }

    /// One load. True = no face yet but one may still come (prep still running, or offline): try again.
    private func loadFaceOnce() async -> Bool {
        #if DEBUG
        faceDebugAttempts += 1
        #endif
        let owner = Self.tokenSubject(currentEndpoint.token)
        do {
            let outcome: CompanionFaceLoader.Outcome
            #if DEBUG
            if let dir = ProcessInfo.processInfo.environment["GENITA_FACE_SET_DIR"] {
                // UI tests: a face set from a folder (manifest.json + images), no server.
                let key = "dir:" + dir
                outcome = key == faceKey ? .unchanged : .loaded(key: key, set: try await Task.detached { try FaceSet(directory: URL(fileURLWithPath: dir)) }.value)
            } else {
                outcome = try await makeFaceLoader().load(currentKey: faceKey)
            }
            #else
            outcome = try await makeFaceLoader().load(currentKey: faceKey)
            #endif
            guard !Task.isCancelled else { return false }
            switch outcome {
            case .unchanged: return false
            case .none: if face != nil { useFace(nil, key: nil, reduceMotion: faceReduceMotion) }; return false
            case .pending:
                if face != nil { useFace(nil, key: nil, reduceMotion: faceReduceMotion) }
                return faceOnScreen
            case let .loaded(key, set):
                log.info("face set \(key, privacy: .public): \(set.patches.count) mouth shapes; \(set.notes.joined(separator: "; "), privacy: .public)")
                useFace(set, key: key, owner: owner, reduceMotion: faceReduceMotion)
                return false
            }
        } catch {
            // Offline or the server said no: keep what is on screen (the still, or the face from before); with no
            // face yet, try again while the call screen is up.
            log.error("face set: \(String(describing: error), privacy: .public)")
            #if DEBUG
            faceDebugLastError = String(describing: error)
            #endif
            return !Task.isCancelled && faceOnScreen && face == nil
        }
    }

    #if DEBUG
    func fixtureUtteranceEnded(at date: Date) { userAudioEndAt = date }
    func sendFixtureAudio(_ frame: Data) { socket?.send(audio: frame) }
    #endif
}

final class Uplink: @unchecked Sendable {
    private let lock = NSLock()
    private var _socket: (any CallConnection)?
    private var _callFraming = false
    var socket: (any CallConnection)? {
        get { lock.withLock { _socket } }
        set { lock.withLock { _socket = newValue } }
    }
    /// Mac call interpretation (F8): every uplink frame carries a "GA" header, kind 3 mic / kind 4 call sound.
    var callFraming: Bool {
        get { lock.withLock { _callFraming } }
        set { lock.withLock { _callFraming = newValue } }
    }
    func send(_ frame: Data) {
        socket?.send(audio: callFraming ? Self.framed(GenitaProtocol.clientFrameKindMic, frame) : frame)
    }
    func sendCall(_ pcm: Data) {
        guard callFraming else { return }
        socket?.send(audio: Self.framed(GenitaProtocol.clientFrameKindCall, pcm))
    }
    static func framed(_ kind: UInt8, _ pcm: Data) -> Data {
        var out = AudioFrameHeader(kind: kind, seq: 0).encoded()
        out.append(pcm)
        return out
    }
}

extension ClientMessage.Start {
    /// The start message from what onboarding collected. Persona details beyond the name come from
    /// F2-L14 (personality) later; until login/DB land the app sends them itself (PROTOCOL.md).
    /// Lip source `none`: the device animates the companion face.
    static func companion(name: String, userName: String, profile: String, traits: [String], voiceId: String?) -> ClientMessage.Start {
        ClientMessage.Start(
            persona: .init(name: name, kind: .human, traits: traits.isEmpty ? nil : traits, voice: voiceId.map { .init(id: $0) }),
            user: .init(name: userName.isEmpty ? nil : userName, profile: profile.isEmpty ? nil : String(profile.prefix(4000))),
            mode: .chat, language: "English", lip: .init(mode: .none), mic: false)
    }
}
