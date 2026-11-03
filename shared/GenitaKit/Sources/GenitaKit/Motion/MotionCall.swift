import SwiftUI

/// Motion details cards 1, 2, 3, 10 (call surface): the status pill's icons and width, the mic button press and voice
/// ring, the "Noted" chip, the call connecting / ending. iPhone S09 and the Mac call window share these.
/// Every piece is still under Reduce Motion / UI tests and is skipped when `MotionDetails.enabled` is off
/// (the call sites keep the previous views for that case).
public enum MotionCall {
    /// Card 1: pill width
    public static let pillWidth = Animation.spring(response: 0.36, dampingFraction: 0.8)
    /// Card 1: the words cross-dissolve (`.contentTransition(.interpolate)`)
    public static let pillText = Animation.easeInOut(duration: 0.18)
    /// Card 1: listening dot, one breath
    public static let breathSeconds = 1.4
    /// Card 1: thinking dots, one wave; each dot 0.15 s after the one before
    public static let waveSeconds = 1.2
    public static let waveStagger = 0.15
    /// Card 1 / 2: level smoothing (s)
    public static let outputSmoothing = 0.06
    public static let inputSmoothing = 0.05
    /// Card 2: press 0.92 in 100 ms, back on a spring
    public static let pressScale: CGFloat = 0.92
    public static let pressDown = Animation.easeOut(duration: 0.1)
    public static let pressUp = Animation.spring(response: 0.3, dampingFraction: 0.6)
    /// Card 3: drops 8 pt in, check drawn 120 ms later in 220 ms, leaves 6 pt up in 200 ms after 2.4 s
    public static let chipIn = Animation.spring(response: 0.3, dampingFraction: 0.8)
    public static let chipCheck = Animation.easeOut(duration: 0.22).delay(0.12)
    public static let chipOut = Animation.easeIn(duration: 0.2)
    public static let chipDwell = 2.4
    /// Card 10: blur 14 + dark + 1.04 lift in 520 ms; controls rise 12 pt, 40 ms apart; ending 300 ms
    public static let reveal = MotionDetails.easeOutExpo(0.52)
    public static let conceal = Animation.easeIn(duration: 0.3)
    public static let controlRise = Animation.spring(response: 0.36, dampingFraction: 0.75)
    public static let controlStagger = 0.04
}

/// Exponential smoothing of a level read once per frame (time constant `tau` seconds).
final class MotionLevelSmoother {
    private(set) var value: Float = 0
    private var last: TimeInterval?
    let tau: Double
    init(tau: Double) { self.tau = tau }
    func next(_ target: Float, at t: TimeInterval) -> Float {
        let dt = last.map { max(0, min(0.1, t - $0)) } ?? 0
        last = t
        value += (target - value) * Float(1 - exp(-dt / max(0.001, tau)))
        return value
    }
}

// MARK: - Card 1 · status pill icons

public enum MotionPillIconKind: Equatable { case listening, thinking, talking }

/// Listening: a blue dot breathing (1.4 s). Thinking: three dots in a wave (1.2 s, 0.15 s apart). Talking: four bars
/// following the reply's loudness (60 ms smoothing), growing up and down from their middle. 20 × 20 like the old icons.
public struct MotionPillIcon: View {
    var kind: MotionPillIconKind
    var color: Color
    var dotColor: Color
    var level: () -> Float
    @State private var smoother = MotionLevelSmoother(tau: MotionCall.outputSmoothing)
    public init(kind: MotionPillIconKind, color: Color, dotColor: Color, level: @escaping () -> Float = { 0 }) {
        self.kind = kind
        self.color = color
        self.dotColor = dotColor
        self.level = level
    }
    public var body: some View {
        TimelineView(.animation) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            Group {
                switch kind {
                case .listening:
                    let s = (1 - cos(t / MotionCall.breathSeconds * 2 * .pi)) / 2
                    Circle().fill(dotColor).frame(width: 8, height: 8)
                        .scaleEffect(0.8 + 0.35 * s).opacity(0.55 + 0.45 * s)
                case .thinking:
                    HStack(spacing: 3) {
                        ForEach(0..<3, id: \.self) { i in
                            let p = (t - Double(i) * MotionCall.waveStagger) / MotionCall.waveSeconds
                            let lift = max(0, sin(p * 2 * .pi))
                            Circle().fill(color).frame(width: 4, height: 4)
                                .offset(y: -3 * lift).opacity(0.45 + 0.55 * lift)
                        }
                    }
                case .talking:
                    let v = Double(smoother.next(level(), at: t))
                    HStack(alignment: .center, spacing: 2) {
                        ForEach(0..<4, id: \.self) { i in
                            let sway = 0.55 + 0.45 * abs(sin(t / 0.14 + Double(i) * 1.3))
                            RoundedRectangle(cornerRadius: 1).fill(dotColor).frame(width: 2, height: 3 + 9 * v * sway)
                        }
                    }
                }
            }
            .frame(width: 20, height: 20, alignment: .center)
        }
        .accessibilityHidden(true)
    }
}

