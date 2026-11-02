import SwiftUI

/// Launch splash A′ "Corona calm" (Chelsea's pick, motion page r03+ timing table). On #070707 the mark's outline
/// draws in warm white, a faint blue dot circles the orbit once, a corona rises slowly behind the G's round
/// counter (a total eclipse: dark disc, thin warm rim, soft noisy rays) and blooms ×1.2 over 0.8 s while it
/// breathes ±3 %; one light haptic at 1.9 s; the wordmark (the same `logo` asset as A02) rises; then the disc
/// grows into the head of the real A02 photo (sine in-out, 1.9–2.7 s), the corona survives only on the photo's
/// bright backlight, the wordmark fades out where it is and A02 — rendered underneath all along — shows through.
/// 2.7 s to A02; a tap jumps to the end state and hands over in 0.38 s. Tilt (iPhone) / pointer (Mac) brightens
/// the rim on that side. Reduce Motion: a still lit frame (0.2 s fade in), crossfade to A02 at 0.7 s (0.4 s).
/// UI tests skip it unless `--splash-demo`. No Metal: layered gradients + noisy angular rays (see `CoronaView`).
public struct GenitaSplash: View {
    var onFinished: () -> Void

    @State private var start: Date?
    @State private var skipAt: Double?
    @State private var finished = false
    @State private var lean = CGSize.zero
    @State private var leanSource = GenitaLeanSource()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let timeline = Self.makeTimeline()

    /// `origin` = when the splash was put up (the overlay's creation ≈ launch): the budget runs from there, so a
    /// late first frame skips ahead instead of holding A02 back.
    public init(origin: Date = Date(), onFinished: @escaping () -> Void) {
        self.onFinished = onFinished
        _start = State(initialValue: origin)
    }

    // MARK: timing (motion page A′ table)
    static let handoffAt = 1.9
    static let handoff = 0.78     // → A02 at 2.68 s (a timer also ends it there)
    static let skipHandoff = 0.38
    static let hapticAt = 1.9

    struct Frame {
        var outline = 0.0  // 0–0.90 warm outline
        var orbit = 0.0    // 0.15–1.45 dot around the orbit
        var body = 0.0     // 0.80–1.25 mark body + rim
        var amp = 0.0      // 0.50–1.50 corona rise
        var bloom = 1.0    // 1.10–1.90 ×1 → ×1.2
        var word = 0.0     // 1.20–1.70 wordmark
        static let finished = Frame(outline: 1, orbit: 1, body: 1, amp: 1, bloom: 1.2, word: 1)
    }

    private static func makeTimeline() -> KeyframeTimeline<Frame> {
        KeyframeTimeline(initialValue: Frame()) {
            KeyframeTrack(\.outline) { CubicKeyframe(1, duration: 0.9) }
            KeyframeTrack(\.orbit) {
                LinearKeyframe(0, duration: 0.15)
                CubicKeyframe(1, duration: 1.3)
            }
            KeyframeTrack(\.body) {
                LinearKeyframe(0, duration: 0.8)
                CubicKeyframe(1, duration: 0.45)
            }
            KeyframeTrack(\.amp) {
                LinearKeyframe(0, duration: 0.5)
                CubicKeyframe(1, duration: 1.0)
            }
            KeyframeTrack(\.bloom) {
                LinearKeyframe(1, duration: 1.1)
                CubicKeyframe(1.2, duration: 0.8)
            }
            KeyframeTrack(\.word) {
                LinearKeyframe(0, duration: 1.2)
                CubicKeyframe(1, duration: 0.5)
            }
        }
    }

