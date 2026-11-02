import SwiftUI

/// Launch splash B+ "Orbit Backlight" (Chelsea's pick, motion page `launch`): on #070707 the mark's outline draws
/// itself, a blue dot circles the orbit once, a light rises from behind until the mark is a black silhouette
/// with a lit rim (eclipse), soft haptic at the peak (0.86 s) as the light breathes 1 → 1.12 → 1, the wordmark
/// rises, then the mark steps back and the same light moves behind A02's head — A02 (rendered underneath the
/// whole time) takes over that light. ≤ 1.6 s; a tap jumps to the end and hands over in 0.38 s. Tilt / pointer
/// moves the light (the rim on that side brightens) and leans the mark ±10°. Reduce Motion: the lit mark fades
/// in (0.2 s) and at 0.7 s crossfades to A02 (0.4 s), haptic kept. UI tests skip it unless `--splash-demo`.
public struct GenitaSplash: View {
    var onFinished: () -> Void

    @State private var start: Date?
    @State private var skipAt: Double?
    @State private var finished = false
    @State private var lean = CGSize.zero
    @State private var leanSource = GenitaLeanSource()
    @State private var hapticDone = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let timeline = Self.makeTimeline()

    public init(onFinished: @escaping () -> Void) { self.onFinished = onFinished }

    // MARK: timing (motion page B+ table)
    static let handoffAt = 1.08
    static let handoff = 0.47      // → first screen at 1.55 s (≤ 1.6 s with frame jitter)
    static let skipHandoff = 0.38
    static let peak = 0.86

    struct Frame {
        var outline = 0.0   // 0–0.56 outline trim
        var orbit = 0.0     // 0.08–0.78 dot position on the orbit
        var light = 0.0     // 0.34–0.86 light up from below
        var fill = 0.0      // 0.48–0.86 body fill + rim
        var breathe = 1.0   // 0.86–1.31: 1 → 1.12 → 1
        var word = 0.0      // 0.78–1.08 wordmark
        static let finished = Frame(outline: 1, orbit: 1, light: 1, fill: 1, breathe: 1, word: 1)
    }

