import CoreImage
import Foundation

/// D59 · CW-01 DARK: is this camera frame too dark or too blurry for anything in it to be seen? Judged on the phone
/// (the server has no image decoder) and sent as `frames.unclear`, so a fridge question gets the IC-4 line at once
/// instead of a "let me see" that the failed look then takes back.
/// Thresholds from fixture frames (11/4): normal fridge/outfit frames luma 0.49–0.56, detail 0.060–0.071; −4 EV luma
/// 0.12–0.14; σ12 blur detail 0.033–0.043. Only the clearly hopeless ones are flagged; the server's own look still
/// catches the rest (IC-4 after the short line).
enum FrameQuality {
    static let darkLuma: Float = 0.16
    static let flatDetail: Float = 0.03
    private static let context = CIContext(options: [.cacheIntermediates: false])

    struct Reading: Equatable { var luma: Float; var detail: Float }

    /// Mean luma and mean neighbour difference on a 64 × 36 grey thumbnail.
    static func read(_ image: CIImage) -> Reading? {
        let w = 64, h = 36
        let e = image.extent
        guard e.width > 0, e.height > 0, e.width.isFinite, e.height.isFinite else { return nil }
        let small = image.transformed(by: CGAffineTransform(translationX: -e.minX, y: -e.minY))
            .transformed(by: CGAffineTransform(scaleX: CGFloat(w) / e.width, y: CGFloat(h) / e.height))
        var b = [UInt8](repeating: 0, count: w * h * 4)
        context.render(small, toBitmap: &b, rowBytes: w * 4, bounds: CGRect(x: 0, y: 0, width: w, height: h), format: .RGBA8,
                       colorSpace: CGColorSpace(name: CGColorSpace.sRGB))
        var l = [Float](repeating: 0, count: w * h)
        for i in 0..<(w * h) { l[i] = (0.2126 * Float(b[i * 4]) + 0.7152 * Float(b[i * 4 + 1]) + 0.0722 * Float(b[i * 4 + 2])) / 255 }
        let mean = l.reduce(0, +) / Float(l.count)
        var d: Float = 0
        var n = 0
        for y in 0..<h { for x in 0..<(w - 1) { d += abs(l[y * w + x + 1] - l[y * w + x]); n += 1 } }
        for y in 0..<(h - 1) { for x in 0..<w { d += abs(l[(y + 1) * w + x] - l[y * w + x]); n += 1 } }
        return Reading(luma: mean, detail: d / Float(n))
    }

    static func unclear(_ r: Reading) -> Bool { r.luma < darkLuma || r.detail < flatDetail }
    static func unclear(_ image: CIImage) -> Bool { read(image).map(unclear) ?? false }
}
