import SwiftUI

/// Launch splash A′ "Corona calm" (Chelsea's pick, motion page r03+ timing table). On #070707 the mark's outline
/// draws in warm white, a faint blue dot circles the orbit once, a corona rises slowly behind the G's round
/// counter (a total eclipse: dark disc, thin warm rim, soft noisy rays) and blooms ×1.2 over 0.8 s while it
/// breathes ±3 %; one light haptic at 1.9 s; the wordmark (the same `logo` asset as A02) rises; then the disc
/// grows into the head of the real A02 photo (sine in-out, 2.5–3.3 s), the corona survives only on the photo's
/// bright backlight, the wordmark fades out where it is and A02 — rendered underneath all along — shows through.
/// A still hold 1.9–2.5 s, hand-off 2.5–3.3 s: 3.3 s from its first frame to A02; a tap (before 2.5 s) jumps to the end state and hands over in 0.38 s. Tilt (iPhone) / pointer (Mac) brightens
/// the rim on that side. Reduce Motion: a still lit frame (0.3 s in, hold, 0.4 s crossfade from 1.1 s: 1.5 s).
/// Signed-in relaunch (a saved session): the still lit frame for 0.9 s. Warm resume: no splash (shown once per launch).
/// UI tests skip it unless `--splash-demo`. No Metal: layered gradients + noisy angular rays (see `CoronaView`).
public struct GenitaSplash: View {
    /// `full` = A′ (first launch, signed out); `short` = a signed-in relaunch: the still lit mark for 0.9 s.
    public enum Mode: Sendable { case full, short }
    var mode: Mode = .full
    var onStart: (Date) -> Void = { _ in }
    var onFinished: () -> Void

    @State private var start: Date?
    /// iPhone: when the scene stopped being active (a system alert over the launch, e.g. the iPhone Mirroring
    /// "microphone unavailable" sheet in QA build 7); the clock holds until it's active again, so the splash is
    /// seen rather than spent under the alert. nil = running.
    @State private var pausedAt: Date?
    @Environment(\.scenePhase) private var scenePhase
    @State private var skipAt: Double?
    @State private var finished = false
    @State private var lean = CGSize.zero
    @State private var leanSource = GenitaLeanSource()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let timeline = Self.makeTimeline()

    /// The clock starts when the splash is first on screen (the run-loop turn after it appears), not at launch:
    /// on a phone the first frame comes late, and a launch-anchored clock skipped most of A′ (Chelsea 11/3: "too
    /// fast"). Nothing else holds it: it ends on its own timeline (full 3.3 s, short 0.9 s, Reduce Motion 1.5 s).
    public init(mode: Mode = .full, onStart: @escaping (Date) -> Void = { _ in }, onFinished: @escaping () -> Void) {
        self.mode = mode
        self.onStart = onStart
        self.onFinished = onFinished
    }

    /// Still-frame timing (Reduce Motion, short): the lit mark fades in (ease-out), holds, the scene crossfades
    /// (smoothstep) to the first screen. 춘식이 11/4 spec: a readable 600–800 ms hold.
    struct Still: Equatable { var fadeIn: Double; var outAt: Double; var out: Double; var end: Double { outAt + out } }
    /// Reduce Motion: 0.3 s in, hold to 1.1 s, 0.4 s crossfade → 1.5 s
    static let calmStill = Still(fadeIn: 0.3, outAt: 1.1, out: 0.4)
    /// signed-in relaunch: 0.2 s in, hold 0.35 s, 0.35 s crossfade → 0.9 s
    static let shortStill = Still(fadeIn: 0.2, outAt: 0.55, out: 0.35)
    /// How long the splash stays up from its first frame, untouched (no tap).
    static func onScreen(mode: Mode, reduceMotion: Bool) -> Double {
        if mode == .short { return shortStill.end }
        if reduceMotion { return calmStill.end }
        return handoffAt + handoff
    }
    private var still: Still? { mode == .short ? Self.shortStill : reduceMotion ? Self.calmStill : nil }

    // MARK: timing (motion page A′ table; 춘식이 11/4: wordmark 1.3–1.9 s, a still hold 1.9–2.5 s, hand-off 2.5–3.3 s)
    static let handoffAt = 2.5
    static let handoff = 0.80     // → A02 at 3.30 s from the first frame; a timer also ends it there
    static let skipHandoff = 0.38
    static let hapticAt = 1.9

