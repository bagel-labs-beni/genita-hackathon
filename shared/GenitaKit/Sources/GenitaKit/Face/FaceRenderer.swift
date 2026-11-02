// L4 face · Draws one frame of the companion from a face set, a mouth frame and a time.
// Layer order: expression still (crossfade on emotion) → one mouth patch (the lip frame's
// strongest shape; changes are cuts) → jaw warp (lower face stretched down by openness, strip warp) → blink (eye band from
// the blink still) → alive base (head layer sways/nods on the speech envelope, body breathes,
// handheld camera drift with parallax; see `AliveMotion`) → aspect-fill with overscan.
// Same inputs, same seed, same call order → same pixels. No Metal library, no platform UI.

import CoreGraphics
import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation

public final class FaceRenderer: @unchecked Sendable {
    public static let expressionFade = 0.25        // s
    public static let blinkLength = 0.12           // s
    public static let blinkGap = 2.0...6.0         // s between blinks
    /// Chin drop at full openness, as a fraction of the face height.
    public static let jawDrop = 0.035
    static let jawStrips = 28

    public let faceSet: FaceSet
    public let outputSize: CGSize
    public let seed: UInt64
    /// Accessibility Reduce Motion: no head/body/camera motion or blinks; the mouth still moves.
    public var reduceMotion: Bool

    private let lock = NSLock()
    /// Expression mix when the last change began; it fades into `exprTo`.
    private var exprFrom: [FaceExpression: Double] = [.neutral: 1]
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
    private let headMask: CIImage
    private let bodyMask: CIImage
    private var motion: AliveMotion
    /// Option B: full-face key morph (nil → key patches). `useFlow = false` forces patches.
    let flowMorph: FlowMorph?
    public var useFlow = true
    /// Callers sample the lip timeline this far ahead so smoothing lands on the sound.
    public static let defaultLipLookaheadMs = 40.0
    /// Expression layer (smile / laugh / surprised / concerned warps). Off until the server's
    /// `expression` event ships; turn on for tests and the render tool.
    nonisolated(unsafe) public static var expressionLayer = false
    /// Flow-morph working resolution relative to the output (1 = output pixels).
    nonisolated(unsafe) public static var flowDensity = 1.5   // 1 was soft on the lips (review 11/3); 2 costs ~35% more
    /// This face's lookahead (the flow map's `lookaheadMs`, else the default).
    /// Profiles that hold shapes (minHold, 2D snap) decide on frames ending now in the app (the
    /// offline reference looked ahead), so they read the timeline further ahead to stay on time.
    /// How far past the lookahead the "next shape" is sampled for anticipation (0 = no motion model).
    public var lipAheadMs: Double { flowMorph?.motion?.aheadMs ?? 0 }
    public var lipLookaheadMs: Double {
        guard let m = faceSet.flow?.map else { return Self.defaultLipLookaheadMs }
        let hold: Double = m.drive == "snap" || (m.minHold ?? 1) >= 3 ? 80 : Self.defaultLipLookaheadMs
        return max(m.lookaheadMs ?? 0, hold)
    }
    /// Expression events for the current reply (audio-clock ms). Ignored when the layer is off.
    public func addExpression(_ e: FaceExpressionEvent) { lock.lock(); flowMorph?.expressionEvents.append(e); lock.unlock() }
    /// Cancel / barge-in: drop the mouth's smoothing and held shapes so it rests on the next frame.
    public func resetMouth() { lock.lock(); flowMorph?.reset(); lock.unlock() }
    /// Parity checks: the next frame uses these flow amounts (in `faceSet.flow.keys` order).
    public func overrideNextFlowAmounts(_ a: [Float]) { lock.lock(); flowMorph?.amountsOverride = a; lock.unlock() }
    /// Key amounts of the last flow-morph frame (empty without flows).
    public var flowAmounts: [String: Float] { lock.lock(); defer { lock.unlock() }; return flowMorph?.lastAmounts ?? [:] }

