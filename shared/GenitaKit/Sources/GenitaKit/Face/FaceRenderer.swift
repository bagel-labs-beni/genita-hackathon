// L4 face · Draws one frame of the companion from a face set, a mouth frame and a time.
// Layer order: expression still (crossfade on emotion) → one mouth patch (the lip frame's
// strongest shape; changes are cuts) → jaw warp (lower face stretched down by openness, strip warp) → expression
// stills (server `expression` events: eyes, brows and cheeks; the whole face once the mouth rests) → blink (eye band from
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
    public static let blinkGap = 2.5...6.0         // s between blinks (11/4: 2.5–6 s)
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
    /// Framing (11/3 small-mouth animals on a phone): zoom about a point just above the face centre
    /// (CI coords). 1 = plain aspect fill.
    private let framingZoom: CGFloat
    private let framingCenter: CGPoint
    private let blinkMask: CIImage?
    /// 11/4 brow flash: a soft band over the brows (moved up a little on stressed words) and its lift at full flash (still px)
    private let browMask: CIImage?
    private let browLift: CGFloat
    /// on/off (rollback); map-free on purpose: a tiny, speech-locked accent
    nonisolated(unsafe) public static var browFlash = true
    private var browTracker = BrowFlash.Tracker()
    /// Brow band and the eye cut-out (image coordinates, y up) from the eye line and the mouth centre: the brows sit
    /// 0.3 of the eye→mouth distance above the eyes, capped at 0.12 face widths (11/4: the face box takes in hair, so
    /// a band hung from its top lifted the hairline, not the brows). The brow ellipse ends above the eye cut-out.
    static func browGeometry(eyeY: CGFloat, mouthY: CGFloat, faceWidth: CGFloat) -> (browY: CGFloat, browRy: CGFloat, eyeY: CGFloat, eyeRy: CGFloat) {
        let off = max(6, min((eyeY - mouthY) * 0.3, faceWidth * 0.12))
        return (eyeY + off, off * 0.4, eyeY, off * 0.45)
    }
    /// The eye line (pixel rows from the top: the row the blink still differs most from the neutral one, and the
    /// span of rows that differ, both eyes of a tilted face included) between the face box top and the mouth; nil
    /// when they hardly differ. `shift` is the blink's alignment to the neutral still, as the renderer applies it
    /// (codex P2). Classic pixel maths on a ≤160 px wide copy.
    static func eyeLine(neutral: CGImage, blink: CGImage, shift: (dx: Int, dy: Int) = (0, 0), face: CGRect, mouthTop: CGFloat) -> (y: CGFloat, top: CGFloat, bottom: CGFloat)? {
        let bounds = CGRect(x: 0, y: 0, width: neutral.width, height: neutral.height)
        let shiftedBounds = CGRect(x: 0, y: 0, width: blink.width, height: blink.height).offsetBy(dx: CGFloat(-shift.dx), dy: CGFloat(-shift.dy))
        let roi = CGRect(x: face.minX, y: face.minY, width: face.width, height: mouthTop - face.minY)
            .intersection(bounds).intersection(shiftedBounds).integral
        guard !roi.isNull, roi.width >= 8, roi.height >= 8, let a = neutral.cropping(to: roi),
              let b = blink.cropping(to: roi.offsetBy(dx: CGFloat(shift.dx), dy: CGFloat(shift.dy))) else { return nil }
        let top = roi.minY
        let s = min(1, 160 / roi.width), w = max(4, Int(roi.width * s)), h = max(4, Int(roi.height * s))
        func gray(_ img: CGImage) -> [UInt8]? {
            var px = [UInt8](repeating: 0, count: w * h)
            let ok = px.withUnsafeMutableBytes { buf -> Bool in
                guard let c = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                        space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
                c.interpolationQuality = .medium
                c.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
                return true
            }
            return ok ? px : nil
        }
        guard let ga = gray(a), let gb = gray(b) else { return nil }
        var rows = [Double](repeating: 0, count: h)
        for y in 0..<h {   // bitmap row 0 = the image's top
            var n = 0
            for x in 0..<w where abs(Int(ga[y * w + x]) - Int(gb[y * w + x])) > 18 { n += 1 }
            rows[y] = Double(n) / Double(w)
        }
        let smooth: [Double] = (0..<h).map { y in
            let lo = max(0, y - 2), hi = min(h - 1, y + 2)
            return rows[lo...hi].reduce(0, +) / Double(hi - lo + 1)
        }
        guard let best = smooth.max(), best > 0.05, let at = smooth.firstIndex(of: best) else { return nil }
        // the span: every row within a quarter of the box of the peak that still differs a third as much
        let reach = max(2, h / 4)
        let near = (max(0, at - reach)...min(h - 1, at + reach)).filter { smooth[$0] >= best * 0.33 }
        let px = { (r: Int) in top + CGFloat(r) / s }
        return (px(at) + 0.5 / s, px(near.first ?? at), px((near.last ?? at) + 1))
    }
    /// Expression stills: eyes, brows and cheek apples (always), and the whole face (only while the mouth rests).
    private let exprUpperMask: CIImage
    private let exprFaceMask: CIImage
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
    /// Expression events for the current reply (audio-clock ms): the stills layer (`expressionStills`) and, when
    /// `expressionLayer` is on, the warp layer. `utteranceId` scopes them to their reply (its audio clock).
    public func addExpression(_ e: FaceExpressionEvent, utteranceId: Int? = nil) {
        lock.lock(); defer { lock.unlock() }
        if Self.expressionStills { stills.add(e, utterance: utteranceId) }
        guard Self.expressionLayer else { return }
        var e = e
        // demo (11/3): laugh over the lip rig reads rubbery; it plays as an open smile
        if Self.laughAsSmileOpen, e.tag == "laugh", flowMorph?.data.map.rig != nil { e.tag = "smileopen" }
        flowMorph?.expressionEvents.append(e)
    }
    /// Expression stills layer (11/3 night, CEO: "our companion has no facial expressions"): a server `expression`
    /// event crossfades the prepped Muse Image still of that feeling into the eyes, brows and cheeks (~300 ms), holds
    /// it through the clause and a short mood hold after it, then relaxes to the photo. The mouth keeps speaking
    /// from the lip layer; once the mouth has rested a moment the still's own mouth (the smile itself) joins in.
    /// With no active event nothing is drawn: plain speech keeps the still-face gates (eyes = the photo).
    nonisolated(unsafe) public static var expressionStills = true
    private var stills = ExpressionStills()
    /// A reply starts (the driver calls this for its first event of any kind): the expression stills drop the old
    /// reply's events and clock.
    public func beginUtterance(_ id: Int) { lock.lock(); stills.begin(utterance: id); lock.unlock() }
    /// Weights of the expression stills drawn at the last frame (tests, QA logs).
    public var expressionStillWeights: [FaceExpression: Double] { lock.lock(); defer { lock.unlock() }; return stills.shown }
    /// Laugh events on lip-rig faces play as `smileopen` (demo setting; the laugh warp fights the rig).
    nonisolated(unsafe) public static var laughAsSmileOpen = true
    /// Cancel / barge-in: drop the mouth's smoothing and held shapes so it rests on the next frame (an expression
    /// on screen relaxes smoothly; its reply's events are dropped).
    public func resetMouth() { lock.lock(); flowMorph?.reset(); stills.cancel(); browTracker = BrowFlash.Tracker(); lock.unlock() }
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
            motion.rollGain = a.rollGain ?? a.headGain; motion.nodWidth = a.nodWidth; motion.cameraGain = a.camera
            motion.lockVertical = a.lockY
            motion.swayGain = a.sway
        }
        let fr = Self.framing(faceSet)
        framingZoom = fr.zoom
        framingCenter = CGPoint(x: fr.center.x, y: CGFloat(faceSet.pixelSize.height) - fr.center.y)
        // Flow morph at `flowDensity` × the output's pixel density (capped at the still's own).
        let outScale = Double(max(outputSize.width / faceSet.pixelSize.width, outputSize.height / faceSet.pixelSize.height)) * Double(AliveMotion.overscan) * Self.flowDensity * Double(fr.zoom)
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
        // brows: a band above the eye line the blink still shows (none without one, nor on animals: 11/4 the band
        // must sit on the brows, not the hairline), the eyes cut out (codex P2: the lift must never move an eye);
        // a 0.3 s lift on stressed words (BrowFlash)
        let lift = max(1, face.height * 0.012)
        browLift = lift
        if faceSet.flow?.kind != "animal", let blink = faceSet.expressions[.blink],
           let eye = Self.eyeLine(neutral: faceSet.image(for: .neutral), blink: blink, shift: faceSet.expressionShift[.blink] ?? (0, 0),
                                  face: faceSet.faceBox, mouthTop: faceSet.mouthBox.minY) {
            let g = Self.browGeometry(eyeY: h - eye.y, mouthY: mouth.midY, faceWidth: face.width)
            let brow = Self.ellipseMask(center: CGPoint(x: face.midX, y: g.browY), rx: face.width * 0.42, ry: g.browRy, inner: 0.45, extent: extent)
            // eye cut-out (codex P2 ×2): its solid core covers every row the blink changed (both eyes of a tilted
            // face) plus the lift and a margin, so no eye pixel is ever copied up
            let eyeTop = h - eye.top, eyeBottom = h - eye.bottom
            let core = max(g.eyeRy * 0.7, (eyeTop - eyeBottom) / 2 + lift + 3)
            let eyes = Self.ellipseMask(center: CGPoint(x: face.midX, y: (eyeTop + eyeBottom) / 2), rx: face.width * 0.5 / 0.85, ry: core / 0.7,
                                        inner: 0.7, extent: extent)
            // brow alpha × (1 − eye alpha) (codex P2: an inverted mask keeps its own alpha, so a multiply kept only the overlap)
            let cut = CIFilter.sourceOutCompositing(); cut.inputImage = brow; cut.backgroundImage = eyes
            browMask = cut.outputImage!.cropped(to: extent)
        } else {
            browMask = nil
        }
        blinkMask = faceSet.hasBlink
            ? Self.ellipseMask(center: CGPoint(x: face.midX, y: (bandTop + bandBottom) / 2),
                               rx: face.width * 0.55, ry: max(4, (bandTop - bandBottom) / 2), inner: 0.6, extent: extent)
            : nil
        // Expression stills: from the brows down to a mouth height above the lips (where the lip layer's blend
        // starts, #434), 0.56 face widths across; the lower edge stays above the lips so talking never ghosts.
        let exprTop = face.maxY - face.height * 0.04, exprBottom = mouth.maxY + mouth.height * 1.4
        exprUpperMask = Self.ellipseMask(center: CGPoint(x: face.midX, y: (exprTop + exprBottom) / 2), rx: face.width * 0.56,
                                         ry: max(4, (exprTop - exprBottom) / 2), inner: 0.62, extent: extent)
        exprFaceMask = Self.ellipseMask(center: CGPoint(x: face.midX, y: face.midY), rx: face.width * 0.56, ry: face.height * 0.56,
                                        inner: 0.66, extent: extent)
        let (_, un) = Self.jawSpan(face: face, mouth: mouth)
        jawMask = Self.ellipseMask(center: CGPoint(x: face.midX, y: mouth.midY - un * 0.5),
                                   rx: face.width * 0.62, ry: un * 1.3, inner: 0.62, extent: extent)
        // Person layers from the SAM face box: the head (with hair) and the shoulders/chest under it.
        // Soft masks, so the warp between layers is a smooth field with no holes.
        let he = Self.headEllipse(face: face)
        var head = Self.ellipseMask(center: he.center, rx: he.rx, ry: he.ry, inner: Self.headMaskInner, extent: extent)
        var body = Self.ellipseMask(center: CGPoint(x: face.midX, y: face.minY - face.height * 1.25),
                                    rx: face.width * 2.0, ry: face.height * 1.75, inner: 0.6, extent: extent)
        // Only the person moves (11/3 Chelsea: still background): layers = ellipse × person lock. The lock
        // is prep's person matte (SAM, hair edge feathered) or, without one, a fixed feathered
        // head-and-shoulders ellipse from the face box; outside it the still itself shows.
        let ext = extent
        let lock: CIImage
        if let pm = faceSet.personMask { lock = Self.personAlpha(pm, extent: ext) } else { lock = Self.headShouldersLock(face: face, extent: ext) }
        head = Self.multiply(head, lock, extent: ext); body = Self.multiply(body, lock, extent: ext)
        headMask = head; bodyMask = body
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

        // 3b. expression stills (server events): eyes/brows/cheeks, plus the mouth once it has rested
        var stillsTotal = 0.0
        if Self.expressionStills {
            let shown: (weights: [FaceExpression: Double], rest: Double) = {
                lock.lock(); defer { lock.unlock() }
                // the reply's own clock: the lip lookahead is for the mouth only (codex P3)
                return stills.step(at: t, audioMs: context.map { $0.audioMs - lipLookaheadMs }, openness: open, available: Set(bases.keys))
            }()
            for (e, w) in shown.weights.sorted(by: { $0.key.rawValue < $1.key.rawValue }) where w > 0.002 {
                guard let still = bases[e] else { continue }
                stillsTotal += w
                // eyes/brows band at the talk share while the mouth talks, the whole still once it rests
                let talk = ExpressionStills.talkShare(e)
                var mask = Self.withOpacity(exprUpperMask, w * (talk + (1 - talk) * shown.rest))
                if shown.rest > 0.002 {
                    let u = CIFilter.maximumCompositing()
                    u.inputImage = Self.withOpacity(exprFaceMask, w * shown.rest); u.backgroundImage = mask
                    mask = u.outputImage!.cropped(to: extent)
                }
                let f = CIFilter.blendWithAlphaMask()
                f.inputImage = still
                f.backgroundImage = img
                f.maskImage = mask
                img = f.outputImage!.cropped(to: extent)
            }
        }

        // 4. blink
        // (no blink cut over an expression: the blink still's neutral brows would jump for 120 ms)
        let blink = stillsTotal > 0.15 ? 0 : blinkAmount(at: t)
        if blink > 0.3, let mask = blinkMask, let closed = bases[.blink] {
            let f = CIFilter.blendWithAlphaMask()
            f.inputImage = closed
            f.backgroundImage = img
            // A blink is a cut (half-dissolved lids read as glass), held while it is more than 30% closed.
            f.maskImage = blink > 0.3 ? mask : Self.withOpacity(mask, 0)
            img = f.outputImage!.cropped(to: extent)
        }

        // 4b. brow flash (11/4): stressed words lift the brows ~0.2 of their gap for 0.3 s — the band is moved up rigidly
        // through a soft mask (no warp of the eyes; 0–2 per sentence)
        if Self.browFlash, !reduceMotion, stillsTotal < 0.15, let bm = browMask, let ctx = context {
            let w: Double = { lock.lock(); defer { lock.unlock() }
                return browTracker.weight(atMs: ctx.audioMs - lipLookaheadMs, phonemes: ctx.timeline.phonemeTimings, loudness: { ctx.timeline.loudness(atMs: $0) }) }()
            if w > 0.01 {
                let lifted = img.clampedToExtent().transformed(by: CGAffineTransform(translationX: 0, y: browLift * CGFloat(w))).cropped(to: extent)
                let f = CIFilter.blendWithAlphaMask()
                f.inputImage = lifted
                f.backgroundImage = img
                f.maskImage = bm
                img = f.outputImage!.cropped(to: extent)
            }
        }

        // 5. aspect fill (with overscan while the camera drifts), then 6. the alive base at output
        // resolution: the frame so far (mouth, jaw, blink included) is cut into head, body and
        // background layers that move separately, so the mouth rides the head and never slides.
        let out = CGRect(origin: .zero, size: outputSize)
        let scale = max(outputSize.width / extent.width, outputSize.height / extent.height) * (reduceMotion ? 1 : AliveMotion.overscan)
        var fill = CGAffineTransform(a: scale, b: 0, c: 0, d: scale,
                                     tx: (outputSize.width - extent.width * scale) / 2, ty: (outputSize.height - extent.height * scale) / 2)
        if framingZoom > 1.001 {
            // zoom about the framing point where it already sits on screen (inside the image: no edge shows)
            let c = CGPoint(x: framingCenter.x - extent.minX, y: framingCenter.y - extent.minY).applying(fill)
            fill = fill.concatenating(CGAffineTransform(translationX: -c.x, y: -c.y))
                .concatenating(CGAffineTransform(scaleX: framingZoom, y: framingZoom))
                .concatenating(CGAffineTransform(translationX: c.x, y: c.y))
        }
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

    /// Zoom and centre (still px, y down). map.framing wins; otherwise people stay unzoomed and a
    /// face shorter than 35 % of the still is zoomed up to it (1…1.35×), centred a little above the
    /// face centre.
    static func framing(_ set: FaceSet) -> (zoom: CGFloat, center: CGPoint) {
        let f = set.faceBox, H = Double(set.pixelSize.height)
        let fh = Double(f.height) / max(1, H)
        let fr = set.flow?.map.framing
        let human = (set.flow?.kind ?? "human") == "human"
        var z = fr?.zoom ?? (human || fh <= 0 ? 1 : min(1.35, max(1, 0.35 / fh)))
        z = z.isFinite ? min(2, max(1, z)) : 1
        let cy = fr?.cy.map { $0 * H } ?? (Double(f.midY) - 0.1 * Double(f.height))
        // the zoom centre stays inside the still, so the zoomed image still covers the frame (no edge smear)
        let cyIn = min(H, max(0, cy.isFinite ? cy : Double(f.midY)))
        return (CGFloat(z.isFinite ? z : 1), CGPoint(x: min(set.pixelSize.width, max(0, f.midX)), y: CGFloat(cyIn)))
    }

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
    /// Prep's person matte (8-bit grey, white = subject, hard edge) as an alpha mask at the still's extent.
    static func personAlpha(_ cg: CGImage, extent: CGRect) -> CIImage {
        var m = CIImage(cgImage: cg)
        if m.extent.size != extent.size {
            m = m.transformed(by: CGAffineTransform(scaleX: extent.width / m.extent.width, y: extent.height / m.extent.height))
        }
        // prep sends a hard matte: erode ~4 px (fur / hair halo stays with the background), feather ~2.5 px
        let erode = CIFilter.morphologyMinimum()
        erode.inputImage = m.clampedToExtent(); erode.radius = Float(max(1, 0.0035 * extent.width))
        let blur = CIFilter.gaussianBlur()
        blur.inputImage = erode.outputImage!; blur.radius = Float(max(1.5, 0.0025 * extent.width))
        let a = CIFilter.maskToAlpha()
        a.inputImage = blur.outputImage!.cropped(to: extent)
        return a.outputImage!.cropped(to: extent)
    }

    /// Non-ML person lock: head (with hair) and shoulders as two feathered ellipses (CI coords, y up).
    static func headShouldersLock(face: CGRect, extent: CGRect) -> CIImage {
        let he = headEllipse(face: face)
        let head = ellipseMask(center: he.center, rx: he.rx * 1.08, ry: he.ry * 1.08, inner: 0.82, extent: extent)
        let shoulders = ellipseMask(center: CGPoint(x: face.midX, y: face.minY - face.height * 0.95),
                                    rx: face.width * 1.25, ry: face.height * 0.75, inner: 0.78, extent: extent)
        let f = CIFilter.maximumCompositing()
        f.inputImage = head; f.backgroundImage = shoulders
        return f.outputImage!.cropped(to: extent)
    }

    /// a with its alpha multiplied by b's alpha (source-in): the product of two masks.
    static func multiply(_ a: CIImage, _ b: CIImage, extent: CGRect) -> CIImage {
        let f = CIFilter.sourceInCompositing()
        f.inputImage = a; f.backgroundImage = b
        return f.outputImage!.cropped(to: a.extent.intersection(extent))
    }

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
