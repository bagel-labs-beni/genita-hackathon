// L4 face · 2.5D lower-face rig. The mouth is not a pasted patch: the ORIGINAL photo's lower
// face (under the nose to under the chin, cheek to cheek) is warped by a dense displacement field
// driven by three continuous parameters, and only the opening between the lips is filled from a
// Muse Image key (cavity, teeth, tongue).
//
//   jaw    0…1  lower lip, chin, jawline and lower cheeks drop (rigid jaw, falloff to neck/cheeks);
//               the upper lip lifts a little; the lips part along the lip line in a lens shape
//   spread −1…1 mouth corners and nearby cheek pulled out (+, "ee") or in and pouted (−, "oo")
//   press  0…1  lips squeezed together and slightly bulged (m/b/p)
//
// Per frame: lighting follows the jaw (shadow under the lower lip and the chin, mouth-corner
// creases) and the interior gets occlusion shading so teeth never glow. Everything runs on the
// CPU over a small working-resolution crop (≈480 px wide) and is composited in still pixels, so
// it rides the head transform of the alive base. Parameters move through a critically damped
// spring in FaceRenderer, so shapes flow instead of swapping.

import CoreGraphics
import Foundation

public struct MouthRigParams: Equatable, Sendable {
    public var jaw: Double, spread: Double, press: Double
    public init(jaw: Double = 0, spread: Double = 0, press: Double = 0) { self.jaw = jaw; self.spread = spread; self.press = press }
    public static let rest = MouthRigParams()

    /// Rig target for a lip frame: shape weights set spread/press and how much of the loudness
    /// opens the jaw; loudness (openness) is the main jaw driver.
    public init(lip: LipFrame) {
        var jawGain = 0.0, spread = 0.0, press = 0.0
        for (v, w) in lip.weights {
            let p = Self.shape[v] ?? (0, 0, 0)
            jawGain += Double(w) * p.0; spread += Double(w) * p.1; press += Double(w) * p.2
        }
        let open = Double(min(1, max(0, lip.openness)))
        self.init(jaw: min(1, pow(open, 0.8) * jawGain * 1.3), spread: max(-1, min(1, spread)), press: min(1, press))
    }

    /// (jaw gain, spread, press) per shape.
    static let shape: [LipViseme: (Double, Double, Double)] = [
        .rest: (0.6, 0, 0), .MBP: (0, 0, 1), .FV: (0.25, 0.1, 0.45), .TH: (0.55, 0.15, 0), .L: (0.75, 0.1, 0),
        .WQ: (0.35, -1, 0.15), .O: (0.85, -0.65, 0), .EI: (0.6, 0.75, 0), .A: (1, 0.15, 0), .U: (0.5, -0.85, 0),
        .CDG: (0.5, 0.4, 0),
    ]
}

final class MouthRig: @unchecked Sendable {
    /// Working crop in still pixels (y down) and its scale (working px per still px).
    let region: CGRect
    let scale: Double
    let width: Int, height: Int
    private let bases: [FaceExpression: [UInt8]]
    /// Lip line (still y) per working column, mouth corners (still x), lip half-thickness.
    private let lipY: [Double]
    private let cornerL: Double, cornerR: Double, mouthCX: Double
    private let lipH: Double, chinY: Double, noseY: Double, faceW: Double
    /// Max lip gap at jaw 1 (still px).
    private let maxGap: Double
    /// Inner mouth source (unpremultiplied RGBA, still px) and its opening box.
    private let inner: PixelBuffer?
    private let innerRect: CGRect
    private let innerOrigin: (x: Int, y: Int)