    public init(faceSet: FaceSet, outputSize: CGSize, seed: UInt64 = 1, reduceMotion: Bool = false, context: CIContext? = nil) {
        self.faceSet = faceSet
        self.outputSize = outputSize
        self.seed = seed
        self.reduceMotion = reduceMotion
        rng = SplitMix64(seed: seed)
        motion = AliveMotion(seed: seed)
        if let a = faceSet.flow?.map.alive ?? (faceSet.flow?.kind == "human" ? FlowMap.Alive() : nil) {
            motion.headGain = a.headGain; motion.nodGain = a.nodGain
        }
        // Flow morph at `flowDensity` × the output's pixel density (capped at the still's own).
        let outScale = Double(max(outputSize.width / faceSet.pixelSize.width, outputSize.height / faceSet.pixelSize.height)) * Double(AliveMotion.overscan) * Self.flowDensity
        flowMorph = faceSet.flow.flatMap { d in
            faceSet.expressions[.neutral].map { FlowMorph(data: d, neutralStill: $0, scale: outScale, face: faceSet.faceBox, mouth: faceSet.mouthBox,
                                                         expressions: Self.expressionLayer) }
        }
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
        // Person layers from the SAM face box: the head (with hair) and the shoulders/chest under it.
        // Soft masks, so the warp between layers is a smooth field with no holes.
        let he = Self.headEllipse(face: face)
        headMask = Self.ellipseMask(center: he.center, rx: he.rx, ry: he.ry, inner: Self.headMaskInner, extent: extent)
        bodyMask = Self.ellipseMask(center: CGPoint(x: face.midX, y: face.minY - face.height * 1.25),
                                    rx: face.width * 2.0, ry: face.height * 1.75, inner: 0.6, extent: extent)
    }

    // MARK: state

    public func setEmotion(_ emotion: String?, at t: Double) {
        setExpression(FaceExpression(emotion: emotion), at: t)
    }

