import CoreImage
import Foundation

/// D63 · masks on a hand-held camera (S3). The masks are found on the frame taken when the question ended and land
/// seconds later on the live preview. They stay up (with #676's hold, until the companion has named what she sees)
/// and fade out only when the phone has really moved, then come back once the picture lines up again.
///
/// v2 from the S3 mask lane (`_qa-scripts/genita-demo/s3-mask-lane/motion-sim-v2.txt`). #631's plain mean difference
/// hid the masks on a 3 % hand shake, a 2° tilt and a small exposure change. v2:
///   1. blur, then downscale to 32 × 18 luma (the blur keeps texture and edges from aliasing into the thumbnail);
///   2. compare mean-normalised (exposure drift cancels), at the best shift within ±4 columns / ±3 rows;
///   3. a sample "hits" when that shift is ≥ 9 % of the frame or what is left after it is > 0.09;
///   4. hysteresis: hide after 2 hits in a row; show again after 2 settled samples in a row (shift ≤ 7 %, rest ≤ 0.07).
/// Sim (3 scenes): still, 1–4 % shake, 2° tilt, 4 % zoom, exposure +0.06 and motion blur → keep;
/// pans of 8 % and more, 10 % vertical, and 4° tilt with a 2 % shift → hide.
enum CameraMotion {
    static let width = 32
    static let height = 18
    static let maxShiftX = 4
    static let maxShiftY = 3
    /// moved: the best shift is at least this share of the frame …
    static let moveShift: Float = 0.09
    /// … or what is left after the best shift is above this (mean absolute luma, 0…1)
    static let moveResidual: Float = 0.09
    /// settled (back in line): both under these
    static let settleShift: Float = 0.07
    static let settleResidual: Float = 0.07
    /// samples in a row that it takes to hide, and to show again
    static let hitsInARow = 2

    struct Thumb: Equatable { var luma: [Float] }

    struct Match: Equatable {
        var dx: Int
        var dy: Int
        var residual: Float
        /// the shift as a share of the frame (the larger of the two axes)
        var shift: Float { max(Float(abs(dx)) / Float(CameraMotion.width), Float(abs(dy)) / Float(CameraMotion.height)) }
        var moved: Bool { shift >= CameraMotion.moveShift || residual > CameraMotion.moveResidual }
        var settled: Bool { shift <= CameraMotion.settleShift && residual <= CameraMotion.settleResidual }
    }

    /// Blur (σ = 0.7 of a thumbnail pixel, at the source size), then downscale to 32 × 18 luma.
    static func thumb(_ image: CIImage, context: CIContext) -> Thumb? {
        let w = width, h = height
        let extent = image.extent
        guard extent.width > 0, extent.height > 0, extent.width.isFinite, extent.height.isFinite else { return nil }
        let blurred = image.clampedToExtent().applyingGaussianBlur(sigma: Double(extent.width) / Double(w) * 0.7).cropped(to: extent)
        let small = blurred.transformed(by: CGAffineTransform(translationX: -extent.minX, y: -extent.minY))
            .transformed(by: CGAffineTransform(scaleX: CGFloat(w) / extent.width, y: CGFloat(h) / extent.height))
        var bytes = [UInt8](repeating: 0, count: w * h * 4)
        context.render(small, toBitmap: &bytes, rowBytes: w * 4, bounds: CGRect(x: 0, y: 0, width: w, height: h), format: .RGBA8,
                       colorSpace: CGColorSpace(name: CGColorSpace.sRGB))
        var luma = [Float](repeating: 0, count: w * h)
        for i in 0..<(w * h) {
            luma[i] = (0.2126 * Float(bytes[i * 4]) + 0.7152 * Float(bytes[i * 4 + 1]) + 0.0722 * Float(bytes[i * 4 + 2])) / 255
        }
        return Thumb(luma: luma)
    }

    static func thumb(jpeg: Data, context: CIContext) -> Thumb? {
        CIImage(data: jpeg).flatMap { thumb($0, context: context) }
    }

    /// The best mean-normalised match of `now` against `analysed` over small shifts (a tie goes to the smaller shift).
    static func match(_ analysed: Thumb, _ now: Thumb) -> Match {
        let w = width, h = height
        guard analysed.luma.count == w * h, now.luma.count == w * h else { return Match(dx: 0, dy: 0, residual: 1) }
        let ma = analysed.luma.reduce(0, +) / Float(w * h), mb = now.luma.reduce(0, +) / Float(w * h)
        var best = Match(dx: 0, dy: 0, residual: 1)
        var bestScore = Float.greatestFiniteMagnitude
        for dy in -maxShiftY...maxShiftY {
            for dx in -maxShiftX...maxShiftX {
                var sum: Float = 0
                var n = 0
                for y in 0..<h {
                    let y2 = y + dy
                    if y2 < 0 || y2 >= h { continue }
                    for x in 0..<w {
                        let x2 = x + dx
                        if x2 < 0 || x2 >= w { continue }
                        sum += abs((analysed.luma[y * w + x] - ma) - (now.luma[y2 * w + x2] - mb))
                        n += 1
                    }
                }
                guard n > 0 else { continue }
                let residual = sum / Float(n)
                let score = residual + 0.004 * Float(abs(dx) + abs(dy))
                if score < bestScore { bestScore = score; best = Match(dx: dx, dy: dy, residual: residual) }
            }
        }
        return best
    }

    /// Hysteresis over samples (4 a second): hidden after `hitsInARow` moved samples, shown after as many settled ones.
    /// A sample that is neither (in between) keeps the current state and resets both counts.
    struct Detector: Equatable {
        private(set) var hidden = false
        private var hits = 0
        private var calm = 0

        /// Feeds one sample; returns whether the masks are hidden now.
        @discardableResult
        mutating func feed(_ m: Match) -> Bool {
            if m.moved { hits += 1; calm = 0 } else if m.settled { calm += 1; hits = 0 } else { hits = 0; calm = 0 }
            if !hidden, hits >= CameraMotion.hitsInARow { hidden = true; hits = 0 }
            if hidden, calm >= CameraMotion.hitsInARow { hidden = false; calm = 0 }
            return hidden
        }
    }

    /// `genita.maskMotion` = false on a device turns the hide off (the masks then only follow #676's hold).
    static var enabled: Bool {
        if ProcessInfo.processInfo.environment["GENITA_MASK_MOTION"] == "0" { return false }
        return UserDefaults.standard.object(forKey: "genita.maskMotion") as? Bool ?? true
    }
}