    init?(faceSet: FaceSet, workingWidth: Int = 480) {
        let face = faceSet.faceBox, mouth = faceSet.mouthBox
        let W = Int(faceSet.pixelSize.width), H = Int(faceSet.pixelSize.height)
        guard mouth.width > 4, mouth.height > 2, let neutral = faceSet.expressions[.neutral] else { return nil }
        lipH = Double(mouth.height) / 2
        faceW = Double(face.width)
        chinY = Double(face.maxY)
        noseY = Double(mouth.minY) - Double(mouth.height) * 1.2
        let top = max(0, noseY), bottom = min(Double(H), chinY + Double(face.height) * 0.22)
        let left = max(0, Double(face.minX) - Double(face.width) * 0.05), right = min(Double(W), Double(face.maxX) + Double(face.width) * 0.05)
        region = CGRect(x: left, y: top, width: right - left, height: bottom - top).integral
        scale = min(1, Double(workingWidth) / Double(region.width))
        width = max(8, Int((Double(region.width) * scale).rounded()))
        height = max(8, Int((Double(region.height) * scale).rounded()))
        maxGap = Double(mouth.height) * 1.7

        // Working crops of each expression still.
        var bases: [FaceExpression: [UInt8]] = [:]
        for (e, cg) in faceSet.expressions {
            let s = faceSet.expressionShift[e] ?? (0, 0)
            bases[e] = Self.crop(cg, region: region.offsetBy(dx: CGFloat(s.dx), dy: CGFloat(s.dy)), width: width, height: height)
        }
        self.bases = bases

        // Lip line: the darkest row inside the mouth box, per column, smoothed.
        let pix = PixelBuffer(neutral, width: W, height: H)
        let x0 = Int(mouth.minX), x1 = Int(mouth.maxX), y0 = Int(mouth.minY), y1 = Int(mouth.maxY)
        var line: [Double] = []
        for x in x0..<max(x0 + 1, x1) {
            var best = Double.infinity, by = Double(mouth.midY)
            for y in y0..<max(y0 + 1, y1) where pix.contains(x, y) {
                let l = 0.299 * Double(pix.at(x, y, 0)) + 0.587 * Double(pix.at(x, y, 1)) + 0.114 * Double(pix.at(x, y, 2))
                if l < best { best = l; by = Double(y) }
            }
            line.append(by)
        }
        line = Self.smooth(line, radius: max(2, line.count / 12))
        cornerL = Double(mouth.minX); cornerR = Double(mouth.maxX); mouthCX = Double(mouth.midX)
        var ly: [Double] = []
        for i in 0..<width {
            let X = Double(region.minX) + (Double(i) + 0.5) / scale
            let k = Int(((X - Double(x0)).rounded())).clamped(0, line.count - 1)
            // Outside the mouth the line continues flat from the corner.
            ly.append(line[k])
        }
        lipY = ly

        // Inner mouth from the most open key, aligned into neutral pixels.
        let src = [LipViseme.A, .O, .EI, .L].first { faceSet.patches[$0] != nil && faceSet.ownMouth[$0] != nil }
        if let v = src, let patch = faceSet.patches[v], let own = faceSet.ownMouth[v] {
            inner = PixelBuffer(patch.image, width: patch.image.width, height: patch.image.height)
            innerOrigin = (Int(patch.rect.minX), Int(patch.rect.minY))
            // The opening inside its lips: the middle of its mouth box.
            // The opening sits in the middle of its mouth box (upper teeth near its top edge).
            innerRect = CGRect(x: own.minX + own.width * 0.07, y: own.minY + own.height * 0.19,
                               width: own.width * 0.88, height: own.height * 0.57)
        } else {
            inner = nil; innerOrigin = (0, 0); innerRect = .zero
        }
    }

