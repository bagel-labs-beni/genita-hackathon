import SwiftUI

/// V03 face scan (Chunsik pentagon r01 motion + r02 net, ./_qa-scripts/genita-splash/mesh).
/// A 2 pt #00A2FF line with a glow and a 24 pt band crosses the photo card with the check's progress. Once the
/// answer brings SAM's face points, the net is laid on from the top: each point fades and grows in (0.18 s ease-out; was
/// a spring, TF 331) as the line passes it, each line draws itself (0.18 s) once its lower end is passed, each face fills
/// (#8CC8FF 25 %) once its second point is passed, under a 12 pt feather at the line. A later answer glides the net. After 100 %: the faces breathe
/// 22↔28 % for the 1 s hold, then everything fades (0.3 s).
struct FaceScanOverlay: View, Animatable {
    /// 0…1, where the scan line is (the V03 bar)
    var progress: Double
    /// 0…1, how far down the net may show: 0 until the answer, then 0 → 1 with the finish; the net shows above min(progress, reveal)
    var reveal: Double
    var mesh: FaceMesh?
    /// the photo's size in pixels (orientation applied): the photo is shown `scaledToFill`
    var imageSize: CGSize
    /// the photo's top-left in the card (FaceMesh.fillOrigin): the photo and the net move together when it pans to the face
    var origin: CGPoint = .zero
    /// when the bar reached 100 % (the hold, the breathing and the fade count from here)
    var doneAt: Date?
    /// no pops or trims (Reduce Motion, and the still review captures)
    var reduceMotion = false
    /// the moving scan line and band (off under Reduce Motion: the net then appears in place at the answer)
    var showLine = true
    /// TF 331 (Chelsea: "flickers a lot"): a new answer moves the net instead of re-popping it — points and lines glide to
    /// their new places (0.18 s ease-out), a different net crossfades, points fade + grow in without overshoot, and the
    /// sweep never runs back up. false = the old snap / spring (kept for the before/after capture test only).
    var smooth = true
    /// tests only: draw this one instant with this clock (ImageRenderer has no running timeline)
    var frame: (clock: RevealClock, at: Date)?

    var animatableData: AnimatablePair<AnimatablePair<Double, Double>, AnimatablePair<CGFloat, CGFloat>> {
        get { AnimatablePair(AnimatablePair(progress, reveal), AnimatablePair(origin.x, origin.y)) }
        set { progress = newValue.first.first; reveal = newValue.first.second; origin = CGPoint(x: newValue.second.first, y: newValue.second.second) }
    }

    static let accent = Color(red: 0, green: 0.635, blue: 1)          // #00A2FF: line, band, points
    static let lineBlue = Color(red: 0.302, green: 0.639, blue: 1)    // #4DA3FF
    static let faceBlue = Color(red: 0.549, green: 0.784, blue: 1)    // #8CC8FF
    static let hold = 1.0, fadeOut = 0.3, lineOut = 0.15, pop = 0.25, trim = 0.15, feather: CGFloat = 12
    /// TF 331 smoothing: how long a moved net glides, a replaced net fades and a new point / line / face eases in
    static let glide = 0.18

    @State private var clock = RevealClock()

    var body: some View {
        if let frame {
            Canvas { ctx, size in draw(in: &ctx, size: size, now: frame.at, clock: frame.clock) }
        } else {
            live
        }
    }

