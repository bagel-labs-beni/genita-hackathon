import CoreImage
import Foundation

/// PERC-2 (#320): while the camera is on in a call and the server asked for it (`ready.perception`), send a small
/// crop of the selfie face region now and then so the companion can notice a smile, a laugh, confusion or the user
/// looking away. No AI on device (runtime AI is Meta-only): the crop is fixed geometry and plain pixel math decides
/// whether the picture changed. The server's Muse Spark reads everything. Nothing is stored.
struct PerceptionGate {
    var minGap: TimeInterval = 1.0
    var every: TimeInterval = 2.5
    /// mean absolute difference of the 24×24 gray thumbnails, 0…1
    var changeThreshold: Double = 0.06
    private(set) var lastSentAt: Date?
    private(set) var lastThumb: [UInt8] = []

    /// True = send this crop now (and remember it as the last one sent).
    mutating func shouldSend(now: Date, thumb: [UInt8]) -> Bool {
        let since = lastSentAt.map { now.timeIntervalSince($0) } ?? .infinity
        let changed = Self.difference(lastThumb, thumb) >= changeThreshold
        guard since >= every || (changed && since >= minGap) else { return false }
        lastSentAt = now
        lastThumb = thumb
        return true
    }

    static func difference(_ a: [UInt8], _ b: [UInt8]) -> Double {
        guard !a.isEmpty, a.count == b.count else { return 1 }
        var sum = 0
        for i in a.indices { sum += abs(Int(a[i]) - Int(b[i])) }
        return Double(sum) / Double(a.count) / 255
    }

    /// Only for the user's face: server flag on, front camera, a chat (never interpretation), socket live.
    static func active(serverOn: Bool, cameraOn: Bool, front: Bool, mode: ConversationMode, live: Bool) -> Bool {
        serverOn && cameraOn && front && mode == .chat && live
    }
}

/// Samples the camera at ~2 fps on the main actor; the crop and thumbnail run off the main thread.
@MainActor final class PerceptionSampler {
    private var gate = PerceptionGate()
    private var task: Task<Void, Never>?
    private var busy = false
    /// bumped on every start/stop: a crop from an earlier run is dropped (call ended, socket lost)
    private(set) var generation = 0
    private let worker = DispatchQueue(label: "ai.thebeni.genita.perception", qos: .utility)

    var isRunning: Bool { task != nil }

    /// `frame`: the latest camera image (nil = none); `active`: whether to look at all right now; `send`: base64 JPEG.
    func start(frame: @escaping () -> CIImage?, active: @escaping () -> Bool, send: @escaping (String) -> Void) {
        stop()
        gate = PerceptionGate()
        generation += 1
        task = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 500_000_000)
                guard let self, !Task.isCancelled else { return }
                guard active(), !self.busy, let image = frame() else { continue }
                self.busy = true
                let gen = self.generation
                self.worker.async {
                    let crop = FaceCrop.make(from: image)
                    DispatchQueue.main.async {
                        MainActor.assumeIsolated {
                            if gen == self.generation { self.busy = false }
                            guard let crop else { return }
                            self.deliver(crop, generation: gen, active: active(), send: send)
                        }
                    }
                }
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
        busy = false
        generation += 1
    }

    /// Send a finished crop if it belongs to the current run and the call still wants faces.
    func deliver(_ crop: FaceCrop.Result, generation gen: Int, active: Bool, now: Date = Date(), send: (String) -> Void) {
        guard gen == generation, task != nil, active else { return }
        if gate.shouldSend(now: now, thumb: crop.thumb) { send(crop.jpeg.base64EncodedString()) }
    }
}

/// The selfie face region as a 320 px JPEG, plus a 24×24 gray thumbnail for change detection.
enum FaceCrop {
    struct Result { let jpeg: Data; let thumb: [UInt8] }

    /// Long side of the JPEG sent up (256–384 px; the server reads it with Muse Spark).
    static let side: CGFloat = 320

    /// The selfie face region by plain geometry (no face detection: runtime AI is Meta-only, Spark reads the face).
    /// A square as wide as the short side, centred horizontally; its centre sits 45 % from the top in portrait
    /// (iPhone held at arm's length) and in the middle in landscape (Mac). Tuned on the 11/3 eval (portrait call
    /// frames: 36 % / 80 % cut mouths off). Same numbers as `selfieRegion` in genita-server/scripts/perception-eval.ts.
    /// CIImage origin is bottom-left.
    nonisolated static func region(in e: CGRect) -> CGRect {
        let side = min(e.width, e.height)
        let fromTop: CGFloat = e.height > e.width ? 0.45 : 0.5
        let midY = e.maxY - e.height * fromTop
        var r = CGRect(x: e.midX - side / 2, y: midY - side / 2, width: side, height: side)
        if r.maxY > e.maxY { r.origin.y = e.maxY - side }
        if r.minY < e.minY { r.origin.y = e.minY }
        return r
    }

    nonisolated static func make(from image: CIImage) -> Result? {
        let e = image.extent
        guard e.width >= 64, e.height >= 64 else { return nil }
        let cropped = image.cropped(to: region(in: e))
        guard let jpeg = CallCamera.jpeg(cropped, maxSide: side, quality: 0.6), let thumb = thumbnail(cropped) else { return nil }
        return Result(jpeg: jpeg, thumb: thumb)
    }

    nonisolated static func thumbnail(_ image: CIImage, side: Int = 24) -> [UInt8]? {
        let e = image.extent
        guard e.width > 0, e.height > 0 else { return nil }
        let small = image
            .transformed(by: CGAffineTransform(translationX: -e.minX, y: -e.minY))
            .transformed(by: CGAffineTransform(scaleX: CGFloat(side) / e.width, y: CGFloat(side) / e.height))
        var bytes = [UInt8](repeating: 0, count: side * side)
        let context = CIContext(options: [.useSoftwareRenderer: false])
        bytes.withUnsafeMutableBytes { buf in
            context.render(small, toBitmap: buf.baseAddress!, rowBytes: side, bounds: CGRect(x: 0, y: 0, width: side, height: side), format: .L8, colorSpace: nil)
        }
        return bytes
    }
}