    public func setExpression(_ requested: FaceExpression, at t: Double) {
        let e = faceSet.expressions[requested] != nil ? requested : .neutral
        lock.lock(); defer { lock.unlock() }
        guard e != exprTo else { return }
        exprFrom = weightsLocked(at: t)   // a change mid-fade starts from the mix on screen
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
        if a >= 1 { return [exprTo: 1] }
        var w = exprFrom.mapValues { $0 * (1 - a) }
        w[exprTo, default: 0] += a
        return w.filter { $0.value > 1e-9 }
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
    public func image(at t: Double, lip: LipFrame, ahead: LipFrame? = nil, context: LipContext? = nil) -> CIImage {
        let h = extent.height
        // 1. expression: running weighted average of the stills in the mix
        var img: CIImage = bases[.neutral]!
        var cumulative = 0.0
        for (e, w) in expressionWeights(at: t).sorted(by: { $0.key.rawValue < $1.key.rawValue }) where w > 0 {
            let still = bases[e] ?? bases[.neutral]!
            cumulative += w
            if cumulative == w { img = still; continue }
            let f = CIFilter.dissolveTransition()
            f.inputImage = img
            f.targetImage = still
            f.time = Float(w / cumulative)
            img = f.outputImage!.cropped(to: extent)
        }

        // 2. mouth: one shape at a time. Blending two different mouths shows two outlines, so a
        // shape change is a cut on the frame where the new shape's weight overtakes the old one;
        // the jaw warp (driven by the continuous openness) carries the motion across the cut.
        let open = Double(min(1, max(0, lip.openness)))
        if useFlow, let fm = flowMorph {
            // Lower face = neutral·(1−m) + morph·m; the nose and above are the still's own pixels.
            let cg: CGImage = { lock.lock(); defer { lock.unlock() }; return fm.render(lip, ahead: ahead, context: context, at: t) }()
            let r = fm.outputRect
            img = CIImage(cgImage: cg)
                .transformed(by: CGAffineTransform(scaleX: r.width / CGFloat(cg.width), y: r.height / CGFloat(cg.height)))
                .transformed(by: CGAffineTransform(translationX: r.minX, y: h - r.maxY))
                .composited(over: img)
        } else {
            if let v = Self.mouthShape(lip: lip, resolved: faceSet.resolved), let patch = patchImages[v] {
                img = patch.composited(over: img)
            }
            // 3. jaw
            if open > 0.01 { img = jawWarp(img, open: open) }
        }

        // 4. blink
        let blink = blinkAmount(at: t)
        if blink > 0.3, let mask = blinkMask, let closed = bases[.blink] {
            let f = CIFilter.blendWithAlphaMask()
            f.inputImage = closed
            f.backgroundImage = img
            // A blink is a cut (half-dissolved lids read as glass), held while it is more than 30% closed.
            f.maskImage = blink > 0.3 ? mask : Self.withOpacity(mask, 0)
            img = f.outputImage!.cropped(to: extent)
        }

        // 5. aspect fill (with overscan while the camera drifts), then 6. the alive base at output
        // resolution: the frame so far (mouth, jaw, blink included) is cut into head, body and
        // background layers that move separately, so the mouth rides the head and never slides.
        let out = CGRect(origin: .zero, size: outputSize)
        let scale = max(outputSize.width / extent.width, outputSize.height / extent.height) * (reduceMotion ? 1 : AliveMotion.overscan)
        let fill = CGAffineTransform(a: scale, b: 0, c: 0, d: scale,
                                     tx: (outputSize.width - extent.width * scale) / 2, ty: (outputSize.height - extent.height * scale) / 2)
        let filled = img.clampedToExtent().transformed(by: fill)
        guard !reduceMotion else { return filled.cropped(to: out) }
        var m = motionState(at: t, open: open, face: Self.ciRect(faceSet.faceBox, height: h))
        // laugh: the head bobs with the "ha-ha" (4.5 Hz), 2.5 px at 960 high
        if let lw = flowMorph?.lastLaugh, lw.w > 0.01 {
            // bob plus a 4 px tilt back (v30)
            let bob = (2.5 * pow(sin(2 * Double.pi * 4.5 * lw.ms / 1000), 2) - 4) * lw.w * Double(extent.height) / 960
            m.head = m.head.concatenating(CGAffineTransform(translationX: 0, y: -CGFloat(bob)))
        }
        let inv = fill.inverted()
        func inOutput(_ a: CGAffineTransform) -> CGAffineTransform { inv.concatenating(a).concatenating(fill) }
        let bodyT = inOutput(m.body), headT = inOutput(m.head)
        let bodyM = bodyMask.transformed(by: fill.concatenating(bodyT))
        let headM = headMask.transformed(by: fill.concatenating(headT))
        let b = CIFilter.blendWithAlphaMask()
        b.inputImage = filled.transformed(by: bodyT).cropped(to: bodyM.extent)
        b.backgroundImage = filled
        b.maskImage = bodyM
        let hb = CIFilter.blendWithAlphaMask()
        hb.inputImage = filled.transformed(by: headT).cropped(to: headM.extent)
        hb.backgroundImage = b.outputImage!
        hb.maskImage = headM
        return hb.outputImage!.transformed(by: inOutput(m.camera)).cropped(to: out)
    }

    /// Rendered RGBA frame (sRGB).
    public func render(at t: Double, lip: LipFrame, ahead: LipFrame? = nil, lipContext: LipContext? = nil) -> CGImage? {
        context.createCGImage(image(at: t, lip: lip, ahead: ahead, context: lipContext), from: CGRect(origin: .zero, size: outputSize), format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
    }

    /// Renders into a caller-owned pixel buffer-like destination (e.g. a CVPixelBuffer via
    /// `CIContext.render(_:to:)` in the app or the render tool).
    public var ciContext: CIContext { context }

    /// Transforms of the alive base at `t` (image coordinates, y up). Calls are expected in time
    /// order (the speech-coupled nod is a spring); a jump back in time resets the spring.
    public func motionTransforms(at t: Double, open: Double) -> (head: CGAffineTransform, body: CGAffineTransform, camera: CGAffineTransform) {
        let m = motionState(at: t, open: open, face: Self.ciRect(faceSet.faceBox, height: extent.height))
        return (m.head, m.body, m.camera)
    }

    private func motionState(at t: Double, open: Double, face: CGRect) -> (head: CGAffineTransform, body: CGAffineTransform, camera: CGAffineTransform) {
        lock.lock(); defer { lock.unlock() }
        return motion.transforms(at: t, open: open, face: face, extent: extent, outputWidth: outputSize.width)
    }

    /// Head layer ellipse (image coordinates, y up): hair and face; fully opaque inside
    /// `headMaskInner` of its radii.
    static let headMaskInner: CGFloat = 0.72
    static func headEllipse(face: CGRect) -> (center: CGPoint, rx: CGFloat, ry: CGFloat) {
        (CGPoint(x: face.midX, y: face.midY + face.height * 0.12), face.width * 0.78, face.height * 0.82)
    }

    /// Openness below which an open vowel shows the rest mouth (no sound, no open mouth).
    public static let openVowelMinOpenness = 0.06

    /// The one mouth shape drawn for a lip frame (nil = the expression's own mouth): the shape with
    /// the largest weight after fallbacks, open vowels counting as rest while quiet. Ties go to
    /// the earlier shape in `LipViseme.shapes`, so the choice is deterministic.
    static func mouthShape(lip: LipFrame, resolved: [LipViseme: LipViseme?]) -> LipViseme? {
        let open = Double(min(1, max(0, lip.openness)))
        var rest = 0.0
        var score: [LipViseme: Double] = [:]
        for (v, w) in lip.weights where w > 0 {
            guard v != .rest, let key = resolved[v] ?? nil, !(key.isOpenVowel && open < openVowelMinOpenness) else {
                rest += Double(w); continue
            }
            score[key, default: 0] += Double(w)
        }
        var best: LipViseme?
        var bestScore = rest
        for v in LipViseme.shapes { if let s = score[v], s > bestScore { best = v; bestScore = s } }
        return best
    }

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
        let box = CGRect(x: center.x - rx, y: center.y - ry, width: 2 * rx, height: 2 * ry).intersection(extent)
        return g.outputImage!
            .transformed(by: CGAffineTransform(a: rx / 100, b: 0, c: 0, d: ry / 100, tx: center.x, ty: center.y))
            .cropped(to: box.isNull ? .zero : box)
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