    private static func makeTimeline() -> KeyframeTimeline<Frame> {
        KeyframeTimeline(initialValue: Frame()) {
            KeyframeTrack(\.outline) { CubicKeyframe(1, duration: 0.56) }
            KeyframeTrack(\.orbit) {
                LinearKeyframe(0, duration: 0.08)
                LinearKeyframe(1, duration: 0.70)
            }
            KeyframeTrack(\.light) {
                LinearKeyframe(0, duration: 0.34)
                CubicKeyframe(1, duration: 0.52)
            }
            KeyframeTrack(\.fill) {
                LinearKeyframe(0, duration: 0.48)
                CubicKeyframe(1, duration: 0.38)
            }
            KeyframeTrack(\.breathe) {
                LinearKeyframe(1, duration: Self.peak)
                CubicKeyframe(1.12, duration: 0.2)
                CubicKeyframe(1, duration: 0.25)
            }
            KeyframeTrack(\.word) {
                LinearKeyframe(0, duration: 0.78)
                CubicKeyframe(1, duration: 0.30)
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
                        .onChange(of: t >= endTime) { _, done in if done { finish() } }
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
        // hand-off progress on the "move across the screen" curve (0.77, 0, 0.175, 1)
        let h = calm ? 0 : Self.inOut(max(0, min(1, (t - hStart) / hDur)))
        let f: Frame = calm || skipAt != nil ? .finished : timeline.value(time: min(t, Self.handoffAt + 0.3))
        let dx = (size.width - 390) / 2
        let markW: CGFloat = 160
        let markH = markW * BrandMarkShape.size.height / BrandMarkShape.size.width
        let markC = CGPoint(x: size.width / 2, y: 360 + top)
        // light: splash pose (≈ 308 × 198 at 207,360, rising 42 pt) → A02 pose (440 at 200,342)
        let lightC = CGPoint(x: lerp(207 + dx, 200 + dx, h) + lean.width * 22, y: lerp(360 + top + 42 * (1 - f.light), 342 + top, h) + lean.height * 14)
        let lightS = CGSize(width: lerp(0.7, 1, h) * f.breathe, height: lerp(0.45, 1, h) * f.breathe)
        // Reduce Motion: fade in 0.2 s, crossfade to A02 at 0.7 s over 0.4 s
        let calmAlpha = calm ? min(1, t / 0.2) * (1 - max(0, min(1, (t - 0.7) / 0.4))) : 1
        let fieldAlpha = calm ? calmAlpha : 1 - Self.inOut(max(0, min(1, (t - hStart) / (hDur * 0.9))))
        let markAlpha = calm ? calmAlpha : 1 - max(0, min(1, (t - hStart) / 0.3))

        ZStack {
            GenitaLight.field.opacity(fieldAlpha)
            GenitaBacklight(intensity: (calm ? 1 : f.light) * (calm ? calmAlpha : 1) * (1 - max(0, min(1, (h - 0.35) / 0.45))) /* A02 owns the same light behind the head from here */, time: t)
                .frame(width: 440, height: 440)
                .scaleEffect(x: lightS.width, y: lightS.height)
                .position(lightC)
            mark(f, t: t, width: markW, height: markH)
                .scaleEffect(1 - 0.06 * max(0, min(1, (t - hStart) / 0.3)))
                .rotation3DEffect(.degrees(Double(lean.width) * 10), axis: (x: 0, y: 1, z: 0), perspective: 0.6)
                .rotation3DEffect(.degrees(Double(-lean.height) * 10), axis: (x: 1, y: 0, z: 0), perspective: 0.6)
                .position(markC)
                .opacity(markAlpha)
            wordmark(f: f, h: h, size: size, top: top, markBottom: markC.y + markH / 2)
                .opacity(calm ? calmAlpha : 1 - max(0, (h - 0.7) / 0.3))
        }
        .frame(width: size.width, height: size.height)
    }

    @ViewBuilder private func mark(_ f: Frame, t: Double, width: CGFloat, height: CGFloat) -> some View {
        // the rim is brighter on the side the light comes from
        let away = CGSize(width: -lean.width * 1.4, height: 1.6 - lean.height * 0.8)
        ZStack {
            // bloom behind: the mark blurred 12 and 4.5, lit
            BrandMarkShape().fill(GenitaLight.glint).blur(radius: 12).opacity(0.55 * f.light)
            BrandMarkShape().fill(GenitaLight.glint).blur(radius: 4.5).opacity(0.75 * f.light)
            // body
            BrandMarkShape().fill(GenitaLight.body).opacity(f.fill)
            // rim band (the outline turns into a lit edge)
            ZStack {
                BrandMarkShape().fill(GenitaLight.glint)
                BrandMarkShape().fill(.black).offset(away).blendMode(.destinationOut)
            }
            .compositingGroup()
            .opacity(f.fill * min(1, f.light * 1.2))
            // outline drawing in
            BrandMarkShape().trim(from: 0, to: f.outline)
                .stroke(GenitaLight.glint, style: StrokeStyle(lineWidth: 0.9, lineCap: .round, lineJoin: .round))
                .opacity(1 - f.fill * 0.85)
            // the blue dot circling the orbit once
            if f.orbit > 0, f.orbit < 1 {
                let head = f.orbit
                Ellipse().trim(from: max(0, head - 0.08), to: head)
                    .stroke(GenitaLight.accent, style: StrokeStyle(lineWidth: 2.4, lineCap: .round))
                    .frame(width: width * 1.18, height: height * 0.62)
                    .shadow(color: GenitaLight.accent.opacity(0.8), radius: 4)
                    .opacity(sin(head * .pi) * 1.2)
            }
        }
        .frame(width: width, height: height)
    }

    @ViewBuilder private func wordmark(f: Frame, h: Double, size: CGSize, top: CGFloat, markBottom: CGFloat) -> some View {
        if let logo = genitaBundleImage("logo") {
            // under the mark, then up to A02's top-left logo slot (66.571, 78.823) at its size
            let from = CGPoint(x: size.width / 2, y: markBottom + 34 + 8 * (1 - f.word))
            let to = CGPoint(x: 66.571, y: 78.823 + top)
            logo.resizable()
                .frame(width: lerp(88, 63.142, h), height: lerp(31.55, 22.626, h))
                .position(x: lerp(from.x, to.x, h), y: lerp(from.y, to.y, h))
                .opacity(f.word)
        }
    }

    // MARK: control

    @MainActor private func run() async {
        start = Date()
        if Self.frozenAt != nil { return } // review shot: hold the frame until tapped
        if !reduceMotion {
            leanSource.start { l in withAnimation(.interactiveSpring(response: 0.35, dampingFraction: 0.85)) { lean = l } }
        }
        try? await Task.sleep(for: .milliseconds(Int((reduceMotion ? 0.2 : Self.peak) * 1000)))
        if skipAt == nil, !hapticDone { hapticDone = true; GenitaHaptic.impact(soft: true, intensity: 0.6) } // the light peaks
    }

    @MainActor private func skip() {
        guard !finished, skipAt == nil, let start, !reduceMotion else { if reduceMotion { finish() }; return }
        let now = Date().timeIntervalSince(start)
        guard now < Self.handoffAt else { return } // already handing over
        skipAt = Self.frozenAt ?? now
        if Self.frozenAt != nil { self.start = Date().addingTimeInterval(-(Self.frozenAt ?? 0)); Self.unfreeze = true }
    }

    @MainActor private func finish() {
        guard !finished else { return }
        finished = true
        leanSource.stop()
        Self.handedOff = true
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

    private func lerp(_ a: CGFloat, _ b: CGFloat, _ p: Double) -> CGFloat { a + (b - a) * CGFloat(p) }
    /// cubic-bezier(0.77, 0, 0.175, 1) approximated by a symmetric quart in-out
    static func inOut(_ x: Double) -> Double { x < 0.5 ? 8 * pow(x, 4) : 1 - pow(-2 * x + 2, 4) / 2 }

    /// The splash has handed its light to the first screen this launch (A02 then rises its own light in 0.5 s).
    nonisolated(unsafe) public static var handedOff = GenitaSplash.shouldShowAtLaunch
    nonisolated(unsafe) static var unfreeze = false

    /// DEBUG review shots: `GENITA_SPLASH_AT=0.4` renders that instant, still, and never auto-wakes (a tap still does).
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

struct SplashOverlayModifier: ViewModifier {
    var enabled: Bool
    @State private var visible = GenitaSplash.shouldShowAtLaunch
    @State private var shownAt = Date()
    @State private var elapsedMs: Int?
    func body(content: Content) -> some View {
        content.overlay {
            if enabled && visible {
                GenitaSplash {
                    elapsedMs = Int(Date().timeIntervalSince(shownAt) * 1000)
                    visible = false
                }
            }
        }
        #if DEBUG
        // UI test reads how long the splash held the first screen (≤ 1600 ms)
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
