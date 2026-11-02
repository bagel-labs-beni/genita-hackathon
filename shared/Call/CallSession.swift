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
    private(set) var cameraDenied = false
    private(set) var mode: ConversationMode = .chat
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
    /// Peter worker details from `lip.changed` (bundle, pasteDy, fps) for the F4-L18 mouth layer.
    private(set) var peter: ServerEvent.LipChanged.Peter?
    private(set) var emotion: String?
    /// Web lookups this call (More → Finds). The F10 sheet lists them.
    private(set) var findsCount = 0
    /// Client-side latency per answered turn: ASR end of speech → reply audio playing.
    private(set) var latencies: [Int] = []
    var companionName = "Jin"

    var cue: CallCue {
        CallCue.derive(link: link, phase: phase, playing: playing, awaitingFirstAudio: awaitingFirstAudio, micOn: micOn,
                       interruptedHold: interruptedHold, answerFailed: answerFailed, micDenied: micDenied)
    }
    var canFlipCamera: Bool { cameraOn && camera.canFlip }
    var cameraSession: AVCaptureSession { camera.session }

    @ObservationIgnored let camera = CallCamera()
    @ObservationIgnored private let audio = CallAudio()
    @ObservationIgnored private let voice = DeviceVoice()
    @ObservationIgnored private var socket: CallSocket? { didSet { uplink.socket = socket } }
    /// The mic thread's way to the socket.
    @ObservationIgnored private let uplink = Uplink()
    @ObservationIgnored private var start: ClientMessage.Start?
    @ObservationIgnored private var history: [ClientMessage.HistoryItem] = []
    @ObservationIgnored private var lastUserText: String?
    @ObservationIgnored private var seqToUtterance: [UInt32: Int] = [:]
    @ObservationIgnored private var cancelled: Set<Int> = []
    @ObservationIgnored private var currentUtterance: Int?
    @ObservationIgnored private var lookedUp: Set<Int> = []
    @ObservationIgnored private var mouth = PeterMouthBuffer()
    @ObservationIgnored private var playingUtterance: Int?
    @ObservationIgnored private var speechEndAt: Date?
    @ObservationIgnored private var userAudioEndAt: Date?
    @ObservationIgnored private var firstFrame: String?
    @ObservationIgnored private var reconnectSince: Date?
    @ObservationIgnored private var reconnectTask: Task<Void, Never>?
    @ObservationIgnored private var holdTask: Task<Void, Never>?
    @ObservationIgnored private var pingTask: Task<Void, Never>?
    @ObservationIgnored private var userEnded = true
    @ObservationIgnored private var fixedEndpoint: CallEndpoint?
    @ObservationIgnored let log = Logger(subsystem: "ai.thebeni.genita", category: "call")
    #if DEBUG
    @ObservationIgnored var fixture: FixtureMic?
    /// Debug tap on everything the server sends (session recording for replay tests).
    @ObservationIgnored var onServerMessage: ((CallSocket.Incoming) -> Void)?
    #endif

    init() {
        audio.onMicFrame = { [uplink] frame in uplink.send(frame) }
        audio.onPlaybackStarted = { [weak self] id in self?.playbackStarted(id) }
        audio.onUtterancePlayed = { [weak self] id in self?.utterancePlayed(id) }
        audio.onInterrupted = { [weak self] in self?.suspend() }
        voice.onPCM = { [weak self] pcm, id in
            guard let self, !self.cancelled.contains(id) else { return }
            self.audio.enqueue(pcm: pcm, utteranceId: id)
        }
        voice.onRendered = { [weak self] id in
            guard let self, !self.cancelled.contains(id) else { return }
            self.audio.markComplete(utteranceId: id)
        }
    }

    /// Stop the companion's sound now: server audio and device speech alike (barge-in, cancel, background).
    private func flushPlayback() {
        voice.cancel()
        audio.flush()
    }

    // MARK: lifecycle

    /// Opens the call. Mic stays off until the user turns it on (F4-L22 default).
    func begin(_ start: ClientMessage.Start, endpoint: CallEndpoint? = nil) {
        guard userEnded else { return }
        userEnded = false
        stopped = nil
        fixedEndpoint = endpoint
        var s = start
        s.mic = false
        self.start = s
        history = s.history ?? []
        mode = s.mode ?? .chat
        audio.start()
        connect()
        #if DEBUG
        installFixtures()
        #endif
    }

    func end() {
        userEnded = true
        reconnectTask?.cancel(); pingTask?.cancel(); holdTask?.cancel()
        socket?.close()
        socket = nil
        voice.cancel()
        audio.stop()
        camera.stop()
        micOn = false; cameraOn = false; playing = false; link = .idle
        reconnectSince = nil; cancelled = []; seqToUtterance = [:]; lookedUp = []; findsCount = 0
        phase = .listening; awaitingFirstAudio = false; interruptedHold = false; answerFailed = false
        #if DEBUG
        fixture?.stop()
        #endif
    }

    /// Background, screen off, or a phone call: stop the sound and close the mic and camera.
    func suspend() {
        guard !userEnded else { return }
        if micOn { setMic(false) }
        if cameraOn { toggleCamera() }
        if playing || phase == .speaking || phase == .thinking { socket?.send(.bargeIn) }
        flushPlayback()
        playing = false
    }

    // MARK: user actions

    func toggleMic() {
        if micOn { setMic(false); return }
        micDenied = false
        #if DEBUG
        if fixture != nil { setMic(true); return }
        #endif
        Self.requestMicrophone { [weak self] granted in
            guard let self else { return }
            if granted { self.setMic(true) } else { self.micDenied = true }
        }
    }

    func toggleCamera() {
        if cameraOn { camera.stop(); cameraOn = false; return }
        cameraDenied = false
        let go = { [weak self] in
            guard let self, self.camera.available else { return }
            self.camera.start()
            self.cameraOn = true
        }
        #if DEBUG
        if camera.fixture != nil { go(); return }
        #endif
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: go()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { ok in DispatchQueue.main.async { MainActor.assumeIsolated { if ok { go() } else { self.cameraDenied = true } } } }
        default: cameraDenied = true
        }
    }

    func flipCamera() { camera.flip() }

    /// S09-X hold. Debug UI tests on slow simulators can lengthen it (GENITA_INTERRUPT_HOLD_MS).
    static var interruptedHoldMs: Int {
        #if DEBUG
        if let ms = ProcessInfo.processInfo.environment["GENITA_INTERRUPT_HOLD_MS"].flatMap(Int.init) { return ms }
        #endif
        return 1200
    }

    func setInterpreting(_ on: Bool) {
        let next: ConversationMode = on ? .interpret : .chat
        guard next != mode else { return }
        mode = next
        start?.mode = next
        socket?.send(.mode(next))
    }

    /// Tap on the face while the companion talks: stop now, the server cancels the reply.
    func interrupt() {
        guard playing || phase == .speaking || phase == .thinking else { return }
        flushPlayback()
        playing = false
        socket?.send(.bargeIn)
    }

    /// S09-F Try again: ask again with the user's last words. No other model is tried.
    func retryAnswer() {
        answerFailed = false
        guard let text = lastUserText else { return }
        socket?.send(.text(.init(text: text, frames: nil)))
    }

    func dismissMicBlocked() { micDenied = false }

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
        let socket = CallSocket()
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
        flushPlayback()
        playing = false
        awaitingFirstAudio = false
        guard !userEnded else { return }
        if case let .server(code, _) = closure, let stop: CallStop = code == 4401 ? .signIn : code == 4403 ? .consent : code == 4001 ? .timeLimit : nil {
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
        switch event {
        case let .ready(r):
            link = .live
            reconnectSince = nil
            answerFailed = false
            interruptedHold = false
            lip = r.lip
            tts = r.tts ?? .server
            mode = r.mode
            phase = .listening
            keepAlive()
            log.info("ready session=\(r.sessionId, privacy: .public) lip=\(r.lip.active.rawValue, privacy: .public) tts=\(self.tts.rawValue, privacy: .public)")
        case let .state(s):
            setPhase(s.state)
        case .speechStart:
            answerFailed = false
            if cameraOn, let frame = camera.snapshotBase64() {
                firstFrame = frame
                socket?.send(.frames(.init(images: [frame])))
            }
        case .speechEnd:
            speechEndAt = Date()
            if cameraOn, let frame = camera.snapshotBase64() {
                // Two frames, ~start and ~end of the question, replace the single one sent at speech start.
                socket?.send(.frames(.init(images: [firstFrame, frame].compactMap { $0 })))
            }
            firstFrame = nil
        case let .transcript(t):
            if t.final {
                lastUserText = t.text
                history.append(.init(role: .user, text: t.text))
                if t.source == .text { speechEndAt = Date() }
            }
        case let .audio(a):
            seqToUtterance[a.seq] = a.utteranceId
            currentUtterance = a.utteranceId
        case let .say(sentence):
            // Device voice mode: speak it into the call's player (same AEC, flush and playback_done as server audio).
            guard !cancelled.contains(sentence.utteranceId) else { break }
            currentUtterance = sentence.utteranceId
            voice.say(sentence)
        case let .reply(r):
            if !r.interpret, !r.text.isEmpty { history.append(.init(role: .assistant, text: r.text)) }
            if !cancelled.contains(r.utteranceId) {
                // Device mode: complete once every `say` of the reply is rendered into the player.
                if tts == .device { voice.replyArrived(r.utteranceId) } else { audio.markComplete(utteranceId: r.utteranceId) }
            }
        case let .utteranceCancelled(c):
            cancelled.insert(c.utteranceId)
            mouth.cancel(c.utteranceId)
            flushPlayback()
            playing = false
            awaitingFirstAudio = false
            log.info("cancelled utterance=\(c.utteranceId) reason=\(c.reason.rawValue, privacy: .public)")
        case let .speaking(s):
            if s.on { emotion = s.emotion }
        case let .turnMetrics(m):
            log.info("turn.metrics utterance=\(m.utteranceId) server speechEnd→firstAudio=\(m.speechEndToFirstAudioMs ?? -1)ms firstToken=\(m.replyStartToFirstTokenMs ?? -1)ms audio=\(m.audioMs)ms speculative=\(m.speculative ?? "-", privacy: .public)")
        case let .tool(t):
            if t.name == "web_search", lookedUp.insert(t.utteranceId).inserted { findsCount += 1 }
        case let .error(e):
            log.error("server error \(e.code, privacy: .public): \(e.message, privacy: .public)")
            if e.code == "spark_unavailable" { answerFailed = true }
        case let .modeChanged(m):
            mode = m.mode
        case let .lipChanged(l):
            // Only matters once the app asks for `peter` (F4-L18); kept so the face can switch layers then.
            lip = l.lip
            peter = l.peter
        case .interpretDetected, .replyDelta, .asrStatus, .pong, .unknown:
            break
        }
    }

    func handle(binary data: Data) {
        guard let header = AudioFrameHeader(frame: data) else { return }
        if header.kind == GenitaProtocol.frameKindPeter {
            // seq = utteranceId; payload = frame index + 256 px JPEG crop (F4-L17)
            if let crop = AudioFrameHeader.peterCrop(of: data) { mouth.add(utteranceId: Int(header.seq), frame: crop.frame, jpeg: crop.jpeg) }
            return
        }
        guard header.kind == GenitaProtocol.frameKindTTSPCM else { return }
        let utterance = seqToUtterance.removeValue(forKey: header.seq) ?? currentUtterance ?? -1
        guard !cancelled.contains(utterance) else { return }
        audio.enqueue(pcm: AudioFrameHeader.payload(of: data), utteranceId: utterance)
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

    /// F4-L18 hook: the Peter crop to composite now (at `peter.pasteDy`), or nil to keep the silent loop.
    func mouthFrame() -> Data? {
        guard let id = playingUtterance, let position = audio.playbackPositionMs(utteranceId: id) else { return nil }
        return mouth.frame(utteranceId: id, positionMs: position)
    }

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
        mouth.finish(utteranceId)
        voice.forget(utteranceId)
        if playingUtterance == utteranceId { playingUtterance = nil }
        playing = audio.isPlaying
        socket?.send(.playbackDone(utteranceId: utteranceId))
        #if DEBUG
        fixture?.utteranceDone()
        #endif
    }

    #if DEBUG
    func fixtureUtteranceEnded(at date: Date) { userAudioEndAt = date }
    func sendFixtureAudio(_ frame: Data) { socket?.send(audio: frame) }
    #endif
}

final class Uplink: @unchecked Sendable {
    private let lock = NSLock()
    private var _socket: CallSocket?
    var socket: CallSocket? {
        get { lock.withLock { _socket } }
        set { lock.withLock { _socket = newValue } }
    }
    func send(_ frame: Data) { socket?.send(audio: frame) }
}

extension ClientMessage.Start {
    /// The start message from what onboarding collected. Persona details beyond the name come from
    /// F2-L14 (personality) later; until login/DB land the app sends them itself (PROTOCOL.md).
    /// Lip source `none` for now: the silent loop plays as is until the Peter layer (F4-L18) asks for `peter`.
    static func companion(name: String, userName: String, profile: String, traits: [String], voiceId: String?) -> ClientMessage.Start {
        ClientMessage.Start(
            persona: .init(name: name, kind: .human, traits: traits.isEmpty ? nil : traits, voice: voiceId.map { .init(id: $0) }),
            user: .init(name: userName.isEmpty ? nil : userName, profile: profile.isEmpty ? nil : String(profile.prefix(4000))),
            mode: .chat, language: "English", lip: .init(mode: .none), mic: false)
    }
}
