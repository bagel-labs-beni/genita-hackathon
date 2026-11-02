import SwiftUI

/// A02 "before being born": the backlit silhouette gets a slow rim of light along its contour, a 1.5 % breath
/// (~4.6 s), a light that drifts behind it, and faint dust motes caught in the light. `pulse` turning true
/// (e.g. "Continue with Apple" tapped) brightens the rim for a beat. Calm by design: text above stays readable.
/// The rim is the view itself, blurred and screen-blended over itself: the bright backdrop bleeds into the dark
/// edges only (screen never darkens), so it follows any silhouette with no extra mask asset.
/// Reduce Motion / UI tests: a still rim, no breath, no motes.
struct RimLightModifier: ViewModifier {
    var pulse: Bool
    var strength: Double
    @State private var beat: Double = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        let still = reduceMotion || GenitaMotion.reviewStill
        TimelineView(.animation(minimumInterval: 1 / 30, paused: still)) { ctx in
            let t = still ? 0 : ctx.date.timeIntervalSinceReferenceDate
            let breath = still ? 0.5 : (sin(t / 4.6 * 2 * .pi) + 1) / 2
            let light = UnitPoint(x: 0.5 + 0.1 * sin(t / 7.3), y: 0.34 + 0.05 * cos(t / 9.1))
            let scale = 1 + 0.015 * breath
            content
                .overlay {
                    content
                        .blur(radius: 9)
                        .blendMode(.screen)
                        .opacity(min(1, strength * (0.55 + 0.3 * breath) + 0.45 * beat))
                        .mask(RadialGradient(colors: [.white, .white.opacity(0.3)], center: light, startRadius: 0, endRadius: 520))
                        .allowsHitTesting(false)
                }
                .scaleEffect(scale)
                .overlay {
                    if !still { DustMotes(time: t).allowsHitTesting(false).accessibilityHidden(true) }
                }
        }
        .onChange(of: pulse) { _, on in
            guard on, !still else { return }
            beat = 1
            withAnimation(.easeOut(duration: 1.1)) { beat = 0 }
        }
    }
}

/// ~28 faint motes drifting up through the light (deterministic, no state).
struct DustMotes: View {
    var time: Double
    var body: some View {
        Canvas { ctx, size in
            for i in 0..<28 {
                let seed = Double(i) * 12.9898
                let rx = (sin(seed) * 43758.5453).truncatingRemainder(dividingBy: 1)
                let ry = (sin(seed * 1.7) * 24634.6345).truncatingRemainder(dividingBy: 1)
                let speed = 6 + 10 * abs(rx)
                let x = abs(rx) * size.width + 10 * sin(time / (3 + abs(ry) * 4) + seed)
                let y = (abs(ry) * size.height - time * speed).truncatingRemainder(dividingBy: size.height)
                let yy = y < 0 ? y + size.height : y
                let r = 0.5 + 0.9 * abs(ry)
                let a = 0.08 + 0.16 * (sin(time / 2.3 + seed) + 1) / 2
                ctx.fill(Path(ellipseIn: CGRect(x: x, y: yy, width: r * 2, height: r * 2)), with: .color(.white.opacity(a)))
            }
        }
    }
}

public extension View {
    /// A02 rim light on a backlit silhouette image (`pulse` true → the rim brightens for a beat).
    func genitaRimLight(pulse: Bool = false, strength: Double = 1) -> some View { modifier(RimLightModifier(pulse: pulse, strength: strength)) }
}
