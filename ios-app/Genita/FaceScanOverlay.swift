import SwiftUI

/// V03 face scan (Chunsik pentagon r01 motion + r02 net, ./_qa-scripts/genita-splash/mesh).
/// A 2 pt #00A2FF line with a glow and a 24 pt band crosses the photo card with the check's progress. Once the
/// answer brings SAM's face points, the net is laid on from the top: each point pops in (spring, response 0.25 s,
/// damping 0.6) as the line passes it, each line draws itself (0.15 s) once its lower end is passed, each face fills
/// (#8CC8FF 25 %) once its second point is passed, under a 12 pt feather at the line. After 100 %: the faces breathe
/// 22↔28 % for the 1 s hold, then everything fades (0.3 s).
struct FaceScanOverlay: View, Animatable {
    /// 0…1, where the scan line is (the V03 bar)
    var progress: Double
    /// 0…1, how far down the net may show: 0 until the answer, then 0 → 1 with the finish; the net shows above min(progress, reveal)
    var reveal: Double
    var mesh: FaceMesh?
    /// the photo's size in pixels (orientation applied): the photo is shown `scaledToFill`
    var imageSize: CGSize
    /// when the bar reached 100 % (the hold, the breathing and the fade count from here)
    var doneAt: Date?
    var reduceMotion = false

    var animatableData: AnimatablePair<Double, Double> {
        get { AnimatablePair(progress, reveal) }
        set { progress = newValue.first; reveal = newValue.second }
    }

    static let accent = Color(red: 0, green: 0.635, blue: 1)          // #00A2FF: line, band, points
    static let lineBlue = Color(red: 0.302, green: 0.639, blue: 1)    // #4DA3FF
    static let faceBlue = Color(red: 0.549, green: 0.784, blue: 1)    // #8CC8FF
    static let hold = 1.0, fadeOut = 0.3, lineOut = 0.15, pop = 0.25, trim = 0.15, feather: CGFloat = 12

    @State private var clock = RevealClock()

    var body: some View {
        TimelineView(.animation(minimumInterval: nil, paused: reduceMotion || (mesh == nil && doneAt == nil))) { timeline in
            Canvas { ctx, size in draw(in: &ctx, size: size, now: timeline.date) }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func draw(in ctx: inout GraphicsContext, size: CGSize, now: Date) {
        let sinceDone = doneAt.map { now.timeIntervalSince($0) } ?? -1
        // the whole overlay fades after the hold
        let outA = sinceDone >= Self.hold ? 1 - Self.easeOut(min(1, (sinceDone - Self.hold) / Self.fadeOut)) : 1
        guard outA > 0.001 else { return }
        ctx.opacity = outA
        let lineY = size.height * CGFloat(min(1, max(0, progress)))

        if let mesh {
            clock.reset(for: mesh)
            let netY = size.height * CGFloat(min(1, max(0, min(progress, reveal))))
            let pts = mesh.points.map { FaceMesh.aspectFill($0, image: imageSize, in: size) }
            for (i, p) in pts.enumerated() where p.y <= netY + 0.5 { clock.mark(i, at: now) }
            let shown = { (i: Int) -> Double? in clock.time(i).map { now.timeIntervalSince($0) } }

            // faces: each once its 2nd point (by height) is in, fading up over the trim time, under the line's feather
            var faceA = 0.25
            if sinceDone >= 0 && !reduceMotion { faceA = 0.25 + 0.03 * sin(2 * .pi * sinceDone / 1.6) }
            ctx.drawLayer { layer in
                let foot = netY + 6
                layer.clip(to: Path(CGRect(x: 0, y: 0, width: size.width, height: foot)))
                for t in mesh.triangles {
                    let second = t.sorted { pts[$0].y < pts[$1].y }[1]
                    guard let s = shown(second) else { continue }
                    let k = reduceMotion ? 1 : Self.easeOut(min(1, s / Self.trim))
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
                let k = reduceMotion ? 1 : Self.easeOut(min(1, s / Self.trim))
                let a = pts[top], b = pts[bottom]
                var line = Path()
                line.move(to: a); line.addLine(to: CGPoint(x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k))
                ctx.stroke(line, with: .color(Self.lineBlue.opacity(0.9)), style: StrokeStyle(lineWidth: 1, lineCap: .round))
            }
            // points: 7 pt #00A2FF with a 1.5 pt white rim, popping in
            for (i, p) in pts.enumerated() {
                guard let s = shown(i) else { continue }
                let k = reduceMotion ? 1 : Self.spring(s)
                guard k > 0.01 else { continue }
                let r = 3.5 * k
                ctx.fill(Path(ellipseIn: CGRect(x: p.x - r - 0.75, y: p.y - r - 0.75, width: 2 * r + 1.5, height: 2 * r + 1.5)), with: .color(.white))
                ctx.fill(Path(ellipseIn: CGRect(x: p.x - r + 0.75, y: p.y - r + 0.75, width: 2 * r - 1.5, height: 2 * r - 1.5)), with: .color(Self.accent))
            }
        }

        // the scan line and its band cross the whole card; they fade out over 0.15 s at 100 %
        let lineA = sinceDone >= 0 ? 1 - min(1, sinceDone / Self.lineOut) : (progress > 0.0005 ? 1 : 0)
        guard lineA > 0.001 else { return }
        var band = ctx
        band.opacity = outA * lineA
        band.fill(Path(CGRect(x: 0, y: lineY - 24, width: size.width, height: 24)),
                  with: .linearGradient(Gradient(colors: [Self.accent.opacity(0), Self.accent.opacity(0.10)]),
                                        startPoint: CGPoint(x: 0, y: lineY - 24), endPoint: CGPoint(x: 0, y: lineY)))
        band.addFilter(.shadow(color: Self.accent.opacity(0.6), radius: 3))
        band.fill(Path(CGRect(x: 0, y: lineY - 1, width: size.width, height: 2)), with: .color(Self.accent))
    }

    static func easeOut(_ x: Double) -> Double { 1 - pow(1 - x, 3) }

    /// under-damped step, response 0.25 s, damping 0.6 (r01): 0 → ~1.1 → 1, `t` in seconds
    static func spring(_ t: Double) -> Double {
        guard t > 0 else { return 0 }
        let w = 2 * Double.pi / 0.25, z = 0.6, wd = w * (1 - z * z).squareRoot()
        return 1 - exp(-z * w * t) * (cos(wd * t) + z / (1 - z * z).squareRoot() * sin(wd * t))
    }
}

/// When each point of the net appeared (drawing state, not view state: marking it must not re-render the view).
final class RevealClock {
    private var mesh: FaceMesh?
    private var times: [Int: Date] = [:]
    func reset(for m: FaceMesh) { if mesh != m { mesh = m; times = [:] } }
    func mark(_ i: Int, at date: Date) { if times[i] == nil { times[i] = date } }
    func time(_ i: Int) -> Date? { times[i] }
}
