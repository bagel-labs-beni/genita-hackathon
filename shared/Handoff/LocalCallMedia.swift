import AVFoundation
import SwiftUI

/// Local microphone and camera for the conversation screen. Nothing is stored or sent;
/// the AI and streaming connection comes later.
@MainActor final class LocalCallMedia: ObservableObject {
    enum Kind { case microphone, camera }
    @Published private(set) var micOn = false
    @Published private(set) var cameraOn = false
    /// The permission sheet to show (Figma E01, E02).
    @Published var denied: Kind?
    @Published private(set) var canFlip = false
    /// The rear camera may be held by position tracking; it must let go first.
    var beforeCameraStart: (() -> Void)?
    var onCameraChange: (() -> Void)?
    private let capture = CaptureWorker()
    var session: AVCaptureSession { capture.session }
    func toggleMic() {
        if micOn { micOn = false; capture.setMicrophone(false); return }
        withPermission(.microphone) { self.micOn = true; self.capture.setMicrophone(true) }
    }
    func toggleCamera() {
        if cameraOn { stopCamera(); return }
        withPermission(.camera) {
            guard self.capture.cameraAvailable else { return }
            self.beforeCameraStart?()
            self.cameraOn = true; self.canFlip = self.capture.canFlip
            self.capture.setCamera(true)
            self.onCameraChange?()
        }
    }
    func flipCamera() { capture.flipCamera() }
    /// The conversation left this device: nothing keeps listening or watching here.
    func stopAll() {
        if micOn { micOn = false; capture.setMicrophone(false) }
        if cameraOn { stopCamera() }
        denied = nil
    }
    private func stopCamera() {
        cameraOn = false; capture.setCamera(false)
        onCameraChange?()
    }
    private func withPermission(_ kind: Kind, granted: @escaping () -> Void) {
        let type: AVMediaType = kind == .camera ? .video : .audio
        switch AVCaptureDevice.authorizationStatus(for: type) {
        case .authorized: granted()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: type) { ok in
                DispatchQueue.main.async { [weak self] in if ok { granted() } else { self?.denied = kind } }
            }
        default: denied = kind
        }
    }
    func openSystemSettings(for kind: Kind) {
        #if os(iOS)
        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        #else
        let pane = kind == .camera ? "Privacy_Camera" : "Privacy_Microphone"
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?" + pane) { NSWorkspace.shared.open(url) }
        #endif
        denied = nil
    }
    #if DEBUG
    func showDeniedForReview(_ kind: Kind) { denied = kind }
    #endif
}

private final class CaptureWorker {
    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "ai.thebeni.genita.call-media")
    private var micInput: AVCaptureDeviceInput?
    private var cameraInput: AVCaptureDeviceInput?
    private let audioOutput = AVCaptureAudioDataOutput()
    private var front = true
    var cameraAvailable: Bool { camera(front: true) != nil }
    var canFlip: Bool {
        #if os(iOS)
        camera(front: true) != nil && camera(front: false) != nil
        #else
        false
        #endif
    }
    private func camera(front: Bool) -> AVCaptureDevice? {
        #if os(iOS)
        AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: front ? .front : .back)
        #else
        AVCaptureDevice.default(for: .video)
        #endif
    }
    func setMicrophone(_ on: Bool) {
        queue.async {
            self.session.beginConfiguration()
            if on, self.micInput == nil, let device = AVCaptureDevice.default(for: .audio), let input = try? AVCaptureDeviceInput(device: device), self.session.canAddInput(input) {
                self.session.addInput(input); self.micInput = input
                if self.session.canAddOutput(self.audioOutput) { self.session.addOutput(self.audioOutput) }
            } else if !on, let input = self.micInput {
                self.session.removeInput(input); self.micInput = nil
                self.session.removeOutput(self.audioOutput)
            }
            self.session.commitConfiguration()
            self.runIfNeeded()
        }
    }
    func setCamera(_ on: Bool) {
        queue.async {
            self.session.beginConfiguration()
            if let input = self.cameraInput { self.session.removeInput(input); self.cameraInput = nil }
            if on { self.front = true; self.addCamera() }
            self.session.commitConfiguration()
            self.runIfNeeded()
        }
    }
    func flipCamera() {
        queue.async {
            guard let input = self.cameraInput else { return }
            self.session.beginConfiguration()
            self.session.removeInput(input); self.cameraInput = nil
            self.front.toggle(); self.addCamera()
            self.session.commitConfiguration()
        }
    }
    private func addCamera() {
        guard let device = camera(front: front), let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else { return }
        session.addInput(input); cameraInput = input
    }
    private func runIfNeeded() {
        let wanted = micInput != nil || cameraInput != nil
        if wanted, !session.isRunning { session.startRunning() }
        if !wanted, session.isRunning { session.stopRunning() }
    }
}

#if os(iOS)
final class CameraPreviewSurface: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
}
struct SelfCameraPreview: UIViewRepresentable {
    let session: AVCaptureSession
    func makeUIView(context: Context) -> CameraPreviewSurface {
        let view = CameraPreviewSurface(); view.preview.session = session; view.preview.videoGravity = .resizeAspectFill
        return view
    }
    func updateUIView(_ view: CameraPreviewSurface, context: Context) {}
}
#else
struct SelfCameraPreview: NSViewRepresentable {
    let session: AVCaptureSession
    func makeNSView(context: Context) -> NSView {
        let view = NSView(); view.wantsLayer = true
        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill; preview.autoresizingMask = [.layerWidthSizable, .layerHeightSizable]
        if let connection = preview.connection, connection.isVideoMirroringSupported { connection.automaticallyAdjustsVideoMirroring = false; connection.isVideoMirrored = true }
        view.layer = preview
        return view
    }
    func updateNSView(_ view: NSView, context: Context) {}
}
#endif
