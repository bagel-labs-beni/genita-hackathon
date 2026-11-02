// L4 face · Draws one frame of the companion from a face set, a mouth frame and a time.
// Layer order: expression still (crossfade on emotion) → mouth patches (weighted by the lip
// frame) → jaw warp (lower face stretched down by openness, strip warp) → blink (eye band from
// the blink still) → idle motion (breathing scale, sway) → aspect-fill to the output size.
// Same inputs, same seed, same call order → same pixels. No Metal library, no platform UI.

import CoreGraphics
import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation

public final class FaceRenderer: @unchecked Sendable {
    public static let expressionFade = 0.25        // s
    public static let blinkLength = 0.12           // s
    public static let blinkGap = 2.0...6.0         // s between blinks
    public static let breathingAmplitude = 0.006   // scale ±
    public static let breathingHz = 0.25
    public static let swayDegrees = 0.4
    public static let swayHz = 0.17
    /// Chin drop at full openness, as a fraction of the face height.
    public static let jawDrop = 0.035
    static let jawStrips = 28

    public let faceSet: FaceSet
    public let outputSize: CGSize
    public let seed: UInt64
    /// Accessibility Reduce Motion: no breathing, sway or blinks; the mouth still moves.
    public var reduceMotion: Bool

    private let lock = NSLock()
    private var exprFrom: FaceExpression = .neutral
    private var exprTo: FaceExpression = .neutral
    private var exprChangedAt = -Double.infinity
    private var rng: SplitMix64
    private var blinkStarts: [Double] = []

    private let context: CIContext
    private let bases: [FaceExpression: CIImage]
    private let patchImages: [LipViseme: CIImage]
    private let extent: CGRect
    private let blinkMask: CIImage?
    private let jawMask: CIImage

    public init(faceSet: FaceSet, outputSize: CGSize, seed: UInt64 = 1, reduceMotion: Bool = false, context: CIContext? = nil) {
        self.faceSet = faceSet
        self.outputSize = outputSize
        self.seed = seed
        self.reduceMotion = reduceMotion
        rng = SplitMix64(seed: seed)
        self.context = context ?? CIContext(options: [.cacheIntermediates: false, .outputColorSpace: CGColorSpace(name: CGColorSpace.sRGB)!])
        let w = faceSet.pixelSize.width, h = faceSet.pixelSize.height
        extent = CGRect(x: 0, y: 0, width: w, height: h)

        var bases: [FaceExpression: CIImage] = [:]
        for e in FaceExpression.allCases {
            guard let cg = faceSet.expressions[e] else { continue }
            let s = faceSet.expressionShift[e] ?? (0, 0)
            // Align to the neutral still; clamp so the shifted edge has no hole.
            bases[e] = CIImage(cgImage: cg).clampedToExtent()
                .transformed(by: CGAffineTransform(translationX: CGFloat(-s.dx), y: CGFloat(s.dy)))
                .cropped(to: extent)
        }
        self.bases = bases
        var patches: [LipViseme: CIImage] = [:]
        for (v, p) in faceSet.patches {
            patches[v] = CIImage(cgImage: p.image)
                .transformed(by: CGAffineTransform(translationX: p.rect.minX, y: h - p.rect.maxY))
        }
        patchImages = patches

        let face = Self.ciRect(faceSet.faceBox, height: h)
        let mouth = Self.ciRect(faceSet.mouthBox, height: h)
        // Eye band: from 12% below the face top down to a quarter of the way above the mouth.
        let bandTop = face.maxY - face.height * 0.12
        let bandBottom = mouth.maxY + (face.maxY - mouth.maxY) * 0.22
        blinkMask = faceSet.hasBlink
            ? Self.ellipseMask(center: CGPoint(x: face.midX, y: (bandTop + bandBottom) / 2),
                               rx: face.width * 0.55, ry: max(4, (bandTop - bandBottom) / 2), inner: 0.6, extent: extent)
            : nil
        let (_, un) = Self.jawSpan(face: face, mouth: mouth)
        jawMask = Self.ellipseMask(center: CGPoint(x: face.midX, y: mouth.midY - un * 0.5),
                                   rx: face.width * 0.62, ry: un * 1.3, inner: 0.62, extent: extent)
    }

    // MARK: state

    public func setEmotion(_ emotion: String?, at t: Double) {
        setExpression(FaceExpression(emotion: emotion), at: t)
    }

    public func setExpression(_ requested: FaceExpression, at t: Double) {
        let e = faceSet.expressions[requested] != nil ? requested : .neutral
        lock.lock(); defer { lock.unlock() }
        guard e != exprTo else { return }
        let w = weightsLocked(at: t)
        exprFrom = (w[exprFrom] ?? 0) > (w[exprTo] ?? 0) ? exprFrom : exprTo
        exprTo = e
        exprChangedAt = t
    }