// MARK: - Card 2 · press + voice ring

/// Press: 0.92 in 100 ms easeOut, back on spring(0.3, 0.6). Reduce Motion / flag off: no scale.
public struct MotionPressStyle: ButtonStyle {
    public init() {}
    public func makeBody(configuration: Configuration) -> some View { MotionPressBody(label: configuration.label, pressed: configuration.isPressed) }
}

private struct MotionPressBody<Label: View>: View {
    var label: Label
    var pressed: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        let live = MotionDetails.live(reduceMotion: reduceMotion)
        label
            .scaleEffect(live && pressed ? MotionCall.pressScale : 1)
            .animation(live ? (pressed ? MotionCall.pressDown : MotionCall.pressUp) : nil, value: pressed)
    }
}

/// A ring around a round button that grows 1.0 → 1.15 with the user's voice (50 ms smoothing) and is gone when they
/// are quiet. Draw it behind the button, same diameter. Off under Reduce Motion / UI tests / flag off.
public struct MotionVoiceRing: View {
    var active: Bool
    var diameter: CGFloat
    var color: Color
    var level: () -> Float
    @State private var smoother = MotionLevelSmoother(tau: MotionCall.inputSmoothing)
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    public init(active: Bool, diameter: CGFloat, color: Color, level: @escaping () -> Float) {
        self.active = active
        self.diameter = diameter
        self.color = color
        self.level = level
    }
    public var body: some View {
        if active && MotionDetails.live(reduceMotion: reduceMotion) {
            TimelineView(.animation) { ctx in
                let v = CGFloat(smoother.next(level(), at: ctx.date.timeIntervalSinceReferenceDate))
                Circle().strokeBorder(color, lineWidth: 2)
                    .frame(width: diameter, height: diameter)
                    .scaleEffect(1 + 0.15 * v)
                    .opacity(v < 0.03 ? 0 : 0.25 + 0.75 * Double(v))
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }
}

// MARK: - Card 3 · "Noted" chip

/// The check of the "Noted" chip as a stroke that can be drawn (`trim`), in a 12 × 12 box like the SF checkmark it replaces.
public struct MotionCheckShape: Shape {
    public init() {}
    public func path(in r: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: r.minX + r.width * 0.12, y: r.minY + r.height * 0.54))
        p.addLine(to: CGPoint(x: r.minX + r.width * 0.40, y: r.minY + r.height * 0.80))
        p.addLine(to: CGPoint(x: r.minX + r.width * 0.88, y: r.minY + r.height * 0.22))
        return p
    }
}

