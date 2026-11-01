import AppKit
import ScreenCaptureKit
import CoreMedia

@MainActor final class ScreenSharingController: NSObject, ObservableObject {
    @Published var permissionRequired = false
    @Published var isSharing = false
    @Published var error: String?
    private var stream: SCStream?
    private let queue = DispatchQueue(label: "ai.thebeni.genita.mac.screen-sharing")
    override init() { super.init(); SCContentSharingPicker.shared.add(self) }
    func requestSharing() {
        if isSharing { stop(); return }
        guard CGPreflightScreenCaptureAccess() else { permissionRequired = true; return }
        showPicker()
    }
    func showPicker() {
        var configuration = SCContentSharingPickerConfiguration()
        configuration.allowedPickerModes = [.singleDisplay, .singleWindow]
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
    }
    private func start(_ filter: SCContentFilter) {
        Task {
            do {
                if let stream { try await stream.updateContentFilter(filter); return }
                let config = SCStreamConfiguration()
                config.width = 1280; config.height = 720
                config.minimumFrameInterval = CMTime(value: 1, timescale: 10)
                config.capturesAudio = false; config.showsCursor = true
                let newStream = SCStream(filter: filter, configuration: config, delegate: self)
                try newStream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
                try await newStream.startCapture()
                stream = newStream; isSharing = true; permissionRequired = false
            } catch { self.error = error.localizedDescription; isSharing = false }
        }
    }
}
extension ScreenSharingController: SCContentSharingPickerObserver {
    nonisolated func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {}
    nonisolated func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) { Task { @MainActor in self.start(filter) } }
    nonisolated func contentSharingPickerStartDidFailWithError(_ error: Error) { Task { @MainActor in self.error = error.localizedDescription } }
}
extension ScreenSharingController: SCStreamDelegate, SCStreamOutput {
    nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) { Task { @MainActor in self.isSharing = false; self.stream = nil; self.error = error.localizedDescription } }
    nonisolated func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        // Frames remain local. No storage or AI/network transmission is connected yet.
    }
}