    /// Expression mix at `t` (sums to 1).
    public func expressionWeights(at t: Double) -> [FaceExpression: Double] {
        lock.lock(); defer { lock.unlock() }
        return weightsLocked(at: t)
    }

    private func weightsLocked(at t: Double) -> [FaceExpression: Double] {
        let a = smoothstep(0, 1, (t - exprChangedAt) / Self.expressionFade)
        if a >= 1 || exprFrom == exprTo { return [exprTo: 1] }
        return [exprFrom: 1 - a, exprTo: a]
    }

    private func expressionMix(at t: Double) -> (from: FaceExpression, to: FaceExpression, amount: Double) {
        lock.lock(); defer { lock.unlock() }
        return (exprFrom, exprTo, smoothstep(0, 1, (t - exprChangedAt) / Self.expressionFade))
    }

    /// Eyelid closure 0…1 at `t` (0 with Reduce Motion or without a blink still).
    public func blinkAmount(at t: Double) -> Double {
        guard !reduceMotion, faceSet.hasBlink, t >= 0 else { return 0 }
        lock.lock(); defer { lock.unlock() }
        while (blinkStarts.last ?? -Double.infinity) < t {
            let gap = Self.blinkGap.lowerBound + rng.nextUnit() * (Self.blinkGap.upperBound - Self.blinkGap.lowerBound)
            // First blink comes sooner so a short clip shows one.
            blinkStarts.append((blinkStarts.last ?? 0) + (blinkStarts.isEmpty ? gap * 0.5 : gap))
        }
        guard let start = blinkStarts.last(where: { $0 <= t }) else { return 0 }
        let tau = t - start
        guard tau < Self.blinkLength else { return 0 }
        let close = Self.blinkLength * 0.33, hold = Self.blinkLength * 0.58
        if tau < close { return smoothstep(0, close, tau) }
        if tau < hold { return 1 }
        return 1 - smoothstep(hold, Self.blinkLength, tau)
    }

    // MARK: drawing

    /// The frame as a Core Image graph with extent (0, 0, outputSize).
    public func image(at t: Double, lip: LipFrame) -> CIImage {
        let h = extent.height
        // 1. expression
        let mix = expressionMix(at: t)
        var img: CIImage = bases[mix.to] ?? bases[.neutral]!
        if mix.amount < 1, mix.from != mix.to {
            let f = CIFilter.dissolveTransition()
            f.inputImage = bases[mix.from] ?? bases[.neutral]!
            f.targetImage = img
            f.time = Float(mix.amount)
            img = f.outputImage!.cropped(to: extent)
        }

        // 2. mouth patches: a running weighted average, rest = the expression's own mouth.
        let open = Double(min(1, max(0, lip.openness)))
        var patchWeight: [LipViseme: Double] = [:]
        var restWeight = 0.0
        for (v, w) in lip.weights where w > 0 {
            guard v != .rest, let key = faceSet.resolved[v] ?? nil else { restWeight += Double(w); continue }
            let shown = v.isOpenVowel ? min(1, 0.35 + 1.1 * open) : 1
            patchWeight[key, default: 0] += Double(w) * shown
            restWeight += Double(w) * (1 - shown)
        }
        var cumulative = restWeight
        for v in LipViseme.shapes {
            guard let w = patchWeight[v], w > 0.004, let patch = patchImages[v] else { continue }
            cumulative += w
            img = Self.withOpacity(patch, w / cumulative).composited(over: img)
        }

        // 3. jaw
        if open > 0.01 { img = jawWarp(img, open: open) }

        // 4. blink
        let blink = blinkAmount(at: t)
        if blink > 0.001, let mask = blinkMask, let closed = bases[.blink] {
            let f = CIFilter.blendWithAlphaMask()
            f.inputImage = closed
            f.backgroundImage = img
            f.maskImage = Self.withOpacity(mask, blink)
            img = f.outputImage!.cropped(to: extent)
        }

        // 5. idle motion around the chin
        if !reduceMotion {
            let face = Self.ciRect(faceSet.faceBox, height: h)
            let pivot = CGPoint(x: face.midX, y: face.minY)
            let s = 1 + Self.breathingAmplitude * sin(2 * .pi * Self.breathingHz * t)
            let a = Self.swayDegrees * .pi / 180 * sin(2 * .pi * Self.swayHz * t + 0.7)
            let m = CGAffineTransform(translationX: pivot.x, y: pivot.y)
                .rotated(by: a).scaledBy(x: s, y: s)
                .translatedBy(x: -pivot.x, y: -pivot.y)
            img = img.clampedToExtent().transformed(by: m).cropped(to: extent)
        }

        // 6. aspect fill
        let scale = max(outputSize.width / extent.width, outputSize.height / extent.height)
        let dx = (outputSize.width - extent.width * scale) / 2, dy = (outputSize.height - extent.height * scale) / 2
        return img.clampedToExtent()
            .transformed(by: CGAffineTransform(a: scale, b: 0, c: 0, d: scale, tx: dx, ty: dy))
            .cropped(to: CGRect(origin: .zero, size: outputSize))
    }

