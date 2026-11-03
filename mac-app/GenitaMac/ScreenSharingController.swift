import AppKit
import ScreenCaptureKit
import CoreMedia

@MainActor final class ScreenSharingController: NSObject, ObservableObject {
    @Published var permissionRequired = false
    @Published var isSharing = false
    @Published var error: String?
    /// MS-1, the first time Share is pressed.
    @Published var noticeVisible = false
    /// "Sharing Safari": the shared app's name, nil for a whole display.
    @Published var sourceName: String?
    /// MS-3: the shared window captures (almost) black.
    @Published var blank = false
    /// MS-2: the companion reacted first; shown 1.5 s.
    @Published var reacting = false
    /// FT-SPK: who is talking in the shared video (never what they say).
    @Published var speakerName: String?
    /// A capture is not a working share until /watch acknowledges `start`.
    @Published private(set) var connectionMessage: String?
    /// Set by the call client from `ready` (server, token, sessionId). Nil = capture stays on this Mac.
    var watchConfig: WatchUplink.Config? = {
        #if DEBUG
        WatchUplink.Config.fromEnvironment()
        #else
        nil
        #endif
    }() {
        // a reconnect gives the call a new session id: a running share moves to it (or starts, if it began before ready)
        didSet { if isSharing, watchConfig != oldValue { disconnectUplink(); reconnectAttempt = 0; connectUplink(source: sourceName) } }
    }
    private struct CaptureSession {
        let stream: SCStream
        let output: WatchStreamOutput
    }
    private var activeCapture: CaptureSession?
    private var startingCapture: CaptureSession?
    private var captureRequest = ScreenSharingRequest()
    private var uplink: WatchUplink?
    private var uplinkGeneration = UUID()
    private var reconnectAttempt = 0
    private var reconnectTask: Task<Void, Never>?
    private var reactingTask: Task<Void, Never>?
    private static let noticeKey = "genita.watch.noticeShown"
    private let queue = DispatchQueue(label: "ai.thebeni.genita.mac.screen-sharing")
    private let audioQueue = DispatchQueue(label: "ai.thebeni.genita.mac.screen-sharing.audio")
    override init() { super.init(); SCContentSharingPicker.shared.add(self) }
    func requestSharing() {
        if isSharing { stop(); return }
        if !UserDefaults.standard.bool(forKey: Self.noticeKey) { noticeVisible = true; return }
        guard Self.screenAccess() else { permissionRequired = true; return }
        showPicker()
    }
    /// First run: macOS lists Genita under Screen Recording only after the app asks once. Without this request
    /// "Open Settings" lands on a list with no Genita in it. The system prompt shows once; later calls just answer.
    private static func screenAccess() -> Bool {
        if CGPreflightScreenCaptureAccess() { return true }
        if !UserDefaults.standard.bool(forKey: askedKey) {
            UserDefaults.standard.set(true, forKey: askedKey)
            return CGRequestScreenCaptureAccess()
        }
        return false
    }
    private static let askedKey = "genita.watch.screenAccessAsked"
    /// MS-1 "Choose what to share".
    func acceptNotice() {
        UserDefaults.standard.set(true, forKey: Self.noticeKey)
        noticeVisible = false
        guard Self.screenAccess() else { permissionRequired = true; return }
        showPicker()
    }
    func showPicker() {
        captureRequest.begin()
        stopStartingCapture()
        var configuration = SCContentSharingPickerConfiguration()
        configuration.allowedPickerModes = [.singleDisplay, .singleWindow]
        if let id = Bundle.main.bundleIdentifier { configuration.excludedBundleIDs = [id] }
        SCContentSharingPicker.shared.defaultConfiguration = configuration
        SCContentSharingPicker.shared.isActive = true
        SCContentSharingPicker.shared.present()
    }
    func openSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") { NSWorkspace.shared.open(url) }
    }
    func stop() {
        captureRequest.invalidate()
        stopStartingCapture()
        let old = activeCapture; activeCapture = nil; isSharing = false
        SCContentSharingPicker.shared.isActive = false
        stopCapture(old)
        disconnectUplink(); reconnectAttempt = 0; connectionMessage = nil
        reactingTask?.cancel(); reactingTask = nil
        blank = false; reacting = false; speakerName = nil; sourceName = nil
    }
    private func stopCapture(_ session: CaptureSession?) {
        guard let session else { return }
        session.output.invalidate()
        Task { try? await session.stream.stopCapture() }
    }
    private func stopStartingCapture() {
        let old = startingCapture; startingCapture = nil
        stopCapture(old)
    }
    private func cancelPicker() {
        captureRequest.cancelPicker()
    }
    /// End this account's capture, including a picker/start still in flight, before another account can sign in.
    func resetForSignOut() {
        stop()
        watchConfig = nil
        noticeVisible = false; permissionRequired = false; error = nil
    }
    private func start(_ picked: SCContentFilter, replacing stream: SCStream?) {
        // Control Center can reselect an existing stream without showPicker().
        // Only a stream still owned by this account may authorize that selection.
        if let stream {
            guard activeCapture?.stream === stream || startingCapture?.stream === stream else { return }
            captureRequest.begin()
            stopStartingCapture()
        }
        guard let request = captureRequest.beginCapture() else { return }
        Task {
            do {
                guard captureRequest.isStarting(request) else { return }
                let filter = await Self.excludingGenita(picked)
                guard captureRequest.isStarting(request) else { return }
                let name = Self.sourceName(of: picked)
                let config = Self.configuration(for: picked)
                // Reselection gets the new source's size and uplink name with a fresh,
                // request-bound stream so queued media from the old source stays isolated.
                let newStream = SCStream(filter: filter, configuration: config, delegate: self)
                let output = WatchStreamOutput(stream: newStream, request: request)
                wireCapture(output)
                try newStream.addStreamOutput(output, type: .screen, sampleHandlerQueue: queue)
                try newStream.addStreamOutput(output, type: .audio, sampleHandlerQueue: audioQueue)
                let session = CaptureSession(stream: newStream, output: output)
                startingCapture = session // stop/logout can also see a start still in flight.
                try await newStream.startCapture()
                guard startingCapture?.stream === newStream, captureRequest.completeCapture(request) else {
                    output.invalidate()
                    try? await newStream.stopCapture()
                    return
                }
                startingCapture = nil
                let old = activeCapture
                activeCapture = session
                stopCapture(old)
                blank = false
                isSharing = true; permissionRequired = false; sourceName = name
                disconnectUplink(); reconnectAttempt = 0
                connectUplink(source: name)
            } catch {
                guard captureRequest.isStarting(request) else { return }
                captureRequest.cancelCapture(request)
                stopStartingCapture()
                self.error = error.localizedDescription
            }
        }
    }
    private static func configuration(for picked: SCContentFilter) -> SCStreamConfiguration {
        let config = SCStreamConfiguration()
        // long side ≤ 768 px; sampled 4 fps, sent ≤3 fps and only when changed (motion-aware watching, 11/3)
        let px = CGSize(width: picked.contentRect.width * CGFloat(picked.pointPixelScale), height: picked.contentRect.height * CGFloat(picked.pointPixelScale))
        let fit = min(1, 768 / max(px.width, px.height, 1))
        config.width = max(2, Int(px.width * fit)); config.height = max(2, Int(px.height * fit))
        config.minimumFrameInterval = CMTime(value: 1, timescale: 4)
        config.showsCursor = false
        // the shared screen's sound, never Genita's own voice
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 24_000
        config.channelCount = 1
        return config
    }
    private func wireCapture(_ output: WatchStreamOutput) {
        let request = output.request
        let capture = output.capture
        capture.onFrame = { [weak self] jpeg, blank, motion in
            Task { @MainActor in
                guard let self, self.captureRequest.acceptsSamples(request), self.isSharing, self.callIsValid else { return }
                self.uplink?.sendFrame(jpeg, blank: blank, motion: motion)
            }
        }
        capture.onAudio = { [weak self] pcm in
            Task { @MainActor in
                guard let self, self.captureRequest.acceptsSamples(request), self.isSharing, self.callIsValid else { return }
                self.uplink?.sendAudio(pcm)
            }
        }
        capture.onBlank = { [weak self] on in
            Task { @MainActor in
                guard let self, self.captureRequest.acceptsSamples(request), self.isSharing else { return }
                self.blank = on
            }
        }
    }
    private var callIsValid: Bool {
        let call = CallController.shared
        return WatchReconnectPolicy.callIsValid(configuredSession: watchConfig?.sessionId, activeSession: call.sessionId,
                                                isLive: call.link == .live, isOwner: MacHandoff.shared.ownership.isOwner,
                                                isSignedIn: MacCall.shared.isSignedIn)
    }
    private func disconnectUplink() {
        reconnectTask?.cancel(); reconnectTask = nil
        uplinkGeneration = UUID()
        uplink?.stop(); uplink = nil
    }
    private func connectUplink(source: String?) {
        guard isSharing else { return }
        guard callIsValid, let watchConfig else {
            connectionMessage = "Screen sharing is waiting for the call."
            return
        }
        connectionMessage = reconnectAttempt == 0 ? "Connecting screen sharing…" : "Reconnecting screen sharing…"
        let generation = UUID(); uplinkGeneration = generation
        let link = WatchUplink(config: watchConfig) { [weak self] event in
            Task { @MainActor in
                guard let self, self.isSharing, self.uplinkGeneration == generation else { return }
                self.handle(event)
            }
        }
        uplink = link
        link.connect(source: source)
        // An opened socket without a start acknowledgement must not hang forever.
        reconnectTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(10))
            guard let self, !Task.isCancelled, self.uplinkGeneration == generation else { return }
            self.handle(.closed)
        }
    }
    private func handle(_ event: WatchUplink.Event) {
        switch event {
        case .state(let sharing, let isBlank):
            guard callIsValid else { disconnectUplink(); connectionMessage = "Screen sharing is disconnected."; return }
            blank = isBlank || blank
            if sharing, connectionMessage != nil {
                connectionMessage = nil; reconnectAttempt = 0
                reconnectTask?.cancel(); reconnectTask = nil
                // The new server session needs a frame even if the screen has not changed.
                if let output = activeCapture?.output {
                    queue.async { output.forceNextFrame() }
                }
            }
        case .reaction:
            // MS-2 first reaction (Chelsea 11/2 21:10: watch together is back, reactions on)
            reacting = true
            reactingTask?.cancel()
            reactingTask = Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(1500))
                if !Task.isCancelled { self.reacting = false }
            }
        // The speaker chip (FT-SPK) stays cut (D40): who is talking in the video never shows.
        case .speaker: break
        case .closed:
            disconnectUplink()
            speakerName = nil; blank = false; reacting = false
            reactingTask?.cancel(); reactingTask = nil
            recoverUplink()
        }
    }
    private func recoverUplink() {
        switch WatchReconnectPolicy.recoveryAction(attempt: reconnectAttempt, isSharing: isSharing,
            callIsValid: callIsValid, isCallActive: CallController.shared.link != .idle,
            isOwner: MacHandoff.shared.ownership.isOwner, isSignedIn: MacCall.shared.isSignedIn) {
        case .waitForCall:
            connectionMessage = "Screen sharing is waiting for the call."
        case .stop:
            stop(); error = "Screen sharing disconnected. Try sharing again."
        case .retry(let delay):
            reconnectAttempt += 1
            connectionMessage = "Reconnecting screen sharing…"
            let generation = uplinkGeneration
            reconnectTask = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(delay))
                guard let self, !Task.isCancelled, self.uplinkGeneration == generation else { return }
                guard self.isSharing, self.callIsValid else {
                    self.recoverUplink()
                    return
                }
                self.connectUplink(source: self.sourceName)
            }
        }
    }
    /// A whole-display share leaves Genita's own windows out of the picture.
    private static func excludingGenita(_ filter: SCContentFilter) async -> SCContentFilter {
        guard filter.style == .display, #available(macOS 15.2, *), let display = filter.includedDisplays.first,
              let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) else { return filter }
        let mine = content.applications.filter { $0.processID == ProcessInfo.processInfo.processIdentifier }
        return SCContentFilter(display: display, excludingApplications: mine, exceptingWindows: [])
    }
    private static func sourceName(of filter: SCContentFilter) -> String? {
        guard #available(macOS 15.2, *) else { return nil }
        if let app = filter.includedWindows.first?.owningApplication?.applicationName, !app.isEmpty { return app }
        if let app = filter.includedApplications.first?.applicationName, !app.isEmpty { return app }
        return nil
    }
}
extension ScreenSharingController: SCContentSharingPickerObserver {
    nonisolated func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) { Task { @MainActor in if stream == nil { self.cancelPicker() } } }
    nonisolated func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) { Task { @MainActor in self.start(filter, replacing: stream) } }
    nonisolated func contentSharingPickerStartDidFailWithError(_ error: Error) { Task { @MainActor in self.error = error.localizedDescription } }
}
extension ScreenSharingController: SCStreamDelegate {
    nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) {
        Task { @MainActor in
            if self.startingCapture?.stream === stream {
                if let request = self.startingCapture?.output.request { self.captureRequest.cancelCapture(request) }
                self.stopStartingCapture(); self.error = error.localizedDescription
                return
            }
            guard self.activeCapture?.stream === stream else { return }
            self.stop(); self.error = error.localizedDescription
        }
    }
}

/// Each SCStream owns its media processor and immutable request binding. The lock
/// serializes screen/audio intake with invalidation; callbacks are set before registration.
private final class WatchStreamOutput: NSObject, SCStreamOutput, @unchecked Sendable {
    let request: UInt64
    let capture = WatchCapture()
    private let lock = NSLock()
    private var gate: ScreenSharingSampleGate

    init(stream: SCStream, request: UInt64) {
        self.request = request
        gate = ScreenSharingSampleGate(request: request, stream: ObjectIdentifier(stream))
        super.init()
    }

    func invalidate() {
        lock.lock(); defer { lock.unlock() }
        gate.invalidate()
        capture.reset()
    }

    /// Replay uses the same lock as media intake and invalidation, so a stopped
    /// stream's frame cannot be replayed into a new capture or account.
    func forceNextFrame() {
        lock.lock(); defer { lock.unlock() }
        capture.forceNextFrame()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        lock.lock(); defer { lock.unlock() }
        guard gate.accepts(stream: ObjectIdentifier(stream), request: request) else { return }
        switch type {
        case .screen: capture.handleScreen(sampleBuffer)
        case .audio: capture.handleAudio(sampleBuffer)
        default: break
        }
    }
}