    /// Renders the warped lower face (RGBA8 premultiplied, alpha feathered at the crop edge).
    func render(_ p: MouthRigParams, expressions: [FaceExpression: Double]) -> CGImage {
        var out = [UInt8](repeating: 0, count: width * height * 4)
        let mix = expressions.compactMap { e, w in bases[e].map { ($0, w) } }
        let total = max(1e-6, mix.reduce(0) { $0 + $1.1 })
        let jaw = max(0, min(1, p.jaw)), spread = max(-1, min(1, p.spread)), press = max(0, min(1, p.press))
        let gap = jaw * maxGap * (1 - 0.9 * press)
        let halfW = (cornerR - cornerL) / 2
        let widen = 1 + 0.12 * spread - 0.05 * max(0, -spread)
        let faceH = chinY - noseY
        let feather = 10.0 * scale
        for j in 0..<height {
            let Y = Double(region.minY) + (Double(j) + 0.5) / scale
            for i in 0..<width {
                let X = Double(region.minX) + (Double(i) + 0.5) / scale
                let yl = lipY[i]
                let u = (X - mouthCX) / max(1, halfW)                  // −1…1 across the lips
                let au = abs(u)
                // Lens: how far the lips part in this column (1 at centre, 0 at/after corners).
                let lens = au < widen ? (1 - (au / widen) * (au / widen)).squareRoot() : 0
                // Rigid jaw across the face, fading on the cheeks beyond the corners.
                let jawCol = 1 - smoothstep(1.2, 3.4, au)
                // Spread / round: corners and nearby cheek move along x; round also pouts (scale).
                let near = exp(-pow((Y - yl) / (lipH * 3.2), 2))
                let cornerPull = exp(-pow((au - 1) / 0.55, 2)) * near
                var dx = spread * 0.11 * halfW * (u < 0 ? -1 : 1) * cornerPull
                if spread < 0 { dx += spread * 0.06 * (X - mouthCX) * exp(-pow(au / 1.2, 2)) * near }
                let lipFade = 1 - smoothstep(0.9, 1.3, au)
                // Vertical field of this column at still row y: jaw drop below the lip line (lower lip
                // follows the lens, chin/jaw rigid, neck still), upper lip lift above it, press squeeze.
                // The field jumps at the lip line (lips part), so the backward map keeps the branch of
                // the output pixel's side; mixing branches sampled skin into the lip edge (a bright rim).
                let lower = Y >= yl
                func field(_ y: Double) -> Double {
                    var d: Double
                    if lower {
                        let toChin = smoothstep(yl + lipH * 1.2, yl + (chinY - yl) * 0.7, y)
                        let follow = lens * (1 - toChin) + jawCol * toChin
                        let neck = 1 - smoothstep(chinY, chinY + faceH * 0.35, y)
                        d = gap * follow * neck
                    } else {
                        d = -0.18 * gap * lens * (1 - smoothstep(yl - lipH * 2.2, noseY, y))
                    }
                    let band = exp(-pow((y - yl) / (lipH * 1.4), 2)) * lipFade
                    return d - press * 0.18 * lipH * (lower ? 1 : -1) * band
                }
                // Backward map: two fixed-point steps (displacements are small and smooth).
                let sx = X - dx
                let sy = Y - field(Y - field(Y))

                // Opening between the lips: inner mouth.
                let top = yl - 0.18 * gap * lens, bot = yl + gap * lens
                var r = 0.0, g = 0.0, b = 0.0
                for (buf, w) in mix {
                    let c = sample(buf, sx, sy)
                    r += c.0 * w; g += c.1 * w; b += c.2 * w
                }
                r /= total; g /= total; b /= total
                if gap > 0.5, lens > 0, Y > top, Y < bot {
                    let v = (Y - top) / max(1e-3, bot - top)              // 0 top … 1 bottom
                    // Upper teeth sit right under the upper lip; the lower ones mostly hide.
                    var m = innerColor(u: u / widen, v: -0.05 + 0.92 * v)
                    // The lips' inner edge is a dark wet line, not the key's teeth or highlights.
                    let rim = smoothstep(0, 0.04, v) * smoothstep(0, 0.12, 1 - v)
                    m = (m.0 * rim + 52 * (1 - rim), m.1 * rim + 26 * (1 - rim), m.2 * rim + 30 * (1 - rim))
                    // Soft edge against the lips and occlusion: darker toward corners and edges.
                    let edge = smoothstep(0, 0.035, min(v, 1 - v)) * smoothstep(1, 0.85, au / widen)
                    let occl = (0.8 + 0.2 * sin(.pi * v)) * (1 - 0.45 * pow(au / widen, 2))
                    let a = edge * min(1, gap / (lipH * 0.6))
                    r = r * (1 - a) + m.0 * occl * a
                    g = g * (1 - a) + m.1 * occl * a
                    b = b * (1 - a) + m.2 * occl * a
                }
                // Lighting: shadow under the lower lip and under the chin, corner creases.
                var shade = 1.0
                let underLip = exp(-pow((Y - (bot + lipH * 1.6)) / (lipH * 1.3), 2)) * (1 - smoothstep(0.8, 1.6, au))
                shade -= 0.10 * jaw * underLip
                let chinShadow = exp(-pow((Y - (chinY + gap * 0.9)) / (faceH * 0.06), 2)) * jawCol
                shade -= 0.08 * jaw * chinShadow
                let crease = exp(-pow((au - 1.12) / 0.09, 2)) * exp(-pow((Y - yl - lipH * 0.4) / (lipH * 1.6), 2))
                shade -= 0.10 * max(jaw * 0.7, max(0, spread)) * crease
                shade -= 0.12 * press * exp(-pow((Y - yl) / (lipH * 0.25), 2)) * (1 - smoothstep(0.8, 1.05, au))
                r *= shade; g *= shade; b *= shade

                let ex = min(Double(i), Double(width - 1 - i), Double(j), Double(height - 1 - j))
                let a = smoothstep(0, feather, ex)
                let k = (j * width + i) * 4
                out[k] = UInt8((min(255, max(0, r)) * a).rounded())
                out[k + 1] = UInt8((min(255, max(0, g)) * a).rounded())
                out[k + 2] = UInt8((min(255, max(0, b)) * a).rounded())
                out[k + 3] = UInt8((255 * a).rounded())
            }
        }
        return PixelBuffer.makeImage(out, width: width, height: height)
    }