    struct Frame {
        var outline = 0.0  // 0–0.90 warm outline
        var orbit = 0.0    // 0.15–1.45 dot around the orbit
        var body = 0.0     // 0.80–1.25 mark body + rim
        var amp = 0.0      // 0.50–1.50 corona rise
        var bloom = 1.0    // 1.10–1.90 ×1 → ×1.2
        var word = 0.0     // 1.30–1.90 wordmark
        var disc = 0.0     // 0.50–1.10 the white disc brightens
        var halo = 0.45    // 1.10–1.90 warm edge halo .45 → .9
        static let finished = Frame(outline: 1, orbit: 1, body: 1, amp: 1, bloom: 1.2, word: 1, disc: 1, halo: 0.9)
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
            KeyframeTrack(\.disc) {
                LinearKeyframe(0, duration: 0.5)
                CubicKeyframe(1, duration: 0.6)
            }
            KeyframeTrack(\.halo) {
                LinearKeyframe(0.45, duration: 1.1)
                CubicKeyframe(0.9, duration: 0.8)
            }
            KeyframeTrack(\.word) {
                LinearKeyframe(0, duration: 1.3)
                // ease-out (timingCurve 0.16, 1, 0.3, 1), 1.3–1.9 s
                LinearKeyframe(1, duration: 0.6, timingCurve: .bezier(startControlPoint: UnitPoint(x: 0.16, y: 1), endControlPoint: UnitPoint(x: 0.3, y: 1)))
            }
        }
    }

    public var body: some View {
        GeometryReader { safe in
            let top = safe.safeAreaInsets.top - 44 // same origin as A02 (390 × 844 board)
            GeometryReader { full in
                TimelineView(.animation(minimumInterval: Self.frameInterval, paused: start == nil || pausedAt != nil || Self.frozenAt != nil || finished)) { ctx in
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
        .onAppear {
            // the next run-loop turn ≈ the first frame on screen
            DispatchQueue.main.async {
                if start == nil { let now = Date(); start = now; onStart(now); if Self.holds(scenePhase) { pausedAt = now } }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            guard start != nil, !finished else { return }
            if Self.holds(phase) { if pausedAt == nil { pausedAt = Date() } }
            else if let since = pausedAt { start = start?.addingTimeInterval(Date().timeIntervalSince(since)); pausedAt = nil }
        }
        .task { await run() }
        .onDisappear { leanSource.stop() }
    }

    // MARK: drawing

    private var endTime: Double {
        if let still { return still.end }
        return (skipAt ?? Self.handoffAt) + (skipAt == nil ? Self.handoff : Self.skipHandoff)
    }

    @ViewBuilder private func scene(t: Double, size: CGSize, top: CGFloat) -> some View {
        let calm = still != nil
        let st = still ?? Self.calmStill
        let hStart = skipAt ?? Self.handoffAt
        let hDur = skipAt == nil ? Self.handoff : Self.skipHandoff
        // hand-off progress on a sine in-out (timingCurve 0.37, 0, 0.63, 1)
        let h = calm ? 0 : Self.sineInOut(clamp((t - hStart) / hDur))
        let f: Frame = calm || skipAt != nil ? .finished : timeline.value(time: min(t, Self.handoffAt))
        let dx = (size.width - 390) / 2
        let shift = (size.height - 844) / 2 // A01 centres its mark vertically (ReferenceWelcomeView)
        // the mark exactly where A01 draws it: centre (193.34, 368.89), −14.05°; its round counter = the disc
        let markC = CGPoint(x: 193.3445 + dx, y: 368.8885 + shift)
        let a = -14.05 * Double.pi / 180
        let counter = CGPoint(x: markC.x + 12.5 * cos(a), y: markC.y + 12.5 * sin(a))
        // white disc: the counter (r 31.8) → behind the A02 head (195, 330, r 260)
        let disc = CGPoint(x: lerp(counter.x, 195 + dx, h), y: lerp(counter.y, 330 + top, h))
        let r = lerp(31.8, 260, h)
        let breathe = calm ? 1 : 1 + 0.03 * sin(t / 3.2 * 2 * .pi)
        let amp = f.amp * f.bloom * breathe * (1 - h)
        // still (Reduce Motion / short): the dark ground is there from the first frame, the lit mark fades in,
        // then the whole scene crossfades to the first screen
        let calmAlpha = 1 - Self.smooth(clamp((t - st.outAt) / st.out))
        // last part of the hand-off: the overlay thins out so A02's copy and buttons come through
        let sceneAlpha = calm ? calmAlpha : 1 - Self.smooth(clamp((t - hStart - hDur * 0.45) / (hDur * 0.55)))
        // the mark fades over the first ~280 ms of the hand-off while the disc grows (was h / 0.15: read as a jump)
        let markAlpha = calm ? Self.easeOut(clamp(t / st.fadeIn)) : 1 - clamp(h / 0.35)
        // wordmark: out in place during the first 30 % of the hand-off (2.50–2.74 s); A02 logo in at its spot 2.86–3.26 s.
        // Reduce Motion: in with the mark, out over 0.18 s when the crossfade starts, A02's logo in 0.18 s later.
        // Short (signed in: the call is underneath, not A02): no A02 logo, the wordmark leaves with the scene.
        let wordAlpha = calm ? Self.easeOut(clamp(t / st.fadeIn)) * (mode == .short ? 1 : 1 - clamp((t - st.outAt) / 0.18))
                             : f.word * (1 - clamp((t - hStart) / (hDur * 0.3)))
        let logoAlpha = mode == .short ? 0 : calm ? clamp((t - st.outAt - 0.18) / 0.2) : clamp((t - hStart - hDur * 0.45) / (hDur * 0.5))

        ZStack(alignment: .topLeading) {
            Color(red: 7 / 255, green: 7 / 255, blue: 7 / 255)
            // corona: only behind the disc
            CoronaView(center: disc, radius: r, amp: amp, lean: lean, time: t, size: size)
            // warm blurred halo at the disc edge (.45 → .9 over 1.1–1.9 s)
            Circle().fill(GenitaCorona.edge)
                .frame(width: r * 2 + 8, height: r * 2 + 8)
                .blur(radius: 6 + 10 * h)
                .position(disc)
                .opacity(f.halo * f.disc * (1 - 0.6 * h))
            // the white disc (flat white, faint warm edge), brightening 0.5–1.1 s
            Circle()
                .fill(RadialGradient(stops: [
                    .init(color: .white, location: 0),
                    .init(color: .white, location: 0.8),
                    .init(color: GenitaCorona.edge, location: 1),
                ], center: .center, startRadius: 0, endRadius: r))
                .frame(width: r * 2, height: r * 2)
                .position(disc)
                .opacity(f.disc)
            // the real A02 photo: dark areas first (the head stands in front of the disc), bright areas last
            PhotoReveal(reveal: h, size: size, top: top)
            // the mark: a clean vector layer above everything, A01's colours
            mark(f)
                .frame(width: BrandMarkShape.size.width, height: BrandMarkShape.size.height)
                .rotationEffect(.degrees(-14.05))
                .rotation3DEffect(.degrees(Double(lean.width) * 6), axis: (x: 0, y: 1, z: 0), perspective: 0.6)
                .position(markC)
                .opacity(markAlpha)
            wordmark(f: f, alpha: wordAlpha, x: 195 + dx, y: 456 + shift)
        }
        .frame(width: size.width, height: size.height)
        .compositingGroup() // fade the scene as one picture (else each layer fades and the disc shows through the head)
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

    /// The brandmark as on A01 (#111 fill), with a warm-white rim (the same path stroked 1.6 pt under the body, so
    /// 0.8 pt shows), the warm outline drawing in first, and the faint orbit dot. No noise or blur on it.
    @ViewBuilder private func mark(_ f: Frame) -> some View {
        let toward = UnitPoint(x: BrandMarkShape.pupil.x / BrandMarkShape.size.width + lean.width * 0.05,
                               y: BrandMarkShape.pupil.y / BrandMarkShape.size.height + lean.height * 0.05)
        ZStack {
            BrandMarkShape()
                .stroke(RadialGradient(colors: [GenitaCorona.rim, GenitaCorona.rim.opacity(0.55), GenitaCorona.warm.opacity(0.25)],
                                       center: toward, startRadius: 0, endRadius: 110), lineWidth: 1.6)
                .opacity(f.body)
            BrandMarkShape().fill(GenitaCorona.ink).opacity(f.body)
            BrandMarkShape().trim(from: 0, to: f.outline)
                .stroke(GenitaCorona.warm, style: StrokeStyle(lineWidth: 0.7, lineCap: .round, lineJoin: .round))
                .opacity(1 - f.body)
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
                .position(x: x, y: y + 6 * (1 - f.word))
                .opacity(alpha)
        }
    }

    // MARK: control

    @MainActor private func run() async {
        if Self.frozenAt != nil { return } // review shot: hold the frame until tapped
        while start == nil { try? await Task.sleep(for: .milliseconds(10)) } // the clock starts at the first frame
        if still == nil {
            leanSource.start { l in withAnimation(.interactiveSpring(response: 0.35, dampingFraction: 0.85)) { lean = l } }
        }
        // hard deadline on the splash's own clock: late frames on a busy device must not hold the first screen back,
        // and time under a system alert (scene not active) doesn't count
        var hapticDone = false
        while !finished, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(30))
            guard let start, pausedAt == nil else { continue }
            let elapsed = Date().timeIntervalSince(start)
            if !hapticDone, elapsed >= (still?.fadeIn ?? Self.hapticAt) {
                hapticDone = true
                // one light haptic as the bloom settles (none on a signed-in relaunch)
                if skipAt == nil, mode == .full { GenitaHaptic.impact(soft: false, intensity: 1) }
            }
            // endTime already follows a tap (skipAt + 0.38 s), so a skip also ends on the held clock (Codex P2)
            if elapsed >= endTime { finish() }
        }
    }

    /// iPhone only: a scene that isn't active holds the splash clock (macOS reports inactive for a window that's
    /// simply not key, which must not stop the Mac splash).
    static func holds(_ phase: ScenePhase) -> Bool {
        #if os(iOS)
        return phase != .active
        #else
        return false
        #endif
    }

    @MainActor private func skip() {
        guard !finished, skipAt == nil, let start, still == nil else { if still != nil { finish() }; return }
        let now = Self.frozenAt ?? Date().timeIntervalSince(start)
        guard now < Self.handoffAt else { return } // already handing over
        skipAt = now
        if let frozen = Self.frozenAt {
            // review stills: run() never started its loop, so the tap ends it on a timer
            self.start = Date().addingTimeInterval(-frozen); Self.unfreeze = true
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.skipHandoff + 0.05) { finish() }
        }
    }

    @MainActor private func finish() {
        guard !finished else { return }
        finished = true
        leanSource.stop()
        onFinished()
    }

    private func follow(_ point: CGPoint?, in size: CGSize) {
        guard still == nil, !finished else { return }
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
    /// Full frame rate on devices; the CI simulator renders in software, so it draws at 20 fps there to keep
    /// the main thread (and the hand-off deadline) on time.
    static var frameInterval: Double? {
        #if targetEnvironment(simulator)
        1.0 / 20
        #else
        nil
        #endif
    }
    static func smooth(_ x: Double) -> Double { x * x * (3 - 2 * x) }
    static func easeOut(_ x: Double) -> Double { 1 - (1 - x) * (1 - x) }

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

    /// Signed in (a saved session in the keychain) → short. DEBUG `GENITA_SPLASH_MODE=short|full` for UI tests.
    static func launchMode() -> Mode {
        #if DEBUG
        if let m = ProcessInfo.processInfo.environment["GENITA_SPLASH_MODE"] { return m == "short" ? .short : .full }
        #endif
        return KeychainTokenStore().load() != nil ? .short : .full
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
    static let ink = Color(red: 17 / 255, green: 17 / 255, blue: 17 / 255)          // #111111 the A01 brandmark
    static let edge = Color(red: 250 / 255, green: 238 / 255, blue: 221 / 255)      // #FAEEDD disc edge / halo
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

/// The photo comes in dark areas first (the head and shoulders stand in front of the white disc), bright areas
/// last: alpha ≈ smoothstep(thr, thr + 0.4, 1 − luminance), thr = 1 − 1.4·reveal; the whole photo from reveal 0.45,
/// so the disc light ends as the photo's own backlight.
struct PhotoReveal: View {
    var reveal: Double
    var size: CGSize
    var top: CGFloat
    var body: some View {
        if reveal > 0 {
            // 1 − L ≥ thr ⇔ L ≤ 1 − thr: dark-first mask = white minus the bright-first mask at threshold (0.6 − thr)
            let thr = 0.6 - (1 - 2.8 * reveal) // the head is in front within the first ~20 % (page frame 2.08 s)
            let full = max(0, min(1, (reveal - 0.45) / 0.55))
            A02Photo(size: size, top: top) { photo in
                ZStack {
                    photo.resizable().mask {
                        ZStack {
                            Color.white
                            photo.resizable().brightness(0.3 - thr).contrast(2.5).luminanceToAlpha().blendMode(.destinationOut)
                        }
                        .compositingGroup()
                    }
                    photo.resizable().opacity(full * full * (3 - 2 * full))
                }
            }
        }
    }
}

/// The calm corona behind the disc, without a shader: a faint cool halo, a tight white glow just outside the
/// edge, and two layers of soft noisy rays (angular gradients of smoothed noise, blurred, drifting slowly and
/// crossfading on the 3.2 s breath). Nothing of it is drawn on the mark.
struct CoronaView: View {
    var center: CGPoint
    var radius: CGFloat
    var amp: Double
    var lean: CGSize
    var time: Double
    var size: CGSize

    var body: some View {
        let r = radius
        let k1 = 10 * sqrt(r / 31.5) + r * 0.22        // tight glow falloff (pt)
        let k2 = r * 1.7 + 46                          // wide halo falloff (pt)
        let outer = r + k2
        let light = CGSize(width: lean.width * 2.5, height: lean.height * 2.5)
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
            }
            .frame(width: outer * 2, height: outer * 2)
            .position(center)
            .opacity(amp)
            .blendMode(.plusLighter)
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
    /// decided once at launch: a saved session = a relaunch into the conversation → the short splash
    @State private var mode = GenitaSplash.launchMode()
    @State private var shownAt = Date()
    @State private var elapsedMs: Int?
    /// when the splash was first on screen (the run loop turn after it appeared) and how long it stayed there
    @State private var firstFrameAt: Date?
    @State private var visibleMs: Int?
    func body(content: Content) -> some View {
        #if DEBUG
        let _ = Self.simulateLateFirstFrameOnce()
        #endif
        content.overlay {
            if enabled && visible {
                GenitaSplash(mode: mode) {
                    elapsedMs = Int(Date().timeIntervalSince(shownAt) * 1000)
                    visibleMs = firstFrameAt.map { Int(Date().timeIntervalSince($0) * 1000) }
                    visible = false
                }
                .onAppear { DispatchQueue.main.async { if firstFrameAt == nil { firstFrameAt = Date() } } }
            }
        }
        #if DEBUG
        // UI tests read how long the splash held the first screen back since launch, and how long it was on screen
        .overlay(alignment: .topLeading) {
            VStack {
                if let elapsedMs {
                    Text(String(elapsedMs)).font(.system(size: 2)).opacity(0.02).allowsHitTesting(false).accessibilityIdentifier("splashElapsedMs")
                }
                if let visibleMs {
                    Text(String(visibleMs)).font(.system(size: 2)).opacity(0.02).allowsHitTesting(false).accessibilityIdentifier("splashVisibleMs")
                }
            }
        }
        #endif
    }

    #if DEBUG
    nonisolated(unsafe) private static var lateFirstFrameDone = false
    /// UI test `GENITA_SPLASH_LATE_FIRST_FRAME=<s>`: block the main thread once before the first frame, like a heavy
    /// cold launch on a device (fonts, design JSON, keychain, AppState).
    private static func simulateLateFirstFrameOnce() {
        guard !lateFirstFrameDone, let s = ProcessInfo.processInfo.environment["GENITA_SPLASH_LATE_FIRST_FRAME"].flatMap(Double.init) else { return }
        lateFirstFrameDone = true
        Thread.sleep(forTimeInterval: s)
    }
    #endif
}

public extension View {
    /// Launch splash over this (root) view, once per launch / window. The view underneath renders at once,
    /// so the hand-off reveals a ready first screen.
    func genitaSplash(_ enabled: Bool = true) -> some View { modifier(SplashOverlayModifier(enabled: enabled)) }
}
