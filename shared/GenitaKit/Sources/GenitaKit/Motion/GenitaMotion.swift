import SwiftUI

/// Genita motion tokens + small isolated modifiers (lane 업데이트·모션). Screens stay owned by their lanes;
/// these are one-line drop-ins. Values = the motion page's six shared values
/// (design/publish/motion/index.html "공통 값") — never invent a new one; change them here only.
///
/// Every continuous loop stops for Reduce Motion and for UI tests (`--uitesting` / `GENITA_REVIEW_STILL=1`), so
/// XCUITest sees an idle app; one-shot entrances become a short fade under Reduce Motion.
public enum GenitaMotion {
    // MARK: the six shared values
    /// r03 sheet, card arrival
    public static let sheet = Animation.spring(duration: 0.5, bounce: 0.15)
    /// chips, checks, toasts, status line
    public static let ui = Animation.spring(duration: 0.35, bounce: 0.1)
    /// splash eye-open only
    public static let signature = Animation.spring(duration: 0.42, bounce: 0.25)
    /// appear / disappear, blur lifting (0.2–0.6 s)
    public static func appear(_ duration: Double = 0.3) -> Animation { .timingCurve(0.23, 1, 0.32, 1, duration: duration) }
    /// moving across the screen (light hand-off, save flight)
    public static func move(_ duration: Double = 0.55) -> Animation { .timingCurve(0.77, 0, 0.175, 1, duration: duration) }
    /// Mac drawer (MAC-RS sheet)
    public static let macDrawer = Animation.timingCurve(0.32, 0.72, 0, 1, duration: 0.32)

    /// Drag release on the r03 sheet: the sheet spring, started at the finger's speed (pt/s over the remaining pt).
    public static func sheetSettle(velocity: CGFloat, remaining: CGFloat) -> Animation {
        let v = abs(remaining) < 1 ? 0 : max(-12, min(12, velocity / remaining))
        return .interpolatingSpring(Spring(duration: 0.5, bounce: 0.15), initialVelocity: v)
    }
    /// Reduce Motion replacement for one-shot motion
    public static let fade = Animation.easeOut(duration: 0.2)

    // catalog timings
    /// PREP-1 photo / S09 face breath (s per round trip)
    public static let breathSeconds: Double = 4.2
    /// PREP-1 light band: a 1.4 s pass every 3.2 s
    public static let sweepEvery: Double = 3.2
    public static let sweepPass: Double = 1.4

    /// UI tests / review screenshots ask for a still app (continuous loops would keep XCUITest from idling).
    public static var reviewStill: Bool {
        #if DEBUG
        ProcessInfo.processInfo.environment["GENITA_REVIEW_STILL"] == "1" || ProcessInfo.processInfo.arguments.contains("--uitesting")
        #else
        false
        #endif
    }
}

// MARK: - Breathing (PREP-1 photo 1 → 1.015, S09 face)

struct BreathingModifier: ViewModifier {
    var active: Bool
    var depth: CGFloat
    var anchor: UnitPoint
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        let paused = !active || reduceMotion || GenitaMotion.reviewStill
        TimelineView(.animation(minimumInterval: 1 / 30, paused: paused)) { ctx in
            // ease-in-out round trip: 0 → 1 → 0 every breathSeconds
            let s = paused ? 0 : (1 - cos(ctx.date.timeIntervalSinceReferenceDate / GenitaMotion.breathSeconds * 2 * .pi)) / 2
            content.scaleEffect(1 + depth * s, anchor: anchor)
        }
    }
}

// MARK: - Light sweep (PREP-1 photo)

struct LightSweepModifier: ViewModifier {
    var active: Bool
    var angle: Angle
    var intensity: Double
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        let paused = !active || reduceMotion || GenitaMotion.reviewStill
        content.overlay {
            if !paused {
                TimelineView(.animation(minimumInterval: 1 / 60, paused: false)) { ctx in
                    let t = ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: GenitaMotion.sweepEvery)
                    if t < GenitaMotion.sweepPass {
                        SweepBand(progress: t / GenitaMotion.sweepPass, angle: angle, intensity: intensity)
                    }
                }
                .mask(content)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
        }
    }
}

/// A soft diagonal light band at `progress` 0…1 across the view.
public struct SweepBand: View {
    public var progress: Double
    public var angle: Angle = .degrees(20)
    public var intensity: Double = 0.55
    public init(progress: Double, angle: Angle = .degrees(20), intensity: Double = 0.55) {
        self.progress = progress
        self.angle = angle
        self.intensity = intensity
    }
    public var body: some View {
        GeometryReader { g in
            let w = max(g.size.width, g.size.height) * 0.45
            LinearGradient(stops: [
                .init(color: .white.opacity(0), location: 0),
                .init(color: .white.opacity(intensity * 0.6), location: 0.42),
                .init(color: .white.opacity(intensity), location: 0.5),
                .init(color: .white.opacity(intensity * 0.6), location: 0.58),
                .init(color: .white.opacity(0), location: 1),
            ], startPoint: .leading, endPoint: .trailing)
            .frame(width: w, height: g.size.height * 2)
            .rotationEffect(angle)
            .position(x: -w + (g.size.width + 2 * w) * progress, y: g.size.height / 2)
            .blendMode(.plusLighter)
        }
    }
}