    private var live: some View {
        TimelineView(.animation(minimumInterval: nil, paused: reduceMotion || (mesh == nil && doneAt == nil && clock.mesh == nil))) { timeline in
            Canvas { ctx, size in draw(in: &ctx, size: size, now: timeline.date, clock: clock) }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func draw(in ctx: inout GraphicsContext, size: CGSize, now: Date, clock: RevealClock) {
        let sinceDone = doneAt.map { now.timeIntervalSince($0) } ?? -1
        // the whole overlay fades after the hold
        let outA = sinceDone >= Self.hold ? 1 - Self.easeOut(min(1, (sinceDone - Self.hold) / Self.fadeOut)) : 1
        guard outA > 0.001 else { return }
        ctx.opacity = outA
        let lineY = size.height * CGFloat(min(1, max(0, progress)))

        // b14: a dropped answer (mesh nil for a frame or a re-check) keeps the last net on screen for `dropHold`, then fades it
        // over the glide time, instead of blinking it off and re-laying it from nothing
        let dropA = mesh == nil ? clock.dropAlpha(at: now) : 1
        if mesh != nil { clock.noteDrop(nil) }
        if let mesh = mesh ?? (dropA > 0.001 ? clock.mesh : nil) {
            let outA = outA * dropA
            ctx.opacity = outA
            let still = reduceMotion || !smooth
            if self.mesh != nil { clock.update(to: mesh, at: now, glide: still ? 0 : Self.glide) }
            // the sweep only goes down: a reset bar (Try again) starts it over, anything else never uncovers less
            let netY = clock.netY(size.height * CGFloat(min(1, max(0, min(progress, reveal)))), monotonic: smooth && progress > 0.01)
            let pts = clock.points(at: now).map { FaceMesh.place($0, image: imageSize, in: size, origin: origin) }
            for (i, p) in pts.enumerated() where p.y <= netY + 0.5 { clock.mark(i, at: now) }
            var faceA = 0.25
            if sinceDone >= 0 && !reduceMotion { faceA = 0.25 + 0.03 * sin(2 * .pi * sinceDone / 1.6) }
            // the net this one replaced (a different layout): exactly as it was showing, fading out over the glide time
            if let old = clock.leaving(at: now) {
                var fading = ctx
                fading.opacity = outA * old.alpha
                drawNet(old.mesh, at: old.points.map { FaceMesh.place($0, image: imageSize, in: size, origin: origin) },
                        shown: { i in old.times[i].map { now.timeIntervalSince($0) } }, netY: netY, faceA: faceA, size: size, in: &fading)
            }
            drawNet(mesh, at: pts, shown: { i in clock.time(i).map { now.timeIntervalSince($0) } }, netY: netY, faceA: faceA, size: size, in: &ctx)
            ctx.opacity = 1
        }

        // the scan line and its band cross the whole card; they fade out over 0.15 s at 100 %
        let lineA = sinceDone >= 0 ? 1 - min(1, sinceDone / Self.lineOut) : (progress > 0.0005 ? 1 : 0)
        guard showLine, lineA > 0.001 else { return }
        var band = ctx
        band.opacity = outA * lineA
        band.fill(Path(CGRect(x: 0, y: lineY - 24, width: size.width, height: 24)),
                  with: .linearGradient(Gradient(colors: [Self.accent.opacity(0), Self.accent.opacity(0.10)]),
                                        startPoint: CGPoint(x: 0, y: lineY - 24), endPoint: CGPoint(x: 0, y: lineY)))
        band.addFilter(.shadow(color: Self.accent.opacity(0.6), radius: 3))
        band.fill(Path(CGRect(x: 0, y: lineY - 1, width: size.width, height: 2)), with: .color(Self.accent))
    }

    /// One net: faces under the line's feather, lines drawn from their upper end, points easing (or springing) in.
    /// `shown(i)` = seconds since point i was passed, nil = not yet.
    private func drawNet(_ mesh: FaceMesh, at pts: [CGPoint], shown: (Int) -> Double?, netY: CGFloat, faceA: Double,
                         size: CGSize, in ctx: inout GraphicsContext) {
        let grow = smooth ? Self.glide : Self.trim
        // faces: each once its 2nd point (by height) is in, fading up, under the line's feather
        ctx.drawLayer { layer in
            let foot = netY + 6
            layer.clip(to: Path(CGRect(x: 0, y: 0, width: size.width, height: foot)))
            for t in mesh.triangles {
                let second = t.sorted { pts[$0].y < pts[$1].y }[1]
                guard let s = shown(second) else { continue }
                let k = reduceMotion ? 1 : Self.easeOut(min(1, s / grow))
                var path = Path()
                path.move(to: pts[t[0]]); path.addLine(to: pts[t[1]]); path.addLine(to: pts[t[2]]); path.closeSubpath()
                layer.fill(path, with: .color(Self.faceBlue.opacity(faceA * k)))
            }
            // the feather: opaque down to 12 pt above the line's foot, clear at it
            layer.blendMode = .destinationIn
            layer.fill(Path(CGRect(x: 0, y: 0, width: size.width, height: foot)),
                       with: .linearGradient(Gradient(stops: [.init(color: .white, location: 0),
                                                              .init(color: .white, location: max(0, (foot - Self.feather) / max(foot, 1))),
                                                              .init(color: .white.opacity(0), location: 1)]),
                                             startPoint: .zero, endPoint: CGPoint(x: 0, y: foot)))
        }
        // lines: drawn from the upper end down, once the lower end is in
        for e in mesh.edges {
            let (top, bottom) = pts[e.a].y <= pts[e.b].y ? (e.a, e.b) : (e.b, e.a)
            guard let s = shown(bottom) else { continue }
            let k = reduceMotion ? 1 : Self.easeOut(min(1, s / grow))
            let a = pts[top], b = pts[bottom]
            var line = Path()
            line.move(to: a); line.addLine(to: CGPoint(x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k))
            ctx.stroke(line, with: .color(Self.lineBlue.opacity(0.9)), style: StrokeStyle(lineWidth: 1, lineCap: .round))
        }
        // points: 7 pt #00A2FF with a 1.5 pt white rim; smooth = fade + grow in, no overshoot (25 springs in a row read
        // as flicker, TF 331); the old look = the r01 spring pop
        let base = ctx.opacity
        for (i, p) in pts.enumerated() {
            guard let s = shown(i) else { continue }
            let k = reduceMotion ? 1 : smooth ? Self.easeOut(min(1, s / Self.glide)) : Self.spring(s)
            guard k > 0.01 else { continue }
            let r = 3.5 * k
            ctx.opacity = smooth ? base * min(1, k) : base
            ctx.fill(Path(ellipseIn: CGRect(x: p.x - r - 0.75, y: p.y - r - 0.75, width: 2 * r + 1.5, height: 2 * r + 1.5)), with: .color(.white))
            ctx.fill(Path(ellipseIn: CGRect(x: p.x - r + 0.75, y: p.y - r + 0.75, width: 2 * r - 1.5, height: 2 * r - 1.5)), with: .color(Self.accent))
        }
        ctx.opacity = base
    }

    static func easeOut(_ x: Double) -> Double { 1 - pow(1 - x, 3) }

    /// under-damped step, response 0.25 s, damping 0.6 (r01): 0 → ~1.1 → 1, `t` in seconds
    static func spring(_ t: Double) -> Double {
        guard t > 0 else { return 0 }
        let w = 2 * Double.pi / 0.25, z = 0.6, wd = w * (1 - z * z).squareRoot()
        return 1 - exp(-z * w * t) * (cos(wd * t) + z / (1 - z * z).squareRoot() * sin(wd * t))
    }
}

/// When each point of the net appeared, and where the net is moving (drawing state, not view state: updating it must not
/// re-render the view). A new answer with the same layout keeps the reveal times and glides the points from where they
/// are; a different layout (full ↔ sparse, rim-only ↔ full) starts its reveal again while the old one fades out.
final class RevealClock {
    private(set) var mesh: FaceMesh?
    private var times: [Int: Date] = [:]
    private var from: [CGPoint]?
    private var changedAt: Date?
    /// the replaced net as it was showing (places and reveal times) and when it started fading
    private var old: (mesh: FaceMesh, points: [CGPoint], times: [Int: Date], since: Date)?
    private var lowest: CGFloat = 0
    /// seconds a change glides / crossfades; 0 = snap (Reduce Motion, the old look)
    private var glide = 0.0

    func update(to m: FaceMesh, at now: Date, glide: Double) {
        self.glide = glide
        guard mesh != m else { return }
        defer { mesh = m }
        guard glide > 0, let current = mesh else { times = [:]; from = nil; old = nil; changedAt = nil; return }
        let here = points(at: now)
        if current.points.count == m.points.count && current.triangles == m.triangles && current.edges == m.edges {
            from = here; changedAt = now            // same net, new places: glide, no re-pop (a fading old net keeps fading)
        } else {
            // another net: the one showing fades out as it was (an older one still fading gives way to it), the new one reveals
            old = (current, here, times, now); from = nil; changedAt = nil; times = [:]
        }
    }
    /// image-fraction points, gliding from where they were when the answer changed
    func points(at now: Date) -> [CGPoint] {
        guard let mesh else { return [] }
        guard glide > 0, let from, let changedAt, from.count == mesh.points.count else { return mesh.points }
        let k = FaceScanOverlay.easeOut(min(1, max(0, now.timeIntervalSince(changedAt) / glide)))
        if k >= 1 { self.from = nil; return mesh.points }
        return zip(from, mesh.points).map { CGPoint(x: $0.x + ($1.x - $0.x) * k, y: $0.y + ($1.y - $0.y) * k) }
    }
    /// the replaced net and its fading alpha, while it lasts
    func leaving(at now: Date) -> (mesh: FaceMesh, points: [CGPoint], times: [Int: Date], alpha: Double)? {
        guard glide > 0, let old else { return nil }
        let a = 1 - FaceScanOverlay.easeOut(min(1, max(0, now.timeIntervalSince(old.since) / glide)))
        if a <= 0.001 { self.old = nil; return nil }
        return (old.mesh, old.points, old.times, a)
    }
    /// how far down the net shows: never less than it already showed (unless the bar starts over)
    func netY(_ y: CGFloat, monotonic: Bool) -> CGFloat {
        lowest = monotonic ? max(lowest, y) : y
        return lowest
    }
    /// when the answer's mesh went missing (nil until it is back)
    private var droppedAt: Date?
    static let dropHold = 0.6
    func noteDrop(_ at: Date?) { droppedAt = at }
    /// 1 while the last net is held through a dropped answer, then easing to 0 over the glide time
    func dropAlpha(at now: Date) -> Double {
        guard mesh != nil else { return 0 }
        if droppedAt == nil { droppedAt = now }
        let t = now.timeIntervalSince(droppedAt ?? now) - Self.dropHold
        return 1 - FaceScanOverlay.easeOut(min(1, max(0, t / FaceScanOverlay.glide)))
    }
    func mark(_ i: Int, at date: Date) { if times[i] == nil { times[i] = date } }
    func time(_ i: Int) -> Date? { times[i] }
}
