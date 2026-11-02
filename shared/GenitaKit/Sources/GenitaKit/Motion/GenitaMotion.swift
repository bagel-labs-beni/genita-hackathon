import SwiftUI

/// Genita motion tokens + small isolated modifiers (lane 업데이트·모션). Screens stay owned by their lanes;
/// these are one-line drop-ins. Values follow the motion catalog (design/publish/motion/index.html) — when it
/// changes, change them here only.
///
/// Every continuous loop stops for Reduce Motion and for UI tests (`GENITA_REVIEW_STILL=1`), so XCUITest
/// sees an idle app; one-shot entrances become a short fade under Reduce Motion.
public enum GenitaMotion {
    // MARK: tokens
    /// small UI reactions (chips, pills, toggles)
    public static let snappy = Animation.spring(response: 0.32, dampingFraction: 0.82)
    /// things that arrive (toasts, banners, sheet content)
    public static let bouncy = Animation.spring(response: 0.46, dampingFraction: 0.7)
    /// big surfaces (face reveal, splash exit)
    public static let gentle = Animation.spring(response: 0.7, dampingFraction: 0.9)
    /// r03 sheet: same feel as the board's 420 ms drawer curve, but a spring that keeps the finger's speed.
    public static let sheet = Animation.interpolatingSpring(mass: 1, stiffness: 240, damping: 31)
    /// Drag release: carry the gesture's velocity (pt/s) into the spring over the remaining distance (pt).
    public static func sheetSettle(velocity: CGFloat, remaining: CGFloat) -> Animation {
        let v = abs(remaining) < 1 ? 0 : max(-12, min(12, velocity / remaining))
        return .interpolatingSpring(mass: 1, stiffness: 240, damping: 31, initialVelocity: v)
    }
    /// D19: expression crossfade ≈ 0.3 s
    public static let crossfade = Animation.easeInOut(duration: 0.3)
    /// Reduce Motion replacement for any of the above
    public static let fade = Animation.easeOut(duration: 0.2)
    /// one breath (s); the face and PREP-1 photo breathe at this pace
    public static let breathSeconds: Double = 4.2
    /// light sweep across a photo / the brandmark (s per pass, incl. rest)
    public static let sweepSeconds: Double = 2.6
    /// "{name} is thinking" shimmer pass (s)
    public static let shimmerSeconds: Double = 1.6

    /// UI tests / review screenshots ask for a still app (continuous loops would keep XCUITest from idling).
    public static var reviewStill: Bool {
        #if DEBUG
        ProcessInfo.processInfo.environment["GENITA_REVIEW_STILL"] == "1" || ProcessInfo.processInfo.arguments.contains("--uitesting")
        #else
        false
        #endif
    }
}

// MARK: - Breathing (PREP-1 photo, S09-P still face)

struct BreathingModifier: ViewModifier {
    var active: Bool
    var depth: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        let paused = !active || reduceMotion || GenitaMotion.reviewStill
        TimelineView(.animation(minimumInterval: 1 / 30, paused: paused)) { ctx in
            let s = paused ? 0 : sin(ctx.date.timeIntervalSinceReferenceDate / GenitaMotion.breathSeconds * 2 * .pi)
            content
                .scaleEffect(1 + depth * (s + 1) / 2)
                .offset(y: -depth * 90 * (s + 1) / 2)
        }
    }
}

// MARK: - Light sweep (PREP-1 photo, brandmark glint)

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
                    let cycle = ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: GenitaMotion.sweepSeconds) / GenitaMotion.sweepSeconds
                    // pass in the first 55 % of the cycle, rest after
                    let x = min(1, cycle / 0.55)
                    SweepBand(progress: x, angle: angle, intensity: intensity)
                }
                .mask(content)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
        }
    }
}

/// A soft diagonal light band at `progress` 0…1 across the view (−30 %…130 %).
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

// MARK: - Thinking shimmer ("{name} is thinking", S09-T)

struct ThinkingShimmerModifier: ViewModifier {
    var active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Works on any text colour: the text rests at 55 % and a full-strength band passes through it.
    func body(content: Content) -> some View {
        let paused = !active || reduceMotion || GenitaMotion.reviewStill
        if paused {
            content
        } else {
            content.mask {
                TimelineView(.animation(minimumInterval: 1 / 60, paused: false)) { ctx in
                    let p = ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: GenitaMotion.shimmerSeconds) / GenitaMotion.shimmerSeconds
                    let x0 = -1 + 2 * p
                    LinearGradient(stops: [
                        .init(color: .black.opacity(0.55), location: 0),
                        .init(color: .black, location: 0.5),
                        .init(color: .black.opacity(0.55), location: 1),
                    ], startPoint: UnitPoint(x: x0, y: 0.5), endPoint: UnitPoint(x: x0 + 1, y: 0.5))
                }
            }
        }
    }
}