    public var body: some View {
        GeometryReader { safe in
            let top = safe.safeAreaInsets.top - 44 // same origin as A02 (390 × 844 board)
            GeometryReader { full in
                TimelineView(.animation(paused: start == nil || Self.frozenAt != nil || finished)) { ctx in
                    let t = Self.frozenAt ?? start.map { ctx.date.timeIntervalSince($0) } ?? 0
                    scene(t: t, size: full.size, top: top)
                        .onChange(of: t >= endTime, initial: true) { _, done in if done { finish() } }
                }
                .contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 0)
                    .onChanged { v in follow(v.location, in: full.size) }
                    .onEnded { v in if hypot(v.translation.width, v.translation.height) < 12 { skip() } else { follow(nil, in: full.size) } })
                #if os(macOS)
                .onContinuousHover { phase in
                    if case let .active(p) = phase { follow(p, in: full.size) } else { follow(nil, in: full.size) }
                }
                #endif
            }
            .ignoresSafeArea()
        }
        .accessibilityElement()
        .accessibilityLabel("Genita")
        .accessibilityHint("Tap to start")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { skip() }
        .accessibilityIdentifier("splash")
        .task { await run() }
        .onDisappear { leanSource.stop() }
    }

    // MARK: drawing

    private var endTime: Double {
        if reduceMotion { return 1.1 }
        return (skipAt ?? Self.handoffAt) + (skipAt == nil ? Self.handoff : Self.skipHandoff)
    }

    @ViewBuilder private func scene(t: Double, size: CGSize, top: CGFloat) -> some View {
        let calm = reduceMotion
        let hStart = skipAt ?? Self.handoffAt
        let hDur = skipAt == nil ? Self.handoff : Self.skipHandoff
        // hand-off progress on a sine in-out (timingCurve 0.37, 0, 0.63, 1)
        let h = calm ? 0 : Self.sineInOut(clamp((t - hStart) / hDur))
        let f: Frame = calm || skipAt != nil ? .finished : timeline.value(time: min(t, Self.handoffAt))
        let dx = (size.width - 390) / 2
        // disc: the G's round counter (205, 366, r 31.5) → the head of the A02 photo (195, 285, r 200)
        let disc = CGPoint(x: lerp(205, 195, h) + dx, y: lerp(366, 285, h) + top)
        let r = lerp(31.5, 200, h)
        let breathe = calm ? 1 : 1 + 0.03 * sin(t / 3.2 * 2 * .pi)
        let amp = f.amp * f.bloom * breathe
        // Reduce Motion: fade in 0.2 s, crossfade to A02 at 0.7 s over 0.4 s
        let calmAlpha = calm ? clamp(t / 0.2) * (1 - clamp((t - 0.7) / 0.4)) : 1
        // last part of the hand-off: the overlay thins out so A02's copy and buttons come through
        let sceneAlpha = calm ? calmAlpha : 1 - Self.smooth(clamp((t - hStart - hDur * 0.3) / (hDur * 0.7)))
        let markAlpha = 1 - clamp(h / 0.35)
        let markOrigin = CGPoint(x: disc.x - BrandMarkShape.pupil.x, y: disc.y - BrandMarkShape.pupil.y)
        // wordmark: out in place during the first 30 % of the hand-off (1.90–2.14 s); A02 logo in at its spot 2.26–2.66 s.
        // Reduce Motion: out over 0.18 s when the crossfade starts (0.7 s), logo in 0.2 s later over 0.2 s.
        let wordAlpha = calm ? 1 - clamp((t - 0.7) / 0.18) : f.word * (1 - clamp((t - hStart) / (hDur * 0.3)))
        let logoAlpha = calm ? clamp((t - 0.88) / 0.2) : clamp((t - hStart - hDur * 0.45) / (hDur * 0.5))

        ZStack(alignment: .topLeading) {
            Color(red: 7 / 255, green: 7 / 255, blue: 7 / 255)
            // the real A02 photo comes up through the corona, bright areas first
            PhotoReveal(reveal: h, size: size, top: top)
            CoronaView(center: disc, radius: r, amp: amp, lean: lean, time: t, reveal: h, size: size, top: top)
            mark(f, t: t)
                .frame(width: BrandMarkShape.size.width, height: BrandMarkShape.size.height)
                .rotation3DEffect(.degrees(Double(lean.width) * 6), axis: (x: 0, y: 1, z: 0), perspective: 0.6)
                .offset(x: markOrigin.x, y: markOrigin.y)
                .opacity(markAlpha)
            wordmark(f: f, alpha: wordAlpha, x: 195 + dx, y: 456 + top)
        }
        .frame(width: size.width, height: size.height)
        .opacity(sceneAlpha)
        .overlay(alignment: .topLeading) {
            // A02's own logo spot (35, 67.5), same asset at 63.142 pt: fades in there, nothing flies across the title
            if let logo = genitaBundleImage("logo") {
                logo.resizable()
                    .frame(width: 63.142, height: 22.626)
                    .offset(x: 35, y: 67.5 + top) // A02 places its logo at a fixed x (no centring offset)
                    .opacity(logoAlpha)
            }
        }
    }

    @ViewBuilder private func mark(_ f: Frame, t: Double) -> some View {
        let away = CGSize(width: -lean.width * 0.6, height: 0.5 - lean.height * 0.4)
        ZStack {
            BrandMarkShape().fill(GenitaCorona.body).opacity(f.body)
            // thin warm rim: the mark minus itself pushed away from the light
            ZStack {
                BrandMarkShape().fill(GenitaCorona.rim)
                BrandMarkShape().fill(.black).offset(away).blendMode(.destinationOut)
            }
            .compositingGroup()
            .opacity(f.body * 0.9)
            BrandMarkShape().trim(from: 0, to: f.outline)
                .stroke(GenitaCorona.warm, style: StrokeStyle(lineWidth: 0.7, lineCap: .round, lineJoin: .round))
                .opacity(1 - f.body * 0.8)
            if f.orbit > 0, f.orbit < 1 {
                Ellipse().trim(from: max(0, f.orbit - 0.08), to: f.orbit)
                    .stroke(GenitaCorona.accent.opacity(0.5), style: StrokeStyle(lineWidth: 1.7, lineCap: .round))
                    .frame(width: BrandMarkShape.size.width * 1.18, height: BrandMarkShape.size.height * 0.62)
                    .opacity(sin(f.orbit * .pi))
            }
        }
    }

    /// The same `logo` image as A02, 96 pt wide; fades out where it is (0.24 s) when the hand-off starts.
    @ViewBuilder private func wordmark(f: Frame, alpha: Double, x: CGFloat, y: CGFloat) -> some View {
        if let logo = genitaBundleImage("logo") {
            logo.resizable()
                .frame(width: 96, height: 96 * 22.626 / 63.142)
                .position(x: x, y: y + 8 * (1 - f.word))
                .opacity(alpha)
        }
    }

    // MARK: control

    @MainActor private func run() async {
        if Self.frozenAt != nil { return } // review shot: hold the frame until tapped
        if !reduceMotion {
            leanSource.start { l in withAnimation(.interactiveSpring(response: 0.35, dampingFraction: 0.85)) { lean = l } }
        }
        let elapsed = start.map { Date().timeIntervalSince($0) } ?? 0
        let wait = (reduceMotion ? 0.2 : Self.hapticAt) - elapsed
        if wait > 0 { try? await Task.sleep(for: .milliseconds(Int(wait * 1000))) }
        if skipAt == nil { GenitaHaptic.impact(soft: false, intensity: 1) } // one light haptic as the bloom settles
        // hard deadline: late frames on a busy device / simulator must not hold A02 back
        let left = endTime - (start.map { Date().timeIntervalSince($0) } ?? 0)
        if left > 0 { try? await Task.sleep(for: .milliseconds(Int(left * 1000))) }
        if skipAt == nil { finish() }
    }

    @MainActor private func skip() {
        guard !finished, skipAt == nil, let start, !reduceMotion else { if reduceMotion { finish() }; return }
        let now = Self.frozenAt ?? Date().timeIntervalSince(start)
        guard now < Self.handoffAt else { return } // already handing over
        skipAt = now
        if let frozen = Self.frozenAt { self.start = Date().addingTimeInterval(-frozen); Self.unfreeze = true }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.skipHandoff + 0.05) { finish() }
    }

    @MainActor private func finish() {
        guard !finished else { return }
        finished = true
        leanSource.stop()
        onFinished()
    }

    private func follow(_ point: CGPoint?, in size: CGSize) {
        guard !reduceMotion, !finished else { return }
        let target: CGSize = point.map {
            CGSize(width: max(-1, min(1, ($0.x - size.width / 2) / (size.width / 2))),
                   height: max(-1, min(1, ($0.y - size.height / 2) / (size.height / 2))))
        } ?? .zero
        withAnimation(.interactiveSpring(response: 0.3, dampingFraction: 0.8)) { lean = target }
    }

    // MARK: helpers

    private func clamp(_ x: Double) -> Double { max(0, min(1, x)) }
    private func lerp(_ a: CGFloat, _ b: CGFloat, _ p: Double) -> CGFloat { a + (b - a) * CGFloat(p) }
    static func sineInOut(_ x: Double) -> Double { -(cos(.pi * x) - 1) / 2 }
    static func smooth(_ x: Double) -> Double { x * x * (3 - 2 * x) }

    nonisolated(unsafe) static var unfreeze = false

    /// DEBUG review shots: `GENITA_SPLASH_AT=1.9` renders that instant, still, and never auto-wakes (a tap still does).
    static var frozenAt: Double? {
        #if DEBUG
        if unfreeze { return nil }
        return ProcessInfo.processInfo.environment["GENITA_SPLASH_AT"].flatMap(Double.init)
        #else
        return nil
        #endif
    }

    /// Show at launch? Not in UI tests / review screenshots (unless `--splash-demo`), not for the handoff demo.
    public static var shouldShowAtLaunch: Bool {
        let p = ProcessInfo.processInfo
        if p.arguments.contains("--splash-demo") { return true }
        if p.arguments.contains("--uitesting") || p.arguments.contains("--handoff-demo") { return false }
        #if DEBUG
        if p.environment["GENITA_REVIEW_STAGE"] != nil || p.environment["GENITA_REVIEW_STILL"] == "1" { return false }
        #endif
        return true
    }
}