    /// Rendered RGBA frame (sRGB).
    public func render(at t: Double, lip: LipFrame) -> CGImage? {
        context.createCGImage(image(at: t, lip: lip), from: CGRect(origin: .zero, size: outputSize), format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
    }

    /// Renders into a caller-owned pixel buffer-like destination (e.g. a CVPixelBuffer via
    /// `CIContext.render(_:to:)` in the app or the render tool).
    public var ciContext: CIContext { context }

    // MARK: jaw warp

    /// Distances below the mouth centre (px): to the chin, and to where the warp ends.
    static func jawSpan(face: CGRect, mouth: CGRect) -> (uc: Double, un: Double) {
        let uc = max(4, mouth.midY - face.minY)
        let maxDrop = jawDrop * face.height
        return (uc, uc + max(0.6 * uc, 3 * maxDrop))
    }

    /// Source rows below the mouth line slide down by D·f(u): f rises to 1 at the chin and
    /// falls back to 0 under it, so the chin drops and the neck and body stay put. Done as
    /// horizontal strips, each scaled vertically, then blended in under an elliptical mask.
    private func jawWarp(_ img: CIImage, open: Double) -> CIImage {
        let h = extent.height
        let face = Self.ciRect(faceSet.faceBox, height: h)
        let mouth = Self.ciRect(faceSet.mouthBox, height: h)
        let (uc, un) = Self.jawSpan(face: face, mouth: mouth)
        let drop = open * Self.jawDrop * face.height
        func f(_ u: Double) -> Double {
            u <= uc ? smoothstep(0, uc, u) : 1 - smoothstep(uc, un, u)
        }
        let y0 = mouth.midY
        let xs = max(0, face.minX - face.width * 0.2), xe = min(extent.maxX, face.maxX + face.width * 0.2)
        var warped = img
        let n = Self.jawStrips
        for k in 0..<n {
            let ua = un * Double(k) / Double(n), ub = un * Double(k + 1) / Double(n)
            let da = ua + drop * f(ua), db = ub + drop * f(ub)
            let sc = (db - da) / (ub - ua)
            let ty = y0 - da - sc * (y0 - ua)
            let src = CGRect(x: xs, y: y0 - ub - 1, width: xe - xs, height: ub - ua + 2)
            let strip = img.cropped(to: src).transformed(by: CGAffineTransform(a: 1, b: 0, c: 0, d: sc, tx: 0, ty: ty))
            warped = strip.composited(over: warped)
        }
        let blend = CIFilter.blendWithAlphaMask()
        blend.inputImage = warped
        blend.backgroundImage = img
        blend.maskImage = jawMask
        return blend.outputImage!.cropped(to: extent)
    }

    // MARK: helpers

    static func ciRect(_ r: CGRect, height: CGFloat) -> CGRect {
        CGRect(x: r.minX, y: height - r.maxY, width: r.width, height: r.height)
    }

    static func withOpacity(_ image: CIImage, _ a: Double) -> CIImage {
        guard a < 0.999 else { return image }
        let f = CIFilter.colorMatrix()
        f.inputImage = image
        let v = CGFloat(max(0, a))
        f.rVector = CIVector(x: v, y: 0, z: 0, w: 0)
        f.gVector = CIVector(x: 0, y: v, z: 0, w: 0)
        f.bVector = CIVector(x: 0, y: 0, z: v, w: 0)
        f.aVector = CIVector(x: 0, y: 0, z: 0, w: v)
        return f.outputImage!
    }

    /// White-opaque ellipse fading to clear between `inner` and 1 of its radii.
    static func ellipseMask(center: CGPoint, rx: CGFloat, ry: CGFloat, inner: CGFloat, extent: CGRect) -> CIImage {
        let g = CIFilter.radialGradient()
        g.center = .zero
        g.radius0 = Float(inner * 100)
        g.radius1 = 100
        g.color0 = CIColor(red: 1, green: 1, blue: 1, alpha: 1)
        g.color1 = CIColor(red: 0, green: 0, blue: 0, alpha: 0)
        return g.outputImage!
            .transformed(by: CGAffineTransform(a: rx / 100, b: 0, c: 0, d: ry / 100, tx: center.x, ty: center.y))
            .cropped(to: extent)
    }
}

/// Small deterministic PRNG (SplitMix64) for blink timing.
struct SplitMix64 {
    private var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
    mutating func nextUnit() -> Double { Double(next() >> 11) / Double(1 << 53) }
}
