import AVFoundation
import CoreImage
import ImageIO
import UniformTypeIdentifiers
#if os(iOS)
import UIKit
#endif

/// The user's camera during a call: a preview for the self view, and still JPEGs for camera questions
/// (PROTOCOL `frames`: ≤2 JPEGs for the next user turn). Nothing is recorded or stored.
@MainActor final class CallCamera {
    private(set) var isOn = false
    private(set) var front = true
    let session = AVCaptureSession()
    private let worker = CameraWorker()
    private var observers: [NSObjectProtocol] = []

    init() {
        // b16 (TF 381, Chelsea: black camera after moving from the Mac): a capture session started while the app was
        // not active, or interrupted (another app, the system), never came back. It is started again when the
        // interruption ends and whenever the app becomes active with the camera still on.
        let center = NotificationCenter.default
        let restart: @Sendable (Notification) -> Void = { [weak self] _ in
            MainActor.assumeIsolated { self?.restartIfStalled() }
        }
        observers.append(center.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: .main, using: restart))
        #if os(iOS)
        observers.append(center.addObserver(forName: AVCaptureSession.interruptionEndedNotification, object: session, queue: .main, using: restart))
        observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main, using: restart))
        #endif
    }

    private func restartIfStalled() {
        guard isOn else { return }
        #if DEBUG
        if fixture != nil { return }
        #endif
        guard !session.isRunning || !worker.hasFreshFrame() else { return }
        worker.start(session: session, device: Self.device(front: front))
    }
    #if DEBUG
    /// Review/e2e only: a still image that stands in for the camera (the simulator has none).
    var fixture: CGImage?
    #endif

    var available: Bool {
        #if DEBUG
        if fixture != nil { return true }
        #endif
        return Self.device(front: true) != nil
    }
    var canFlip: Bool {
        #if DEBUG
        if fixture != nil { return isOn } // the stand-in camera "flips" too, so UI tests can drive D22
        #endif
        #if os(iOS)
        return isOn && Self.device(front: true) != nil && Self.device(front: false) != nil
        #else
        return false
        #endif
    }

    func start() {
        guard !isOn else { return }
        isOn = true
        front = true
        #if DEBUG
        if fixture != nil { return }
        #endif
        worker.start(session: session, device: Self.device(front: true))
    }

    func stop() {
        guard isOn else { return }
        isOn = false
        worker.stop(session: session)
    }

    func flip() {
        guard canFlip else { return }
        front.toggle()
        #if DEBUG
        if fixture != nil { return }
        #endif
        worker.switchDevice(session: session, device: Self.device(front: front))
    }

    /// The latest frame as a base64 JPEG (long side ≤ 768 px), or nil when the camera is off or has no frame yet.
    func snapshotBase64() -> String? {
        guard isOn else { return nil }
        #if DEBUG
        if let fixture { return Self.jpeg(CIImage(cgImage: fixture))?.base64EncodedString() }
        #endif
        guard let image = worker.latest() else { return nil }
        return Self.jpeg(image)?.base64EncodedString()
    }

    /// The latest frame as a base64 JPEG plus whether it is too dark / blurry to see anything (D59).
    func snapshot() -> (base64: String, unclear: Bool)? {
        guard isOn else { return nil }
        #if DEBUG
        if let fixture {
            let image = CIImage(cgImage: fixture)
            return Self.jpeg(image).map { ($0.base64EncodedString(), FrameQuality.unclear(image)) }
        }
        #endif
        guard let image = worker.latest() else { return nil }
        // b16: a black frame (camera not really delivering) is never sent: the turn goes on as without the camera
        let reading = FrameQuality.read(image)
        if let reading, FrameQuality.isBlack(reading) { restartIfStalled(); return nil }
        guard let jpeg = Self.jpeg(image) else { return nil }
        return (jpeg.base64EncodedString(), reading.map(FrameQuality.unclear) ?? false)
    }

    /// D63: the newest frame as it is (no JPEG), for the mask motion check.
    func latestImage() -> CIImage? {
        guard isOn else { return nil }
        #if DEBUG
        if let fixture { return CIImage(cgImage: fixture) }
        #endif
        return worker.latest()
    }

    /// PERC-2: the latest frame for the perception face crop, only if it came from the front camera (iPhone).
    /// The frame carries its own camera, so a flip or a quick off/on can never pass a rear-camera face as the user's.
    func latestFrontImage() -> CIImage? {
        guard isOn else { return nil }
        #if DEBUG
        if let fixture { return CIImage(cgImage: fixture) }
        #endif
        return worker.latestFront()
    }

    nonisolated static func jpeg(_ image: CIImage, maxSide: CGFloat = 768, quality: CGFloat = 0.6) -> Data? {
        let extent = image.extent
        guard extent.width > 0, extent.height > 0 else { return nil }
        let scale = min(1, maxSide / max(extent.width, extent.height))
        let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let context = CIContext(options: [.useSoftwareRenderer: false])
        guard let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        return context.jpegRepresentation(of: scaled, colorSpace: space, options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: quality])
    }

    nonisolated static func device(front: Bool) -> AVCaptureDevice? {
        #if os(iOS)
        AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: front ? .front : .back)
        #else
        AVCaptureDevice.default(for: .video)
        #endif
    }
}