/// Colours (motion page A′). Change here only.
enum GenitaCorona {
    static let body = Color(red: 5 / 255, green: 5 / 255, blue: 6 / 255)            // #050506 disc + mark body
    static let warm = Color(red: 243 / 255, green: 234 / 255, blue: 223 / 255)      // #F3EADF outline
    static let rim = Color(red: 1, green: 242 / 255, blue: 226 / 255)               // #FFF2E2 rim
    static let cool = Color(red: 0.62, green: 0.74, blue: 0.9)                      // outer corona (calm)
    static let accent = Color(red: 0, green: 162 / 255, blue: 1)                    // #00A2FF orbit dot
}

/// The A02 sign-in photo exactly where A02 draws it (757 × 1009 at −172, −168 on the 390 × 844 board), laid out
/// in a full-screen box so it never shifts the scene.
struct A02Photo<Content: View>: View {
    var size: CGSize
    var top: CGFloat
    @ViewBuilder var content: (Image) -> Content
    var body: some View {
        Color.clear
            .frame(width: size.width, height: size.height)
            .overlay(alignment: .topLeading) {
                if let photo = genitaBundleImage("signin") {
                    content(photo)
                        .frame(width: 757, height: 1009)
                        .offset(x: -172 + (size.width - 390) / 2, y: -168 + top)
                }
            }
            .clipped()
            .allowsHitTesting(false)
    }
}

