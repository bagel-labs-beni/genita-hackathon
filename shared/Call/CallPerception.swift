import CoreImage
import Foundation
import Vision

/// PERC-2 (#320): while the camera is on in a call and the server asked for it (`ready.perception`), send a small
/// face crop now and then so the companion can notice a smile, a laugh, confusion or the user looking away.
/// On device there is no semantic judgement: Apple Vision only finds the face rectangle to crop (an OS feature,
/// like the rectangle detection the handoff uses), and plain pixel math decides whether the face changed.
/// The server's Muse Spark reads the expression. Nothing is stored.
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
    private let worker = DispatchQueue(label: "ai.thebeni.genita.perception", qos: .utility)

    var isRunning: Bool { task != nil }

    /// `frame`: the latest camera image (nil = none); `active`: whether to look at all right now; `send`: base64 JPEG.
    func start(frame: @escaping () -> CIImage?, active: @escaping () -> Bool, send: @escaping (String) -> Void) {
        stop()
        gate = PerceptionGate()
        task = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 500_000_000)
                guard let self, !Task.isCancelled else { return }
                guard active(), !self.busy, let image = frame() else { continue }
                self.busy = true
                self.worker.async {
                    let crop = FaceCrop.make(from: image)
                    DispatchQueue.main.async {
                        MainActor.assumeIsolated {
                            self.busy = false
                            guard let crop, self.task != nil, active() else { return }
                            if self.gate.shouldSend(now: Date(), thumb: crop.thumb) { send(crop.jpeg.base64EncodedString()) }
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
    }
}

/// The largest face, padded 25 %, as a ≤256 px JPEG, plus a 24×24 gray thumbnail for change detection.
enum FaceCrop {
    struct Result { let jpeg: Data; let thumb: [UInt8] }

    nonisolated static func make(from image: CIImage) -> Result? {
        let request = VNDetectFaceRectanglesRequest()
        let handler = VNImageRequestHandler(ciImage: image, options: [:])
        guard (try? handler.perform([request])) != nil,
              let face = request.results?.max(by: { $0.boundingBox.width * $0.boundingBox.height < $1.boundingBox.width * $1.boundingBox.height })
        else { return nil }
        let e = image.extent
        let box = face.boundingBox // normalized, origin bottom-left like CIImage
        var rect = CGRect(x: e.minX + box.minX * e.width, y: e.minY + box.minY * e.height, width: box.width * e.width, height: box.height * e.height)
        rect = rect.insetBy(dx: -rect.width * 0.25, dy: -rect.height * 0.25).intersection(e)
        guard rect.width >= 32, rect.height >= 32 else { return nil }
        let cropped = image.cropped(to: rect)
        guard let jpeg = CallCamera.jpeg(cropped, maxSide: 256, quality: 0.6), let thumb = thumbnail(cropped) else { return nil }
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