private final class CameraWorker: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    private let queue = DispatchQueue(label: "ai.thebeni.genita.call-camera")
    private let output = AVCaptureVideoDataOutput()
    private var input: AVCaptureDeviceInput?
    private let lock = NSLock()
    private var frame: CIImage?
    /// which camera `frame` came from
    private var framePosition: AVCaptureDevice.Position = .unspecified
    /// b16: when `frame` arrived (uptime); a frame older than `staleS` is not the camera now (interrupted / stopped)
    private var frameAt: TimeInterval = 0
    static let staleS: TimeInterval = 1.5

    func hasFreshFrame() -> Bool { lock.withLock { frame != nil && ProcessInfo.processInfo.systemUptime - frameAt < Self.staleS } }

    func start(session: AVCaptureSession, device: AVCaptureDevice?) {
        queue.async {
            session.beginConfiguration()
            session.sessionPreset = .high
            self.attach(session: session, device: device)
            if session.canAddOutput(self.output), !session.outputs.contains(self.output) {
                self.output.alwaysDiscardsLateVideoFrames = true
                self.output.setSampleBufferDelegate(self, queue: self.queue)
                session.addOutput(self.output)
            }
            self.orient()
            session.commitConfiguration()
            if !session.isRunning { session.startRunning() }
        }
    }

    func stop(session: AVCaptureSession) {
        queue.async {
            if session.isRunning { session.stopRunning() }
            session.beginConfiguration()
            if let input = self.input { session.removeInput(input); self.input = nil }
            session.commitConfiguration()
            self.lock.withLock { self.frame = nil }
        }
    }

    func switchDevice(session: AVCaptureSession, device: AVCaptureDevice?) {
        queue.async {
            session.beginConfiguration()
            self.attach(session: session, device: device)
            self.orient()
            session.commitConfiguration()
        }
    }

    func latest() -> CIImage? {
        lock.withLock { ProcessInfo.processInfo.systemUptime - frameAt < Self.staleS ? frame : nil }
    }

    func latestFront() -> CIImage? {
        lock.withLock { () -> CIImage? in
            guard ProcessInfo.processInfo.systemUptime - frameAt < Self.staleS else { return nil }
            #if os(iOS)
            guard framePosition == .front else { return nil }
            #endif
            return frame // the Mac has one camera, facing the user
        }
    }

    private func attach(session: AVCaptureSession, device: AVCaptureDevice?) {
        if let input { session.removeInput(input); self.input = nil }
        guard let device, let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else { return }
        session.addInput(input)
        self.input = input
    }

    /// Frames for the model should be upright, as the user sees the scene.
    private func orient() {
        #if os(iOS)
        guard let connection = output.connection(with: .video) else { return }
        if connection.isVideoRotationAngleSupported(90) { connection.videoRotationAngle = 90 }
        #endif
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let image = CIImage(cvPixelBuffer: pixels)
        let position = (connection.inputPorts.first?.input as? AVCaptureDeviceInput)?.device.position ?? .unspecified
        let now = ProcessInfo.processInfo.systemUptime
        lock.withLock { frame = image; framePosition = position; frameAt = now }
    }
}