/// The photo shows where it is bright first: alpha ≈ smoothstep(thr, thr + 0.4, luminance), thr = 1 − 1.4·reveal;
/// the whole photo from reveal 0.45 on.
struct PhotoReveal: View {
    var reveal: Double
    var size: CGSize
    var top: CGFloat
    var body: some View {
        if reveal > 0 {
            let thr = 1 - 1.4 * reveal
            let full = max(0, min(1, (reveal - 0.45) / 0.55))
            A02Photo(size: size, top: top) { photo in
                ZStack {
                    photo.resizable().mask(photo.resizable().brightness(0.3 - thr).contrast(2.5).luminanceToAlpha())
                    photo.resizable().opacity(full * full * (3 - 2 * full))
                }
            }
        }
    }
}

/// The photo's bright areas as a mask (≈ smoothstep(0.06, 0.5, luminance)).
struct BrightAreas: View {
    var size: CGSize
    var top: CGFloat
    var body: some View {
        A02Photo(size: size, top: top) { photo in
            photo.resizable().brightness(0.22).contrast(2.27).luminanceToAlpha()
        }
    }
}

/// The calm corona around a dark disc, without a shader: a faint cool halo, a tight white glow just outside the
/// rim, two layers of soft noisy rays (angular gradients of smoothed noise, blurred, drifting slowly and
/// crossfading on the 3.2 s breath), a warm rim, and the dark disc. From the hand-off on it is masked to the A02
/// photo's bright areas, so it becomes the photo's backlight.
struct CoronaView: View {
    var center: CGPoint
    var radius: CGFloat
    var amp: Double
    var lean: CGSize
    var time: Double
    var reveal: Double
    var size: CGSize
    var top: CGFloat

