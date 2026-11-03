import SwiftUI

/// 춘식이's motion details r02, cards 4–6 (`_qa-scripts/genita-splash/motion/index.html`): the Finds sheet rising
/// with its blocks lifting in one after another and a sweeping photo placeholder (4), the ingredient chip press (5),
/// and the save pop with one blue shine over the card (6). Screens keep their look; these only add motion.
///
/// Every piece follows `MotionDetails`: flag off → the screen's previous behavior, Reduce Motion → static or a
/// short fade, UI tests (`GenitaMotion.reviewStill`) → static, so XCUITest sees an idle app.
public enum MotionFinds {
    // MARK: card 4 · Finds sheet
    /// The sheet rising to its next height.
    public static let sheetRise = Animation.spring(response: 0.42, dampingFraction: 0.86)
    /// Each block (title → info → photo) lifts this far while it fades in …
    public static let blockLift: CGFloat = 8
    /// … in 280 ms, 40 ms after the block above.
    public static func blockRise(_ index: Int) -> Animation { .easeOut(duration: 0.28).delay(Double(max(0, min(index, 6))) * 0.04) }
    /// One placeholder sweep, left → right.
    public static let shimmerPeriod: Double = 1.2
    /// The picture replacing its placeholder.
    public static let photoIn = Animation.easeOut(duration: 0.25)

    // MARK: card 5 · ingredient chip
    public static let chipPressScale: CGFloat = 0.96
    public static let chipSpring = Animation.spring(response: 0.25, dampingFraction: 0.55)
    /// Chip background / icon color.
    public static let chipColor = Animation.easeOut(duration: 0.2)

    // MARK: card 6 · save
    /// The shine band crosses the card once: x −120% → 120% of its width.
    public static let shineDuration: Double = 0.5
    public static let shineTravel: CGFloat = 1.2

    /// Motion that still plays under Reduce Motion as a plain fade (picture crossfades): flag on, not a UI test.
    @MainActor public static var fades: Bool { MotionDetails.enabled && !GenitaMotion.reviewStill }
}

// MARK: - Card 4 · blocks lift in

struct FindsRiseModifier: ViewModifier {
    var index: Int
    @State private var shown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        // flag off / UI test: drawn at once, exactly as before
        let hidden = MotionFinds.fades && !shown
        content
            .opacity(hidden ? 0 : 1)
            .offset(y: hidden && !reduceMotion ? MotionFinds.blockLift : 0)
            .onAppear {
                guard !shown else { return }
                guard MotionFinds.fades else { shown = true; return }
                withAnimation(reduceMotion ? GenitaMotion.fade : MotionFinds.blockRise(index)) { shown = true }
            }
    }
}

/// The picture fading in over its placeholder when `value` (its load status) changes. Flag off / UI tests: nothing added.
struct FindsPhotoFadeModifier<V: Equatable>: ViewModifier {
    var value: V
    func body(content: Content) -> some View {
        if MotionFinds.fades {
            content.animation(MotionFinds.photoIn, value: value)
        } else {
            content
        }
    }
}

// MARK: - Card 4 · photo placeholder

/// The photo placeholder: `base` with a white band sweeping left → right every 1.2 s (a moving gradient over the
/// slot, SwiftUI-Shimmer pattern). Still `base` under Reduce Motion and in UI tests (the loop stops).
public struct FindsShimmer: View {
    var base: Color
    var intensity: Double
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    public init(base: Color, intensity: Double = 0.75) {
        self.base = base
        self.intensity = intensity
    }
    public var body: some View {
        let still = reduceMotion || GenitaMotion.reviewStill
        ZStack {
            base
            if !still {
                GeometryReader { g in
                    TimelineView(.animation(minimumInterval: 1 / 60, paused: false)) { ctx in
                        let t = ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: MotionFinds.shimmerPeriod) / MotionFinds.shimmerPeriod
                        LinearGradient(stops: [
                            .init(color: .white.opacity(0), location: 0.3),
                            .init(color: .white.opacity(intensity), location: 0.5),
                            .init(color: .white.opacity(0), location: 0.7),
                        ], startPoint: UnitPoint(x: 0, y: 0.45), endPoint: UnitPoint(x: 1, y: 0.55))
                        .frame(width: g.size.width, height: g.size.height)
                        .offset(x: (-1 + 2 * t) * g.size.width)
                    }
                }
                .clipped()
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

// MARK: - Card 5 · chip press

/// Ingredient chip press: 0.96 and back on a springy 0.25 s. Flag off, Reduce Motion or UI tests: the screen's
/// previous press (`fallbackScale`, 120 ms ease-out).
public struct FindsChipPress: ButtonStyle {
    var fallbackScale: CGFloat
    public init(fallbackScale: CGFloat = 0.97) { self.fallbackScale = fallbackScale }
    public func makeBody(configuration: Configuration) -> some View {
        FindsChipPressBody(label: configuration.label, pressed: configuration.isPressed, fallbackScale: fallbackScale)
    }
}

private struct FindsChipPressBody<Label: View>: View {
    let label: Label
    let pressed: Bool
    let fallbackScale: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        let live = MotionDetails.live(reduceMotion: reduceMotion)
        label
            .scaleEffect(pressed ? (live ? MotionFinds.chipPressScale : fallbackScale) : 1)
            .animation(live ? MotionFinds.chipSpring : .easeOut(duration: 0.12), value: pressed)
    }
}

/// The chip's SF Symbol swaps with the replace effect when its name changes (? → ✓, + → ✓).
struct FindsSymbolReplaceModifier<V: Equatable>: ViewModifier {
    var value: V
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        if MotionDetails.live(reduceMotion: reduceMotion) {
            content.contentTransition(.symbolEffect(.replace)).animation(MotionFinds.chipColor, value: value)
        } else {
            content
        }
    }
}

// MARK: - Card 6 · save

/// The bookmark pops (symbol bounce) each time `value` changes.
struct FindsBounceModifier<V: Equatable>: ViewModifier {
    var value: V
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        if MotionDetails.live(reduceMotion: reduceMotion) {
            content.symbolEffect(.bounce, value: value)
        } else {
            content
        }
    }
}

