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
    /// The shared window's title (a browser tab: "<video title> - YouTube"), polled every 2 s while sharing.
    private var titleTask: Task<Void, Never>?
    private var pickedFilter: SCContentFilter?
    private var lastTitle: String?
    /// MS-3: the shared window captures (almost) black.
    @Published var blank = false
    /// MS-2: the companion reacted first; shown 1.5 s.
    @Published var reacting = false
    /// FT-SPK: who is talking in the shared video (never what they say).
    @Published var speakerName: String?
    /// Set by the call client from `ready` (server, token, sessionId). Nil = capture stays on this Mac.
    var watchConfig: WatchUplink.Config? = {
        #if DEBUG
        WatchUplink.Config.fromEnvironment()
        #else
        nil
        #endif
    }() {
        // a reconnect gives the call a new session id: a running share moves to it (or starts, if it began before ready)
        didSet { if isSharing, watchConfig != oldValue { uplink?.stop(); uplink = nil; connectUplink(source: sourceName) } }
    }
    private var stream: SCStream?
    private var uplink: WatchUplink?
    private let capture = WatchCapture()
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
        let old = stream; stream = nil; isSharing = false
        SCContentSharingPicker.shared.isActive = false
        if let old { Task { try? await old.stopCapture() } }
        uplink?.stop(); uplink = nil
        titleTask?.cancel(); titleTask = nil; pickedFilter = nil; lastTitle = nil
        blank = false; reacting = false; speakerName = nil; sourceName = nil
        let capture = capture
        queue.async { capture.reset() }
    }
    private func start(_ picked: SCContentFilter) {
        Task {
            do {
                let filter = await Self.excludingGenita(picked)
                let name = Self.sourceName(of: picked)
                pickedFilter = picked
                let config = Self.configuration(for: picked)
                if let stream {
                    // re-picked mid-call (another window or the whole screen): same stream, the new picture's size,
                    // and the server hears the new source name
                    try await stream.updateContentFilter(filter)
                    try? await stream.updateConfiguration(config)
                    sourceName = name
                    uplink?.updateSource(name)
                    return
                }
                let newStream = SCStream(filter: filter, configuration: config, delegate: self)
                try newStream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
                try newStream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
                wireCapture()
                try await newStream.startCapture()
                stream = newStream; isSharing = true; permissionRequired = false; sourceName = name
                connectUplink(source: name)
                startTitlePolling()
            } catch { self.error = error.localizedDescription; isSharing = false }
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
    private func wireCapture() {
        let capture = capture
        capture.onFrame = { [weak self] jpeg, blank, motion in
            Task { @MainActor in self?.uplink?.sendFrame(jpeg, blank: blank, motion: motion) }
        }
        capture.onAudio = { [weak self] pcm in
            Task { @MainActor in self?.uplink?.sendAudio(pcm) }
        }
        capture.onBlank = { [weak self] on in
            Task { @MainActor in self?.blank = on }
        }
    }
    private func connectUplink(source: String?) {
        guard let watchConfig else { return }
        let link = WatchUplink(config: watchConfig) { [weak self] event in
            Task { @MainActor in self?.handle(event) }
        }
        uplink = link
        link.connect(source: source)
    }
    private func handle(_ event: WatchUplink.Event) {
        switch event {
        case .state(_, let isBlank): blank = isBlank || blank
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
        case .closed: speakerName = nil
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
                if let self, let filter = self.pickedFilter {
                    let title = await Self.windowTitle(of: filter)
                    if title != self.lastTitle {
                        self.lastTitle = title
                        self.uplink?.sendTitle(title)
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
    nonisolated func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {}
    nonisolated func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) { Task { @MainActor in self.start(filter) } }
    nonisolated func contentSharingPickerStartDidFailWithError(_ error: Error) { Task { @MainActor in self.error = error.localizedDescription } }
}
extension ScreenSharingController: SCStreamDelegate, SCStreamOutput {
    nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) { Task { @MainActor in self.stop(); self.error = error.localizedDescription } }
    nonisolated func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        // Frames and sound go to the watch uplink only while sharing; nothing is stored on disk.
        switch type {
        case .screen: capture.handleScreen(sampleBuffer)
        case .audio: capture.handleAudio(sampleBuffer)
        default: break
        }
    }
}