    var body: some View {
        let r = radius
        let k1 = 10 * sqrt(r / 31.5) + r * 0.22        // tight glow falloff (pt)
        let k2 = r * 1.7 + 46                          // wide halo falloff (pt)
        let outer = r + k2
        let light = CGSize(width: lean.width * 2.5, height: lean.height * 2.5)
        // as the shader: corona → bright areas only by smoothstep(0, 0.4, reveal); disc fades by smoothstep(0.08, 0.45)
        let s = GenitaSplash.smooth(max(0, min(1, reveal / 0.25)))
        let discDark = 1 - GenitaSplash.smooth(max(0, min(1, (reveal - 0.04) / 0.26)))
        let breath = sin(time / 3.2 * 2 * .pi)
        let glowEnd = min(1, (k1 * 2.6) / (outer - r))
        ZStack(alignment: .topLeading) {
            ZStack {
                // (gradients start at the centre and stay clear inside the disc: a gradient's first stop would
                // otherwise fill the inside once the disc fades during the hand-off)
                RadialGradient(stops: [
                    .init(color: .clear, location: 0),
                    .init(color: .clear, location: ring(0, r, outer) - 0.002),
                    .init(color: GenitaCorona.cool.opacity(0.06), location: ring(0, r, outer)),
                    .init(color: GenitaCorona.cool.opacity(0.03), location: ring(0.5, r, outer)),
                    .init(color: GenitaCorona.cool.opacity(0), location: 1),
                ], center: .center, startRadius: 0, endRadius: outer)
                rays(seed: 1, turn: time / 400, k1: k1, outer: outer).opacity(0.5 + 0.5 * breath)
                rays(seed: 2, turn: -time / 520, k1: k1, outer: outer).opacity(0.5 - 0.5 * breath)
                RadialGradient(stops: [
                    .init(color: .clear, location: 0),
                    .init(color: .clear, location: ring(0, r, outer) - 0.002),
                    .init(color: .white.opacity(0.3), location: ring(0, r, outer)),
                    .init(color: Color(red: 0.86, green: 0.9, blue: 0.97).opacity(0.18), location: ring(glowEnd / 2.6, r, outer)),
                    .init(color: .clear, location: ring(glowEnd, r, outer)),
                ], center: .center, startRadius: 0, endRadius: outer)
                    .offset(light)
                Circle().stroke(GenitaCorona.rim.opacity(0.8), lineWidth: 0.85)
                    .frame(width: r * 2, height: r * 2)
                    .blur(radius: 0.35)
                    .offset(x: light.width * 0.2, y: light.height * 0.2)
            }
            .frame(width: outer * 2, height: outer * 2)
            .position(center)
            .opacity(amp)
            .blendMode(.plusLighter)
            .mask {
                ZStack {
                    Color.white.opacity(1 - s)
                    if s > 0 { BrightAreas(size: size, top: top).opacity(s) }
                }
                .frame(width: size.width, height: size.height)
            }
            Circle().fill(GenitaCorona.body)
                .frame(width: r * 2 + 1, height: r * 2 + 1)
                .blur(radius: 0.6 + 14 * reveal)
                .position(center)
                .opacity(discDark)
        }
        .frame(width: size.width, height: size.height)
        .allowsHitTesting(false)
    }

