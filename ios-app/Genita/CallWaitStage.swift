import SwiftUI

/// S09 · PREP wait stage (춘식이 11/4, `_qa-scripts/genita-splash/wait-stage`): until the companion's generated
/// face (the call scene, its rest-frame poster or the live face) is here, the face's place shows the orb on a soft
/// radial ground instead of black. Never a silhouette, never the uploaded photo.
/// - ground: radial at (50 %, 38 %) #1A1C20 → #0E0F11 (55 %) → #0B0B0B
/// - orb: the live orb (I03's) when on, else orb.png breathing 1 ↔ 1.04 + opacity 0.82 ↔ 1 over 3.2 s with a
///   #4DB8FF 35 % glow; 250 pt, centred on x, at 38 % of the height (the head's place)
/// - leaving: the orb grows to 1.06 and fades in 300 ms (ease-in) while the face clears (card 10)
/// - Reduce Motion: no breathing or glow pulse; leaving is a 250 ms crossfade
struct CallWaitStage: View {
    var size: CGSize
    /// true once the generated face is here: the orb steps back
    var leaving = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// the handoff snapshot (ImageRenderer can't draw the UIKit/Metal orb): the PNG orb at rest
    @Environment(\.genitaStillRender) private var stillRender
    @State private var breathe = false

    static let ground = RadialGradient(stops: [
        .init(color: Color(red: 0x1A / 255, green: 0x1C / 255, blue: 0x20 / 255), location: 0),
        .init(color: Color(red: 0x0E / 255, green: 0x0F / 255, blue: 0x11 / 255), location: 0.55),
        .init(color: Color(red: 0x0B / 255, green: 0x0B / 255, blue: 0x0B / 255), location: 1),
    ], center: UnitPoint(x: 0.5, y: 0.38), startRadius: 0, endRadius: 560)
    static let glow = Color(red: 0x4D / 255, green: 0xB8 / 255, blue: 1)
    /// 250 pt on a phone; never wider than 62 % of a small box
    static func orbSize(_ size: CGSize) -> CGFloat { min(250, size.width * 0.62) }

    var body: some View {
        let d = Self.orbSize(size)
        let calm = reduceMotion || CallMotion.reviewStill || stillRender
        ZStack {
            Self.ground
            orb(d, calm: calm)
                .scaleEffect(leaving && !calm ? 1.06 : 1)
                .position(x: size.width / 2, y: size.height * 0.38)
        }
        .frame(width: size.width, height: size.height)
        .opacity(leaving ? 0 : 1)
        .animation(calm ? .easeInOut(duration: 0.25) : .easeIn(duration: 0.3), value: leaving)
        .allowsHitTesting(false)
        .accessibilityElement()
        .accessibilityLabel("Getting ready")
        .accessibilityIdentifier("callWaitStage")
        .accessibilityValue(leaving ? "leaving" : "waiting")
    }

    private func startBreathing() {
        var still = Transaction(); still.disablesAnimations = true
        withTransaction(still) { breathe = false }
        withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) { breathe = true }
    }

    @ViewBuilder private func orb(_ d: CGFloat, calm: Bool) -> some View {
        // calm (Reduce Motion, review stills): the still orb, no breathing — the live orb keeps moving (Codex P3)
        if SoulOrbFlag.isOn && !calm {
            SoulOrbView(stretchWide: false).frame(width: d, height: d)
        } else {
            // orb.png carries wide transparent margins (the mock's -212 pt inset on a 250 pt box)
            Image(resource: "orb").resizable().scaledToFit().frame(width: d * 674 / 250, height: d * 674 / 250)
                .shadow(color: Self.glow.opacity(0.35), radius: 24)
                // calm holds it at rest even mid-breath (Reduce Motion turned on while waiting; Codex P3)
                .scaleEffect(calm || !breathe ? 1 : 1.04).opacity(calm || breathe ? 1 : 0.82)
                .onAppear { if !calm { startBreathing() } }
                .onChange(of: calm) { _, now in if !now { startBreathing() } }
        }
    }
}
