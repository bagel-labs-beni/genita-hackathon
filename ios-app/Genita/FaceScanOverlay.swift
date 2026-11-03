import SwiftUI
import GenitaKit

/// V03 face scan (dyno Figma V03 526:15314, Chelsea 11/4 02:31; spec ./_qa-scripts/genita-dyno-video/spec).
/// A #00A2FF line crosses the photo with the check's progress. Once the answer brings SAM's face points, the
/// low-poly net is laid on "from the top down": the light fill rises behind the line, each point pops in (spring
/// 0.25 s) as the line passes it, and each line draws itself (0.15 s) once both of its ends are in.
struct FaceScanOverlay: View, Animatable {
    /// 0…1, where the scan line is (the V03 bar)
    var progress: Double
    /// 0…1, how far down the net may show (0 until the answer, then 0 → 1 over 0.4 s); the net shows above min(progress, reveal)
    var reveal: Double
    /// 0…1, the whole overlay; the exit fades it back to the plain photo
    var overlayOpacity: Double
    var mesh: FaceMesh?
    /// the photo's size in pixels (orientation applied): the photo is shown `scaledToFill`
    var imageSize: CGSize
    var reduceMotion = false

    var animatableData: AnimatablePair<Double, Double> {
        get { AnimatablePair(progress, reveal) }
        set { progress = newValue.first; reveal = newValue.second }
    }

    static let accent = Color(red: 0, green: 0.635, blue: 1)          // #00A2FF: line and points
    static let meshBlue = Color(red: 0.302, green: 0.639, blue: 1)    // #4DA3FF: the net's lines
    static let fill = Color(red: 0.55, green: 0.78, blue: 1)          // the passed area, 25 %

    @State private var clock = RevealClock()

    var body: some View {
        GeometryReader { geo in
            let size = geo.size
            TimelineView(.animation(minimumInterval: nil, paused: mesh == nil || reduceMotion)) { timeline in
                Canvas { ctx, size in draw(in: &ctx, size: size, now: timeline.date) }
            }
            .frame(width: size.width, height: size.height)
        }
        .opacity(overlayOpacity)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func draw(in ctx: inout GraphicsContext, size: CGSize, now: Date) {
        let lineY = size.height * CGFloat(min(1, max(0, progress)))
        if let mesh {
            clock.reset(for: mesh)
            let netY = size.height * CGFloat(min(1, max(0, min(progress, reveal))))
            let pts = mesh.points.map { FaceMesh.aspectFill($0, image: imageSize, in: size) }

            // the fill rises with the line
            var hull = Path()
            if let first = mesh.hull.first {
                hull.move(to: FaceMesh.aspectFill(first, image: imageSize, in: size))
                for p in mesh.hull.dropFirst() { hull.addLine(to: FaceMesh.aspectFill(p, image: imageSize, in: size)) }
                hull.closeSubpath()
            }
            var passed = ctx
            passed.clip(to: Path(CGRect(x: 0, y: 0, width: size.width, height: netY)))
            passed.fill(hull, with: .color(Self.fill.opacity(0.25)))

            // points pop in as the line passes them; lines draw once both ends are in
            for (i, p) in pts.enumerated() where p.y <= netY + 0.5 { clock.mark(i, at: now) }
            for e in mesh.edges {
                guard let ta = clock.time(e.a), let tb = clock.time(e.b) else { continue }
                let (from, to) = ta <= tb ? (pts[e.a], pts[e.b]) : (pts[e.b], pts[e.a])
                let t = reduceMotion ? 1 : min(1, max(0, now.timeIntervalSince(max(ta, tb)) / 0.15))
                let k = 1 - pow(1 - t, 2)   // ease-out
                var line = Path()
                line.move(to: from)
                line.addLine(to: CGPoint(x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k))
                ctx.stroke(line, with: .color(Self.meshBlue), lineWidth: 1)
            }
            for (i, p) in pts.enumerated() {
                guard let t0 = clock.time(i) else { continue }
                let s = reduceMotion ? 1 : Self.spring(now.timeIntervalSince(t0) / 0.25)
                guard s > 0.01 else { continue }
                let r = 2.5 * s
                ctx.fill(Path(ellipseIn: CGRect(x: p.x - r - 1, y: p.y - r - 1, width: 2 * r + 2, height: 2 * r + 2)), with: .color(.white))
                ctx.fill(Path(ellipseIn: CGRect(x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r)), with: .color(Self.accent))
            }
        }
        // the scan line crosses the whole card
        if progress > 0.001 && progress < 0.999 {
            ctx.fill(Path(CGRect(x: 0, y: lineY - 1, width: size.width, height: 2)), with: .color(Self.accent))
        }
    }

    /// 0 → 1 with a small overshoot, ~ a 0.25 s spring (back-out curve) over x = 0…1
    static func spring(_ x: Double) -> Double {
        guard x < 1 else { return 1 }
        guard x > 0 else { return 0 }
        let c1 = 1.70158, c3 = c1 + 1
        return 1 + c3 * pow(x - 1, 3) + c1 * pow(x - 1, 2)
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