/// Drop-in from 8 pt above (spring 0.3 / 0.8), stays `MotionCall.chipDwell`, leaves 6 pt up in 200 ms.
/// `leaveAfter` nil = stays until removed. Reduce Motion: a fade both ways.
struct MotionChipEntrance: ViewModifier {
    var leaveAfter: Double?
    @State private var phase = 0 // 0 waiting, 1 shown, 2 leaving
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        let calm = reduceMotion || GenitaMotion.reviewStill
        content
            .opacity(phase == 1 ? 1 : 0)
            .offset(y: calm ? 0 : phase == 0 ? -8 : phase == 2 ? -6 : 0)
            .task {
                if GenitaMotion.reviewStill { phase = 1; return }
                withAnimation(calm ? GenitaMotion.fade : MotionCall.chipIn) { phase = 1 }
                guard let leaveAfter else { return }
                try? await Task.sleep(for: .seconds(leaveAfter))
                guard !Task.isCancelled else { return }
                withAnimation(calm ? GenitaMotion.fade : MotionCall.chipOut) { phase = 2 }
            }
    }
}

/// The chip's check, drawn in 220 ms after 120 ms (full at once under Reduce Motion / UI tests).
public struct MotionNotedCheck: View {
    var color: Color
    @State private var drawn: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    public init(color: Color) { self.color = color }
    public var body: some View {
        MotionCheckShape().trim(from: 0, to: drawn)
            .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            .frame(width: 12, height: 12)
            .onAppear {
                if reduceMotion || GenitaMotion.reviewStill { drawn = 1; return }
                withAnimation(MotionCall.chipCheck) { drawn = 1 }
            }
    }
}

// MARK: - Card 10 · call connecting / ending

/// The face behind blur 14, darkened and at 1.04 while `veiled`; it clears once in 520 ms (0.16, 1, 0.3, 1) the first time
/// it is not veiled (the call site plays the connect haptic on the call going live). Turning veiled again (the call ending) blurs and darkens it in 300 ms.
/// Reduce Motion: only the dark veil, fading. `enabled: false` draws it plain (offscreen captures).
struct MotionCallReveal: ViewModifier {
    var veiled: Bool
    var enabled = true
    @State private var open = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        let clear = !enabled || open || GenitaMotion.reviewStill
        content
            .blur(radius: clear || reduceMotion ? 0 : 14, opaque: true)
            .scaleEffect(clear || reduceMotion ? 1 : 1.04)
            .overlay { Color.black.opacity(clear ? 0 : 0.4).allowsHitTesting(false) }
            .onAppear { set(veiled: veiled) }
            .onChange(of: veiled) { _, v in set(veiled: v) }
    }
    private func set(veiled: Bool) {
        guard enabled, !GenitaMotion.reviewStill, open == veiled else { return }
        withAnimation(reduceMotion ? GenitaMotion.fade : veiled ? MotionCall.conceal : MotionCall.reveal) { open = !veiled }
    }
}

/// Controls rise 12 pt and fade in, `index` × 40 ms apart, when `shown` turns true (and on appear when already true).
struct MotionControlRise: ViewModifier {
    var shown: Bool
    var index: Int
    @State private var up = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        let calm = reduceMotion || GenitaMotion.reviewStill
        // UI tests / review stills: always in place (S07's disabled controls stay visible as before)
        content
            .opacity(up || GenitaMotion.reviewStill ? 1 : 0)
            .offset(y: up || calm ? 0 : 12)
            .onAppear { rise(shown) }
            .onChange(of: shown) { _, on in rise(on) }
    }
    private func rise(_ on: Bool) {
        guard up != on else { return }
        if GenitaMotion.reviewStill { up = on; return }
        let base = reduceMotion ? GenitaMotion.fade : MotionCall.controlRise
        withAnimation(on ? base.delay(Double(index) * MotionCall.controlStagger) : GenitaMotion.fade) { up = on }
    }
}

public extension View {
    /// Card 3: drop in, stay, leave (see `MotionChipEntrance`).
    func motionChipEntrance(leaveAfter: Double?) -> some View { modifier(MotionChipEntrance(leaveAfter: leaveAfter)) }
    /// Card 10: the call face's veil (see `MotionCallReveal`).
    func motionCallReveal(veiled: Bool, enabled: Bool = true) -> some View { modifier(MotionCallReveal(veiled: veiled, enabled: enabled)) }
    /// Card 10: a call control rising into place (see `MotionControlRise`).
    func motionControlRise(shown: Bool, index: Int) -> some View { modifier(MotionControlRise(shown: shown, index: index)) }
}