    /// fraction `x` of the ring between the rim (r) and `outer`, as a location on a centre-out gradient
    private func ring(_ x: CGFloat, _ r: CGFloat, _ outer: CGFloat) -> CGFloat { max(0.003, min(1, (r + x * (outer - r)) / outer)) }

    /// Angular rays: 96 smoothed noise values → brightness stops (pow 1.6, calm contrast 0.6), fading out radially.
    private func rays(seed: Double, turn: Double, k1: CGFloat, outer: CGFloat) -> some View {
        let r = radius
        let inner = max(0, (r - 1) / outer)
        let edge = min(0.97, r / outer + 0.005)
        let mid = min(0.98, (r + k1 * 2) / outer)
        return Circle()
            .fill(AngularGradient(stops: Self.rayStops(seed), center: .center))
            .rotationEffect(.degrees(turn * 360))
            .mask(RadialGradient(stops: [
                .init(color: .clear, location: 0),
                .init(color: .clear, location: inner),
                .init(color: .white, location: edge),
                .init(color: .white.opacity(0.35), location: mid),
                .init(color: .clear, location: 1),
            ], center: .center, startRadius: 0, endRadius: outer))
            .blur(radius: 0.8)
            .opacity(0.45)
    }

    private static var cache: [Double: [Gradient.Stop]] = [:]
    static func rayStops(_ seed: Double) -> [Gradient.Stop] {
        if let c = cache[seed] { return c }
        let n = 96
        let raw = (0..<n).map { i -> Double in abs(sin((Double(i) + seed * 31.7) * 12.9898) * 43758.5453).truncatingRemainder(dividingBy: 1) }
        var smooth = [Double](repeating: 0, count: n)
        for i in 0..<n {
            let prev: Double = raw[(i + n - 1) % n]
            let next: Double = raw[(i + 1) % n]
            smooth[i] = (prev + 2 * raw[i] + next) / 4
        }
        var stops: [Gradient.Stop] = []
        for i in 0...n {
            let v = pow(smooth[i % n], 1.6) * 1.9
            let calm = 0.63 + (v - 0.63) * 0.6
            stops.append(.init(color: Color(red: 0.9, green: 0.94, blue: 1).opacity(max(0, min(1, 0.08 + 0.85 * pow(max(0, calm), 2)))), location: Double(i) / Double(n)))
        }
        cache[seed] = stops
        return stops
    }
}

struct SplashOverlayModifier: ViewModifier {
    var enabled: Bool
    @State private var visible = GenitaSplash.shouldShowAtLaunch
    @State private var shownAt = Date()
    @State private var elapsedMs: Int?
    func body(content: Content) -> some View {
        content.overlay {
            if enabled && visible {
                GenitaSplash(origin: shownAt) {
                    elapsedMs = Int(Date().timeIntervalSince(shownAt) * 1000)
                    visible = false
                }
            }
        }
        #if DEBUG
        // UI test reads how long the splash held A02 back (≤ 2700 ms)
        .overlay(alignment: .topLeading) {
            if let elapsedMs {
                Text(String(elapsedMs)).font(.system(size: 2)).opacity(0.02).allowsHitTesting(false).accessibilityIdentifier("splashElapsedMs")
            }
        }
        #endif
    }
}

public extension View {
    /// Launch splash over this (root) view, once per launch / window. The view underneath renders at once,
    /// so the hand-off reveals a ready first screen.
    func genitaSplash(_ enabled: Bool = true) -> some View { modifier(SplashOverlayModifier(enabled: enabled)) }
}