    /// Bilinear sample of a working crop at still coordinates.
    private func sample(_ buf: [UInt8], _ X: Double, _ Y: Double) -> (Double, Double, Double) {
        let x = ((X - Double(region.minX)) * scale - 0.5).clamped(0, Double(width - 1))
        let y = ((Y - Double(region.minY)) * scale - 0.5).clamped(0, Double(height - 1))
        let x0 = Int(x), y0 = Int(y), x1 = min(width - 1, x0 + 1), y1 = min(height - 1, y0 + 1)
        let fx = x - Double(x0), fy = y - Double(y0)
        func px(_ xx: Int, _ yy: Int, _ c: Int) -> Double { Double(buf[(yy * width + xx) * 4 + c]) }
        func ch(_ c: Int) -> Double {
            (px(x0, y0, c) * (1 - fx) + px(x1, y0, c) * fx) * (1 - fy) + (px(x0, y1, c) * (1 - fx) + px(x1, y1, c) * fx) * fy
        }
        return (ch(0), ch(1), ch(2))
    }

    /// Inner mouth colour at lens coordinates (u −1…1 across, v 0 top … 1 bottom); teeth damped.
    private func innerColor(u: Double, v: Double) -> (Double, Double, Double) {
        guard let p = inner, innerRect.width > 2 else { return (40, 18, 20) }
        let X = Double(innerRect.midX) + u * Double(innerRect.width) / 2
        let Y = Double(innerRect.minY) + v * Double(innerRect.height)
        let x = Int(X.rounded()) - innerOrigin.x, y = Int(Y.rounded()) - innerOrigin.y
        guard p.contains(x, y) else { return (40, 18, 20) }
        let a = max(1, Double(p.at(x, y, 3))) / 255
        var r = Double(p.at(x, y, 0)) / a, g = Double(p.at(x, y, 1)) / a, b = Double(p.at(x, y, 2)) / a
        // Teeth must not glow: compress highlights.
        let l = 0.299 * r + 0.587 * g + 0.114 * b
        if l > 170 { let k = (170 + (l - 170) * 0.55) / l; r *= k; g *= k; b *= k }
        return (r * 0.92, g * 0.9, b * 0.9)
    }

    private static func crop(_ cg: CGImage, region: CGRect, width: Int, height: Int) -> [UInt8] {
        var d = [UInt8](repeating: 0, count: width * height * 4)
        d.withUnsafeMutableBytes { raw in
            let ctx = CGContext(data: raw.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                space: PixelBuffer.colorSpace, bitmapInfo: PixelBuffer.bitmapInfo)!
            ctx.interpolationQuality = .high
            let sx = Double(width) / Double(region.width), sy = Double(height) / Double(region.height)
            // CG origin is bottom-left: place the still so `region` (y down) fills the context.
            let H = Double(cg.height)
            ctx.draw(cg, in: CGRect(x: -Double(region.minX) * sx, y: -(H - Double(region.maxY)) * sy,
                                    width: Double(cg.width) * sx, height: H * sy))
        }
        return d
    }

    private static func smooth(_ v: [Double], radius: Int) -> [Double] {
        guard v.count > 2 else { return v }
        return v.indices.map { i in
            let a = max(0, i - radius), b = min(v.count - 1, i + radius)
            return v[a...b].reduce(0, +) / Double(b - a + 1)
        }
    }
}

extension Comparable {
    func clamped(_ lo: Self, _ hi: Self) -> Self { min(max(self, lo), hi) }
}
