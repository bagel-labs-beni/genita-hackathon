import AppKit
import ScreenCaptureKit
import CoreMedia
import QuartzCore
import os

@MainActor final class ScreenSharingController: NSObject, ObservableObject {
    @Published var permissionRequired = false {
        didSet { if permissionRequired { choosing = false; log.info("share: Screen Recording not allowed, permission sheet shown") } }
    }
    @Published var isSharing = false
    /// The macOS picker is open (the Share pill says "Choose a window"); a picker that never answers stays visible as
    /// that state, and pressing the pill again presents it again — never a press that does nothing.
    @Published private(set) var choosing = false
    /// "Stopped sharing" in the call cue for 1.6 s after the user stops (Share screen r01).
    @Published private(set) var stoppedCue = false
    private var stoppedCueTask: Task<Void, Never>?
    /// `log stream --predicate 'subsystem == "ai.thebeni.genita" AND category == "share"'` shows every step of a share.
    private let log = Logger(subsystem: "ai.thebeni.genita", category: "share")
    @Published var error: String?
    /// The alert's title: a share that ran and then ended (the system stopped the stream, the uplink dropped) is not
    /// "could not start" (Mac QA 11/3: macOS ended a live share and the alert said it never started).
    @Published var errorTitle = "Screen sharing could not start"
    /// MS-1, the first time Share is pressed.
    @Published var noticeVisible = false
    /// "Sharing Safari": the shared app's name, nil for a whole display.
    @Published var sourceName: String?
    /// The shared window's title (a browser tab: "<video title> - YouTube"), polled every 2 s while sharing.
    private var titleTask: Task<Void, Never>?
    private var pickedFilter: SCContentFilter?
    private var lastTitle: String?
    /// MS-3: the shared window captures (almost) black, or the server saw a DRM-black video in it (Netflix in a browser).
    @Published var blank = false
    /// what this Mac's capture says / what the server's last `state` said (AU-64): the card shows while either is on
    private var captureBlank = false
    private var serverBlank = false
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
        didSet { if isSharing, !adoptingLiveConfig, watchConfig != oldValue { disconnectUplink(); reconnectAttempt = 0; connectUplink(source: sourceName) } }
    }
    private var adoptingLiveConfig = false
    /// The live call's /v1/watch config (the same values MacConversationView passes on a session change).
    private static func liveCallConfig() -> WatchUplink.Config? {
        let call = CallController.shared
        guard call.link == .live, let id = call.sessionId else { return nil }
        return .init(server: call.currentEndpoint.url, token: call.currentEndpoint.token, sessionId: id)
    }
    private struct CaptureSession {
        let stream: SCStream
        let output: WatchStreamOutput
    }
    private var activeCapture: CaptureSession?
    private var startingCapture: CaptureSession?
    /// b16: macOS stopped the live stream by itself (-3821) and a restart is starting this capture again.
    private var restartingCapture: CaptureSession?
    /// When the restarts of this share happened (CACurrentMediaTime): 3 per minute, then the person is told.
    private var restartTimes: [Double] = []
    private var restartTask: Task<Void, Never>?
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
        if isSharing { stop(); showStoppedCue(); return }
        if !UserDefaults.standard.bool(forKey: Self.noticeKey) { noticeVisible = true; return }
        guard Self.screenAccess() else { permissionRequired = true; return }
        showPicker()
    }
    private func showStoppedCue() {
        stoppedCue = true
        AccessibilityNotification.Announcement("Stopped sharing").post()
        stoppedCueTask?.cancel()
        stoppedCueTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(1600))
            if !Task.isCancelled { self?.stoppedCue = false }
        }
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
        let request = captureRequest.begin()
        stopStartingCapture()
        var configuration = SCContentSharingPickerConfiguration()
        configuration.allowedPickerModes = [.singleDisplay, .singleWindow]
        if let id = Bundle.main.bundleIdentifier { configuration.excludedBundleIDs = [id] }
        SCContentSharingPicker.shared.defaultConfiguration = configuration
        // #318 review P1: a picker opened before the last stop/logout may still answer, and the shared picker's
        // callbacks don't say which presentation they belong to. Close it, and present this one only after its
        // answer (dropped by ScreenSharingRequest) or a short wait, so the next answer is this picker's.
        guard captureRequest.stalePicker else { return presentPicker() }
        SCContentSharingPicker.shared.isActive = false
        staleWait?.cancel()
        staleWait = Task { @MainActor [weak self] in
            for _ in 0..<15 {   // ≤ 1.5 s
                try? await Task.sleep(for: .milliseconds(100))
                guard let self, !Task.isCancelled, self.captureRequest.isCurrent(request) else { return }
                if !self.captureRequest.stalePicker { break }
            }
            guard let self, !Task.isCancelled, self.captureRequest.isCurrent(request) else { return }
            // The old picker answered (and was dropped): the next answer is this picker's, no guard. Otherwise
            // answers in the new picker's first second are still treated as the old one's (see start(_:replacing:)).
            if self.captureRequest.stalePicker { self.captureRequest.clearStalePicker(presentingAt: CACurrentMediaTime()) }
            self.presentPicker()
        }
    }
    private var staleWait: Task<Void, Never>?
    private func presentPicker() {
        // The call window is ordered in without activating Genita (a move, a launch at login): the system picker
        // only comes up for the active app, so a press could look like nothing happened.
        NSApp.activate()
        SCContentSharingPicker.shared.isActive = true
        SCContentSharingPicker.shared.present()
        choosing = true
        log.info("share: picker presented (screen access \(CGPreflightScreenCaptureAccess(), privacy: .public))")
    }
    func openSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") { NSWorkspace.shared.open(url) }
    }
    func stop() {
        staleWait?.cancel(); staleWait = nil
        captureRequest.invalidate()
        stopStartingCapture()
        stopRestart(); restartTimes = []
        let old = activeCapture; activeCapture = nil; isSharing = false; choosing = false
        SCContentSharingPicker.shared.isActive = false
        stopCapture(old)
        disconnectUplink(); reconnectAttempt = 0; connectionMessage = nil
        titleTask?.cancel(); titleTask = nil; pickedFilter = nil; lastTitle = nil
        reactingTask?.cancel(); reactingTask = nil
        blank = false; captureBlank = false; serverBlank = false; reacting = false; speakerName = nil; sourceName = nil
        WatchBleedGate.shared.sharedStopped()
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
    private func stopRestart() {
        restartTask?.cancel(); restartTask = nil
        let old = restartingCapture; restartingCapture = nil
        stopCapture(old)
    }
    private func cancelPicker() {
        // an old picker's late cancel is dropped by the request, and must not clear the open picker's state (Codex P3)
        guard captureRequest.cancelPicker(now: CACurrentMediaTime()) else { return }
        choosing = false
        log.info("share: picker cancelled")
    }
    /// End this account's capture, including a picker/start still in flight, before another account can sign in.
    func resetForSignOut() {
        stop()
        watchConfig = nil
        noticeVisible = false; permissionRequired = false; error = nil
    }
    private func start(_ picked: SCContentFilter, replacing stream: SCStream?) {
        choosing = false
        log.info("share: picked \(Self.sourceName(of: picked) ?? "a display", privacy: .public)")
        // Control Center can reselect an existing stream without showPicker().
        // Only a stream still owned by this account may authorize that selection.
        if let stream {
            guard activeCapture?.stream === stream || startingCapture?.stream === stream else { return }
            captureRequest.begin()
            stopStartingCapture()
        }
        guard let request = captureRequest.beginCapture(now: CACurrentMediaTime()) else {
            // A dropped answer (the old picker's) while this account still asked for one: show the picker again, so a
            // person who really picked that fast just picks once more instead of seeing nothing happen.
            if stream == nil, captureRequest.current != nil { presentPicker() }
            return
        }
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
                // a new pick while a restart waits or runs: the pick wins, with a fresh restart budget
                stopRestart(); restartTimes = []
                let old = activeCapture
                activeCapture = session
                stopCapture(old)
                blank = false; captureBlank = false; serverBlank = false
                isSharing = true; permissionRequired = false; sourceName = name
                log.info("share: capture started (audio on)")
                disconnectUplink(); reconnectAttempt = 0
                pickedFilter = picked
                lastTitle = nil // a new window: the next poll (≤2 s) sends its title; a fresh uplink starts without the old one
                connectUplink(source: name)
                startTitlePolling()
            } catch {
                guard captureRequest.isStarting(request) else { return }
                captureRequest.cancelCapture(request)
                stopStartingCapture()
                log.error("share: capture failed \(error.localizedDescription, privacy: .public)")
                // macOS refused the capture itself (Screen Recording off, or on but Genita not reopened yet): the
                // permission sheet with Open Settings, not an alert that only says it failed
                if !CGPreflightScreenCaptureAccess() { permissionRequired = true; return }
                self.errorTitle = "Screen sharing could not start"; self.error = error.localizedDescription
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
        // b16: a shared window dragged across displays, or partly off screen, keeps its whole picture (the system
        // clips a single-window capture to the display by default). An occluded window is captured as is by a
        // window filter; a minimized one has no pixels, ScreenCaptureKit has no setting for that.
        if picked.style == .window { config.ignoreGlobalClipSingleWindow = true }
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
            // b16: how loud the shared video is, for the mic's bleed gate (on this audio queue, no hop)
            WatchBleedGate.shared.noteShared(rms: WatchBleedGate.rms(int16: pcm))
            Task { @MainActor in
                guard let self, self.captureRequest.acceptsSamples(request), self.isSharing, self.callIsValid else { return }
                self.uplink?.sendAudio(pcm)
            }
        }
        capture.onBlank = { [weak self] on in
            Task { @MainActor in
                guard let self, self.captureRequest.acceptsSamples(request), self.isSharing else { return }
                self.captureBlank = on
                self.blank = on || self.serverBlank
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
        // The call window's view sets watchConfig when the session id changes; a view that appeared after the call
        // was already live never saw that change, so a share would wait for the call forever. Take it from the call.
        if watchConfig == nil, let live = Self.liveCallConfig() {
            adoptingLiveConfig = true; watchConfig = live; adoptingLiveConfig = false
        }
        guard callIsValid, let watchConfig else {
            log.info("share: waiting for the call (config \(self.watchConfig != nil, privacy: .public))")
            connectionMessage = "Screen sharing is waiting for the call."
            return
        }
        log.info("share: connecting /v1/watch")
        connectionMessage = reconnectAttempt == 0 ? "Connecting screen sharing…" : "Reconnecting screen sharing…"
        let generation = UUID(); uplinkGeneration = generation
        let link = WatchUplink(config: watchConfig) { [weak self] event in
            Task { @MainActor in
                guard let self, self.isSharing, self.uplinkGeneration == generation else { return }
                self.handle(event)
            }
        }
        uplink = link
        link.connect(source: source, title: lastTitle)
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
            // the server's verdict comes and goes on its own (a DRM video in a page that captures fine, AU-64)
            serverBlank = isBlank
            blank = isBlank || captureBlank
            if sharing, connectionMessage != nil {
                log.info("share: /v1/watch started, frames flowing")
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
            speakerName = nil; blank = false; captureBlank = false; serverBlank = false; reacting = false
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
            stop(); errorTitle = "Screen sharing stopped"; error = "Screen sharing disconnected. Try sharing again."
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
    private func startTitlePolling() {
        titleTask?.cancel()
        titleTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                if let self, self.isSharing, let filter = self.pickedFilter {
                    let title = await Self.windowTitle(of: filter)
                    if title != self.lastTitle {
                        self.lastTitle = title
                        self.uplink?.sendTitle(title) // no uplink now = reconnecting: connect() carries lastTitle
                    }
                }
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }
    /// What the page or video is called, as plain text: the shared window's title, or for a whole-display share the
    /// frontmost app's frontmost window on that display. ScreenCaptureKit gives it with the Screen Recording
    /// permission the share already has; no Accessibility permission, no OCR.
    private static func windowTitle(of filter: SCContentFilter) async -> String? {
        guard let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true) else { return nil }
        let mine = ProcessInfo.processInfo.processIdentifier
        let usable = content.windows.filter { $0.windowLayer == 0 && $0.owningApplication?.processID != mine && !($0.title ?? "").isEmpty }
        if #available(macOS 15.2, *), filter.style == .window, let id = filter.includedWindows.first?.windowID {
            let t: String? = content.windows.first(where: { $0.windowID == id })?.title
            return (t ?? "").isEmpty ? nil : t
        }
        guard #available(macOS 15.2, *), let display = filter.includedDisplays.first else { return nil }
        let onDisplay = usable.filter { $0.frame.intersects(display.frame) }
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let window = onDisplay.first(where: { $0.owningApplication?.processID == front }) ?? onDisplay.first
        return window?.title
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
    nonisolated func contentSharingPickerStartDidFailWithError(_ error: Error) {
        Task { @MainActor in
            self.choosing = false
            self.log.error("share: picker failed \(error.localizedDescription, privacy: .public)")
            if !CGPreflightScreenCaptureAccess() { self.permissionRequired = true; return }
            self.errorTitle = "Screen sharing could not start"; self.error = error.localizedDescription
        }
    }
}
extension ScreenSharingController: SCStreamDelegate {
    nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) {
        let ns = error as NSError
        let isStreamError = ns.domain == SCStreamErrorDomain
        let code = ns.code, domain = ns.domain, reason = ns.localizedDescription
        Task { @MainActor in
            // every stop is in the log with its code (QA 11/4: the share ended with no line at all at the stop)
            let which = self.activeCapture?.stream === stream ? "live" : self.startingCapture?.stream === stream ? "starting"
                : self.restartingCapture?.stream === stream ? "restarting" : "old"
            self.log.error("share: stream stopped (\(which, privacy: .public)) \(domain, privacy: .public) \(code, privacy: .public): \(reason, privacy: .public)")
            // a restart's own stream: its startCapture() throws and the restart handles it
            if self.restartingCapture?.stream === stream { return }
            if self.startingCapture?.stream === stream {
                if let request = self.startingCapture?.output.request { self.captureRequest.cancelCapture(request) }
                self.stopStartingCapture(); self.errorTitle = "Screen sharing could not start"; self.error = reason
                return
            }
            guard let live = self.activeCapture, live.stream === stream else { return }
            self.liveStreamStopped(live, isStreamError: isStreamError, code: code, reason: reason)
        }
    }
    nonisolated func streamDidBecomeInactive(_ stream: SCStream) {
        Task { @MainActor in self.log.info("share: stream inactive (every shared window closed)") }
    }
    nonisolated func streamDidBecomeActive(_ stream: SCStream) {
        Task { @MainActor in self.log.info("share: stream active again") }
    }
}

// MARK: - b16 restart after a system stop

extension ScreenSharingController {
    /// The live stream ended without the person pressing Stop in Genita: restart it quietly (the pill keeps saying
    /// "Sharing Safari", the /v1/watch uplink stays open and just gets no frames for a moment), up to 3 times a minute.
    private func liveStreamStopped(_ live: CaptureSession, isStreamError: Bool, code: Int, reason: String) {
        let now = CACurrentMediaTime()
        restartTimes = ScreenShareRestartPolicy.recentRestarts(restartTimes, now: now)
        switch ScreenShareRestartPolicy.action(isStreamError: isStreamError, code: code, restarts: restartTimes, now: now) {
        case .userStopped:
            log.info("share: stopped from the system controls")
            stop(); showStoppedCue()
        case .giveUp:
            log.error("share: not restarting (code \(code, privacy: .public), \(self.restartTimes.count, privacy: .public) restarts this minute)")
            stop(); errorTitle = "Screen sharing stopped"; error = "\(reason) Share again when you’re ready."
        case .restart(let delay):
            activeCapture = nil
            stopCapture(live)
            captureBlank = false; blank = serverBlank
            scheduleRestart(after: delay, request: live.output.request, now: now)
        }
    }

    private func scheduleRestart(after delay: Double, request: UInt64, now: Double) {
        restartTimes.append(now)
        let attempt = restartTimes.count
        log.info("share: restart \(attempt, privacy: .public) of \(ScreenShareRestartPolicy.delays.count, privacy: .public) this minute in \(delay, privacy: .public) s")
        restartTask?.cancel()
        restartTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(Int(delay * 1000)))
            guard let self, !Task.isCancelled, self.isSharing, self.captureRequest.acceptsSamples(request) else { return }
            await self.restart(request: request, attempt: attempt)
        }
    }

    private func restart(request: UInt64, attempt: Int) async {
        guard let picked = pickedFilter else { stop(); return }
        let sources = await Self.restartSources(for: picked)
        for source in sources {
            guard !Task.isCancelled, isSharing, captureRequest.acceptsSamples(request) else { return }
            let stream = SCStream(filter: source.filter, configuration: Self.configuration(for: source.filter), delegate: self)
            let output = WatchStreamOutput(stream: stream, request: request)
            wireCapture(output)
            do {
                try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: queue)
                try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: audioQueue)
                let session = CaptureSession(stream: stream, output: output)
                restartingCapture = session
                try await stream.startCapture()
                // stopped, logged out or picked again while it started: this stream is not the share any more
                guard restartingCapture?.stream === stream, !Task.isCancelled, isSharing, captureRequest.acceptsSamples(request) else {
                    output.invalidate(); try? await stream.stopCapture()
                    return
                }
                restartingCapture = nil
                activeCapture = session
                pickedFilter = source.filter
                if source.kind != .same { sourceName = source.name; lastTitle = nil }
                log.info("share: restart \(attempt, privacy: .public) ok (\(String(describing: source.kind), privacy: .public) \(source.name ?? "a display", privacy: .public))")
                // the server's watch session needs a frame now, not when the screen next changes
                queue.async { output.forceNextFrame() }
                return
            } catch {
                if restartingCapture?.stream === stream { restartingCapture = nil }
                output.invalidate()
                log.error("share: restart \(attempt, privacy: .public) \(String(describing: source.kind), privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
            }
        }
        guard !Task.isCancelled, isSharing, captureRequest.acceptsSamples(request) else { return }
        // nothing could start: try again inside the budget, then tell the person
        let now = CACurrentMediaTime()
        restartTimes = ScreenShareRestartPolicy.recentRestarts(restartTimes, now: now)
        if let delay = ScreenShareRestartPolicy.nextDelay(restarts: restartTimes, now: now) {
            scheduleRestart(after: delay, request: request, now: now)
        } else {
            log.error("share: restart gave up after \(self.restartTimes.count, privacy: .public) tries this minute")
            stop(); errorTitle = "Screen sharing stopped"; error = "macOS stopped screen sharing and it could not restart. Share again when you’re ready."
        }
    }

    private struct RestartSource {
        let kind: ScreenShareRestartPolicy.Source
        let filter: SCContentFilter
        let name: String?
    }

    /// The picked filter while its window (app, display) is still there; else its app on the display it was on, else
    /// that display (or one that is there), Genita's own windows left out like a picked display.
    private static func restartSources(for picked: SCContentFilter) async -> [RestartSource] {
        let same = RestartSource(kind: .same, filter: await excludingGenita(picked), name: sourceName(of: picked))
        guard #available(macOS 15.2, *),
              let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false) else { return [same] }
        let window = picked.includedWindows.first
        let oldApp = window?.owningApplication ?? picked.includedApplications.first
        let liveWindow = window.flatMap { w in content.windows.first { $0.windowID == w.windowID } }
        let liveApp = oldApp.flatMap { a in content.applications.first { $0.processID == a.processID } }
        let oldDisplay = picked.includedDisplays.first
        let liveDisplay = oldDisplay.flatMap { d in content.displays.first { $0.displayID == d.displayID } }
        let style: ScreenShareRestartPolicy.Style
        let stillThere: Bool
        switch picked.style {
        case .window: style = .window; stillThere = liveWindow != nil
        case .application: style = .application; stillThere = liveApp != nil
        default: style = .display; stillThere = liveDisplay != nil
        }
        // the display the source was on: the window's (now or last seen), the filter's, else the first one there
        let frame = liveWindow?.frame ?? window?.frame
        let display = frame.flatMap { f in content.displays.first { $0.frame.intersects(f) } } ?? liveDisplay ?? content.displays.first
        let mine = content.applications.filter { $0.processID == ProcessInfo.processInfo.processIdentifier }
        return ScreenShareRestartPolicy.candidates(style: style, sourceStillThere: stillThere).compactMap { kind in
            switch kind {
            case .same: return same
            case .application:
                guard let liveApp, let display else { return nil }
                return RestartSource(kind: .application, filter: SCContentFilter(display: display, including: [liveApp], exceptingWindows: []),
                                     name: liveApp.applicationName.isEmpty ? nil : liveApp.applicationName)
            case .display:
                guard let display else { return nil }
                return RestartSource(kind: .display, filter: SCContentFilter(display: display, excludingApplications: mine, exceptingWindows: []), name: nil)
            }
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
