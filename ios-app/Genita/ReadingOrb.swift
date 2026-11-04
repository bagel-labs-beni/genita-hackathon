import SwiftUI

/// I03 "Making it feel like you / Reading your profile": the orb isn't a still (Chelsea 11/4 "사르륵사르륵",
/// Dyno's video 0:51–0:53). Its dots drift round (one turn in ~11 s, quicker as the bar fills: ~7 s at 100 %), the
/// whole orb breathes (1.00 ↔ 1.04, 3 s, ease in-out), a soft glint slides along its rim, and at 100 % it gives one
/// short bright pulse before the next screen. Same asset, colours and shape as the still; GPU transforms only.
/// Reduce Motion: the breathing alone.
struct ReadingOrb: View {
    var node: DesignNode
    var resource: String
    var progress: Double
    var finished: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// turns of the dot drift, integrated frame by frame so a speed change never jumps
    @State private var phase = 0.0
    @State private var last: Date?
    @State private var pulse = false

    static let turnSeconds = 11.0
    /// turns per second at `progress` (0…1): 1/11 → ~1/7.3
    static func turnRate(_ progress: Double) -> Double { (1 + 0.5 * min(1, max(0, progress))) / turnSeconds }
    /// 1.00 ↔ 1.04 over 3 s, eased (a cosine is ease-in-out at both ends)
    static func breath(_ t: Double) -> Double { 1 + 0.02 * (1 - cos(2 * .pi * t / 3)) }

    var body: some View {
        if SoulOrbFlag.isOn {
            // Dyno's live orb (SoulOrb.swift); 100 %: its "response complete" reaction plus the same short pulse
            SoulOrbView(reaction: finished ? 1 : 0)
                .frame(width: node.w, height: node.h)
                .scaleEffect(pulse ? 1.07 : 1)
                .onChange(of: finished) { _, done in
                    guard done else { return }
                    withAnimation(.easeOut(duration: 0.16)) { pulse = true }
                    withAnimation(.easeIn(duration: 0.2).delay(0.16)) { pulse = false }
                }
                .accessibilityHidden(true)
        } else {
            stillOrb
        }
    }

    /// #508's motion on the PNG: the fallback when the live orb is off (GENITA_LIVE_ORB=0) or Metal is missing
    @ViewBuilder private var stillOrb: some View {
        let transform = node.paintsRaw?.first?.imageTransform
        let sx = transform?[0][0] ?? 1, sy = transform?[1][1] ?? 1
        let tx = transform?[0][2] ?? 0, ty = transform?[1][2] ?? 0
        let w = node.w / sx, h = node.h / sy
        TimelineView(.animation(minimumInterval: 1 / 30)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            let image = Image(resource: resource).resizable().frame(width: w, height: h)
            ZStack {
                image.rotationEffect(.degrees(reduceMotion ? 0 : phase * 360))
                if !reduceMotion {
                    // a soft white glint travelling round the rim, only where the orb has dots
                    AngularGradient(stops: [
                        .init(color: .white.opacity(0), location: 0),
                        .init(color: .white.opacity(0.9), location: 0.06),
                        .init(color: .white.opacity(0), location: 0.16),
                        .init(color: .white.opacity(0), location: 1),
                    ], center: .center, angle: .degrees(t * 30))
                    .mask(RadialGradient(stops: [
                        .init(color: .clear, location: 0.55),
                        .init(color: .white, location: 0.82),
                        .init(color: .white, location: 1),
                    ], center: .center, startRadius: 0, endRadius: min(w, h) / 2))
                    .mask(image.rotationEffect(.degrees(phase * 360)))
                    .blendMode(.plusLighter)
                    .opacity(0.35)
                }
            }
            .frame(width: w, height: h)
            .scaleEffect(Self.breath(t) * (pulse ? 1.07 : 1))
            .brightness(pulse ? 0.12 : 0)
            .onChange(of: ctx.date) { _, now in
                defer { last = now }
                guard !reduceMotion, let last else { return }
                phase += min(0.1, now.timeIntervalSince(last)) * Self.turnRate(progress)
            }
        }
        .offset(x: -tx * w, y: -ty * h)
        .frame(width: node.w, height: node.h, alignment: .topLeading)
        .onChange(of: finished) { _, done in
            guard done else { return }
            withAnimation(.easeOut(duration: 0.16)) { pulse = true }
            withAnimation(.easeIn(duration: 0.2).delay(0.16)) { pulse = false }
        }
        .accessibilityHidden(true)
    }
}