// MARK: - Face reveal (S07 → S09)

/// S07 shows the face veiled (soft blur, slightly dim and close); when the call screen arrives the veil lifts:
/// blur 18 → 0, scale 1.06 → 1, brightness −0.12 → 0, on a gentle spring. Reduce Motion: a short fade.
struct FaceRevealModifier: ViewModifier {
    var veiled: Bool
    @State private var shown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        let open = !veiled && shown
        let still = reduceMotion || GenitaMotion.reviewStill
        content
            .blur(radius: open || still ? 0 : 18, opaque: true)
            .scaleEffect(open || still ? 1 : 1.06)
            .brightness(open ? 0 : -0.12)
            .onAppear {
                if still { shown = true; return }
                withAnimation(GenitaMotion.gentle.delay(0.05)) { shown = true }
            }
            .animation(still ? GenitaMotion.fade : GenitaMotion.gentle, value: veiled)
    }
}

// MARK: - Chip appear (r03 sheet chips, PF-1 reason chips)

struct ChipAppearModifier: ViewModifier {
    var index: Int
    @State private var shown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        let still = reduceMotion || GenitaMotion.reviewStill
        content
            .opacity(shown ? 1 : 0)
            .scaleEffect(shown || still ? 1 : 0.86, anchor: .leading)
            .offset(y: shown || still ? 0 : 6)
            .onAppear {
                if GenitaMotion.reviewStill { shown = true; return }
                withAnimation((still ? GenitaMotion.fade : GenitaMotion.bouncy).delay(Double(min(index, 8)) * 0.045)) { shown = true }
            }
    }
}

// MARK: - Entrances

struct BlurFade: ViewModifier {
    var radius: CGFloat
    var opacity: Double
    func body(content: Content) -> some View { content.blur(radius: radius).opacity(opacity) }
}

public extension AnyTransition {
    /// Toast from the top: drops in with a little scale and focus pull; leaves by fading down.
    static var genitaToast: AnyTransition {
        .asymmetric(
            insertion: .modifier(active: BlurFade(radius: 6, opacity: 0), identity: BlurFade(radius: 0, opacity: 1))
                .combined(with: .offset(y: -14)).combined(with: .scale(scale: 0.94, anchor: .top)),
            removal: .opacity.combined(with: .scale(scale: 0.97, anchor: .top))
        )
    }
    /// Chat bubble / message row: rises 10 pt out of a soft blur.
    static var genitaMessage: AnyTransition {
        .modifier(active: BlurFade(radius: 4, opacity: 0), identity: BlurFade(radius: 0, opacity: 1)).combined(with: .offset(y: 10))
    }
}

// MARK: - Expression crossfade (D19)

/// Face image that crossfades (≈0.3 s) whenever `key` changes (neutral ↔ laugh ↔ warm). Reduce Motion: instant.
public struct ExpressionCrossfade<Face: View, Key: Hashable>: View {
    var key: Key
    var face: (Key) -> Face
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    public init(key: Key, @ViewBuilder face: @escaping (Key) -> Face) {
        self.key = key
        self.face = face
    }
    public var body: some View {
        ZStack {
            face(key).id(key).transition(.opacity)
        }
        .animation(reduceMotion ? nil : GenitaMotion.crossfade, value: key)
    }
}

// MARK: - Public API

public extension View {
    /// Slow breath (scale + lift). `depth` 0.012 ≈ the S09-P face.
    func genitaBreathing(_ active: Bool = true, depth: CGFloat = 0.012) -> some View { modifier(BreathingModifier(active: active, depth: depth)) }
    /// Diagonal light band passing over this view's opaque pixels.
    func genitaLightSweep(_ active: Bool = true, angle: Angle = .degrees(20), intensity: Double = 0.45) -> some View {
        modifier(LightSweepModifier(active: active, angle: angle, intensity: intensity))
    }
    /// Shimmer over text while the companion is thinking.
    func genitaThinkingShimmer(_ active: Bool) -> some View { modifier(ThinkingShimmerModifier(active: active)) }
    /// Veiled while `veiled`; lifts on a spring when it turns false (and on first appear when already false).
    func genitaFaceReveal(veiled: Bool) -> some View { modifier(FaceRevealModifier(veiled: veiled)) }
    /// Staggered spring pop for chips in a row (`index` = position).
    func genitaChipAppear(index: Int) -> some View { modifier(ChipAppearModifier(index: index)) }
}