/// One skewed band of `color` crosses the view (x −120% → 120%, 500 ms ease-in-out) each time `trigger` changes.
struct FindsShineModifier<T: Equatable>: ViewModifier {
    var trigger: T
    var color: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        content.overlay {
            if MotionDetails.live(reduceMotion: reduceMotion) {
                GeometryReader { g in
                    let w = g.size.width
                    LinearGradient(stops: [
                        .init(color: color.opacity(0), location: 0.35),
                        .init(color: color, location: 0.5),
                        .init(color: color.opacity(0), location: 0.65),
                    ], startPoint: UnitPoint(x: 0, y: 0.32), endPoint: UnitPoint(x: 1, y: 0.68)) // 110° like the spec
                    .frame(width: w, height: g.size.height)
                    // rests off the right edge; each trigger runs it in from the left
                    .keyframeAnimator(initialValue: MotionFinds.shineTravel, trigger: trigger) { band, x in
                        band.offset(x: x * w)
                    } keyframes: { _ in
                        MoveKeyframe(-MotionFinds.shineTravel)
                        LinearKeyframe(MotionFinds.shineTravel, duration: MotionFinds.shineDuration, timingCurve: .easeInOut)
                    }
                }
                .clipped()
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
        }
    }
}

/// A haptic from the motion cards: plays only while the `motionDetails` flag is on (off → no new haptics).
struct FindsHapticModifier<T: Equatable>: ViewModifier {
    var feedback: SensoryFeedback
    var trigger: T
    func body(content: Content) -> some View {
        let on = MotionDetails.enabled
        content.sensoryFeedback(feedback, trigger: trigger) { _, _ in on }
    }
}

// MARK: - Public API

public extension View {
    /// Card 4: this block lifts 8 pt and fades in on appear, `index` × 40 ms after the first (fade only under
    /// Reduce Motion; drawn at once with the flag off and in UI tests).
    func findsRise(_ index: Int) -> some View { modifier(FindsRiseModifier(index: index)) }
    /// Card 4: animate the picture's arrival (250 ms) when `value` changes; pair with `.transition(.opacity)` on the picture.
    func findsPhotoFade<V: Equatable>(_ value: V) -> some View { modifier(FindsPhotoFadeModifier(value: value)) }
    /// Card 5: the symbol swaps with `.symbolEffect(.replace)` when `value` (its name) changes.
    func findsSymbolReplace<V: Equatable>(_ value: V) -> some View { modifier(FindsSymbolReplaceModifier(value: value)) }
    /// Card 6: symbol bounce each time `value` changes.
    func findsBounce<V: Equatable>(_ value: V) -> some View { modifier(FindsBounceModifier(value: value)) }
    /// Card 6: one shine band of `color` across this view each time `trigger` changes.
    func findsShine<T: Equatable>(_ trigger: T, color: Color) -> some View { modifier(FindsShineModifier(trigger: trigger, color: color)) }
    /// Cards 5 and 6: `feedback` when `trigger` changes, only with the `motionDetails` flag on.
    func findsHaptic<T: Equatable>(_ feedback: SensoryFeedback, trigger: T) -> some View { modifier(FindsHapticModifier(feedback: feedback, trigger: trigger)) }
}
