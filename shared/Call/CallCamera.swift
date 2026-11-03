import AVFoundation
import CoreImage
import ImageIO
import UniformTypeIdentifiers

/// The user's camera during a call: a preview for the self view, and still JPEGs for camera questions
/// (PROTOCOL `frames`: ≤2 JPEGs for the next user turn). Nothing is recorded or stored.
@MainActor final class CallCamera {
    private(set) var isOn = false
    private(set) var front = true
    let session = AVCaptureSession()
    private let worker = CameraWorker()
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

    func latest() -> CIImage? { lock.withLock { frame } }

    func latestFront() -> CIImage? {
        lock.withLock { () -> CIImage? in
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
        lock.withLock { frame = image; framePosition = position }
    }
}