// MARK: - Face reveal (S07 → S09)

/// Catalog S07→S09: blur 18 → 0 and scale 1.06 → 1 on the 0.6 s appear curve when the call screen is ready.
/// Reduce Motion: only a dark veil lifting in 0.2 s (no blur, no scale).
struct FaceRevealModifier: ViewModifier {
    var veiled: Bool
    /// false: drawn as fully shown at once (offscreen captures like the handoff snapshot never get `onAppear`)
    var enabled = true
    @State private var shown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        let open = !enabled || (!veiled && shown)
        let calm = reduceMotion || GenitaMotion.reviewStill
        content
            .blur(radius: open || calm ? 0 : 18, opaque: true)
            .scaleEffect(open || calm ? 1 : 1.06)
            .overlay { Color.black.opacity(open ? 0 : 0.28).allowsHitTesting(false) }
            .onAppear {
                if GenitaMotion.reviewStill { shown = true; return }
                withAnimation(reduceMotion ? GenitaMotion.fade : GenitaMotion.appear(0.6)) { shown = true }
            }
            .animation(calm ? GenitaMotion.fade : GenitaMotion.appear(0.6), value: veiled)
    }
}

// MARK: - S09 status line

/// Catalog: old words leave upward, new words rise from below (0.22 s); the pill width follows on
/// `.spring(duration: 0.3, bounce: 0)`. Reduce Motion: 0.15 s fade.
struct StatusLineModifier<V: Hashable>: ViewModifier {
    var value: V
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        let calm = reduceMotion || GenitaMotion.reviewStill
        // a new identity per value, so the old line leaves up and the new one rises (the parent animates)
        content
            .id(value)
            .transition(calm ? .opacity : .push(from: .bottom))
    }
}

// MARK: - Chip appear (r03 sheet chips, PF-1 reason chips)

struct ChipAppearModifier: ViewModifier {
    var index: Int
    @State private var shown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        let calm = reduceMotion || GenitaMotion.reviewStill
        content
            .opacity(shown ? 1 : 0)
            .scaleEffect(shown || calm ? 1 : 0.9, anchor: .leading)
            .offset(y: shown || calm ? 0 : 6)
            .onAppear {
                if GenitaMotion.reviewStill { shown = true; return }
                // catalog F10 r03: chips one after another, 50 ms apart, UI spring
                withAnimation((calm ? GenitaMotion.fade : GenitaMotion.ui).delay(Double(min(index, 8)) * 0.05)) { shown = true }
            }
    }
}

// MARK: - Toast (A02-E and every other toast)

/// Catalog: drops from the top on the UI spring, leaves the same way in 0.2 s. Reduce Motion: 0.2 s fade.
/// Apply where the toast is inserted (it picks the transition from the environment).
struct ToastTransitionModifier: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        content.transition(reduceMotion ? .opacity : .asymmetric(
            insertion: .move(edge: .top).combined(with: .opacity),
            removal: .move(edge: .top).combined(with: .opacity)
        ))
    }
}

// MARK: - Expression crossfade (catalog: 0.35 s ease-in-out)

/// Face image that crossfades whenever `key` changes (neutral ↔ laugh ↔ warm). Stays a fade under Reduce Motion.
public struct ExpressionCrossfade<Face: View, Key: Hashable>: View {
    var key: Key
    var face: (Key) -> Face
    public init(key: Key, @ViewBuilder face: @escaping (Key) -> Face) {
        self.key = key
        self.face = face
    }
    public var body: some View {
        ZStack { face(key).id(key).transition(.opacity) }
            .animation(.easeInOut(duration: 0.35), value: key)
    }
}

// MARK: - Public API

public extension View {
    /// Catalog breath: 1 → `1 + depth` and back over 4.2 s (PREP-1 photo, S09 face).
    func genitaBreathing(_ active: Bool = true, depth: CGFloat = 0.015, anchor: UnitPoint = .center) -> some View {
        modifier(BreathingModifier(active: active, depth: depth, anchor: anchor))
    }
    /// Catalog PREP-1 light band over this view's opaque pixels: 1.4 s pass every 3.2 s.
    func genitaLightSweep(_ active: Bool = true, angle: Angle = .degrees(20), intensity: Double = 0.45) -> some View {
        modifier(LightSweepModifier(active: active, angle: angle, intensity: intensity))
    }
    /// Veiled while `veiled`; lifts on the appear curve when it turns false (and on first appear when already false).
    /// `enabled: false` draws the face fully shown with no effect (offscreen captures).
    func genitaFaceReveal(veiled: Bool, enabled: Bool = true) -> some View { modifier(FaceRevealModifier(veiled: veiled, enabled: enabled)) }
    /// S09 status line text: push from below on change of `value`.
    /// The container must animate on the same value: `.animation(.spring(duration: 0.3, bounce: 0), value: value)`.
    func genitaStatusLine<V: Hashable>(_ value: V) -> some View { modifier(StatusLineModifier(value: value)) }
    /// Staggered pop for chips in a row (`index` = position).
    func genitaChipAppear(index: Int) -> some View { modifier(ChipAppearModifier(index: index)) }
    /// Toast insertion/removal (from the top; fade under Reduce Motion).
    func genitaToastTransition() -> some View { modifier(ToastTransitionModifier()) }
}
