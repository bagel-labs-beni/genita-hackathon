import SwiftUI

/// A02 "before being born" (motion page card `a02-unborn`), applied to the existing A02 sign-in photo
/// (a dark person on a bright backdrop). The photo becomes a mask: the person is a deep #030304 shadow on
/// #070707, a light behind the head rises (2.4 s; 0.5 s when the splash hands its light over) and wakes the
/// hair and shoulder line with a rim; 1.5 % breath (4.6 s, anchored at the bottom), light swell (6.4 s), up to
/// six motes drifting up from the contour, and "Continue with Apple" (`pulse` → true) brightens the rim
/// 1 → 1.6 in 0.18 s and back in 0.72 s with a light haptic. A top scrim keeps the copy readable.
/// Tilt (iPhone) / pointer (Mac) moves the light ±22/±14 pt.
/// Reduce Motion / UI tests: no breath, motes, rays or tilt; the light is fixed and fades in over 0.2 s.
///
/// Geometry: `head` = centre of the light behind the head, in the photo's own coordinates (fraction of its
/// frame); `lightDiameter` likewise. Defaults match A02 (photo 757 × 1009, light at 200,342 ⌀440 on the 390 × 844 board).
struct UnbornModifier: ViewModifier {
    var pulse: Bool
    var head: UnitPoint
    var lightDiameter: CGFloat
    var arrival: Double

    @State private var appeared = Date()
    @State private var beatAt: Date?
    @State private var lean = CGSize.zero
    @State private var leanSource = GenitaLeanSource()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        let still = reduceMotion || GenitaMotion.reviewStill
        // laid out at the photo's own size: the photo stays (invisible) for layout, the scene draws over it
        content.opacity(0).overlay { GeometryReader { g in
            TimelineView(.animation(minimumInterval: 1 / 30, paused: still)) { ctx in
                let now = ctx.date
                let t = now.timeIntervalSinceReferenceDate
                let rise = still || arrival < 0.01 ? 1 : ease(min(1, now.timeIntervalSince(appeared) / arrival))
                let breath = still ? 0 : (1 - cos(t / 4.6 * 2 * .pi)) / 2
                let swell = still ? 0 : (1 - cos(t / 6.4 * 2 * .pi)) / 2
                let intensity = rise * beat(now, still: still)
                let center = CGPoint(x: head.x * g.size.width + lean.width * 22, y: head.y * g.size.height + lean.height * 14)
                // the side of the figure facing the light gets the rim band
                let away = CGSize(width: -lean.width * 1.2, height: 2.4)

                ZStack {
                    GenitaLight.field.padding(-2000) // fills tall screens past the photo too (#189)
                    GenitaBacklight(intensity: intensity, time: still ? 0 : t)
                        .frame(width: lightDiameter * g.size.width, height: lightDiameter * g.size.width)
                        .scaleEffect(1 + 0.04 * swell)
                        .position(center)
                    ZStack {
                        // bloom: the silhouette's light spill (blur 9 and 24)
                        GenitaLight.glint.mask(silhouette(content)).blur(radius: 24).opacity(0.35 * intensity)
                        GenitaLight.glint.mask(silhouette(content)).blur(radius: 9).opacity(0.5 * intensity)
                        GenitaLight.figure.mask(silhouette(content))
                        // rim: the silhouette minus itself pushed away from the light = a thin lit edge
                        ZStack {
                            GenitaLight.glint.mask(silhouette(content))
                            Color.black.mask(silhouette(content)).offset(away).blendMode(.destinationOut)
                        }
                        .compositingGroup()
                        .mask(RadialGradient(colors: [.white, .white.opacity(0.25)], center: UnitPoint(x: center.x / max(g.size.width, 1), y: center.y / max(g.size.height, 1)), startRadius: 0, endRadius: g.size.width * 0.7))
                        .opacity(min(1, intensity))
                        .blendMode(.screen)
                    }
                    .scaleEffect(1 + 0.015 * breath, anchor: .bottom)
                    if !still { motes(t, size: g.size) }
                    LinearGradient(stops: [
                        .init(color: GenitaLight.field.opacity(0.86), location: 0),
                        .init(color: GenitaLight.field.opacity(0.55), location: 0.5),
                        .init(color: GenitaLight.field.opacity(0), location: 1),
                    ], startPoint: .top, endPoint: .bottom)
                    .frame(height: 0.26 * g.size.height) // ≈ the board's 260 pt top scrim over the copy
                    .frame(maxHeight: .infinity, alignment: .top)
                    .offset(y: 0.165 * g.size.height) // the photo starts above the screen (A02 offset −168)
                }
                .frame(width: g.size.width, height: g.size.height)
            }
        } }
        .onAppear {
            appeared = Date()
            if !still { leanSource.start { l in withAnimation(.interactiveSpring(response: 0.35, dampingFraction: 0.85)) { lean = l } } }
        }
        .onDisappear { leanSource.stop() }
        #if os(macOS)
        .onContinuousHover { phase in
            guard !still else { return }
            withAnimation(.interactiveSpring(response: 0.3, dampingFraction: 0.8)) {
                if case let .active(p) = phase { lean = CGSize(width: max(-1, min(1, p.x / 300 - 1)), height: max(-1, min(1, p.y / 400 - 1))) } else { lean = .zero }
            }
        }
        #endif
        .onChange(of: pulse) { _, on in
            guard on else { return }
            beatAt = Date()
            GenitaHaptic.impact(soft: false, intensity: 0.7)
        }
        .accessibilityHidden(true)
    }

    /// person = opaque, bright backdrop = clear
    private func silhouette(_ content: Content) -> some View {
        content.colorInvert().contrast(1.6).luminanceToAlpha()
    }

    /// Apple tap: 1 → 1.6 in 0.18 s, back to 1 in 0.72 s (Reduce Motion: a 0.6 s brightness change)
    private func beat(_ now: Date, still: Bool) -> Double {
        guard let beatAt else { return 1 }
        let s = now.timeIntervalSince(beatAt)
        if still { return s < 0.6 ? 1.3 : 1 }
        if s < 0.18 { return 1 + 0.6 * (s / 0.18) }
        if s < 0.9 { return 1 + 0.6 * (1 - ease((s - 0.18) / 0.72)) }
        return 1
    }

    private func ease(_ x: Double) -> Double { 1 - pow(1 - max(0, min(1, x)), 3) }

    /// ≤ 6 motes born on the contour every ~1.1–2.0 s, rising and fading over 2.6–4.0 s.
    private func motes(_ t: Double, size: CGSize) -> some View {
        Canvas { ctx, _ in
            for i in 0..<6 {
                let h = Self.hash(Double(i) + 0.37)
                let life = 2.6 + 1.4 * h
                let period = 6 * (1.1 + 0.9 * Self.hash(Double(i) * 3.1))
                let phase = (t + Double(i) * period / 6).truncatingRemainder(dividingBy: period)
                guard phase < life else { continue }
                let cycle = Int((t + Double(i) * period / 6) / period)
                let p = Self.contour[(cycle * 5 + i) % Self.contour.count]
                let k = phase / life
                let x = p.x * size.width + 6 * sin(k * 5 + Double(i))
                let y = p.y * size.height - 46 * k
                let a = sin(k * .pi) * 0.85
                ctx.fill(Path(ellipseIn: CGRect(x: x - 4, y: y - 4, width: 8, height: 8)), with: .color(GenitaLight.glint.opacity(a * 0.25)))
                ctx.fill(Path(ellipseIn: CGRect(x: x - 1.5, y: y - 1.5, width: 3, height: 3)), with: .color(GenitaLight.mote.opacity(a)))
            }
        }
        .allowsHitTesting(false)
    }

    /// points on the A02 silhouette's lit edge (fractions of the photo frame): hair, temples, ears, shoulders
    static let contour: [CGPoint] = [
        CGPoint(x: 0.43, y: 0.10), CGPoint(x: 0.56, y: 0.09), CGPoint(x: 0.66, y: 0.15), CGPoint(x: 0.30, y: 0.17),
        CGPoint(x: 0.76, y: 0.30), CGPoint(x: 0.19, y: 0.31), CGPoint(x: 0.73, y: 0.45), CGPoint(x: 0.24, y: 0.45),
        CGPoint(x: 0.88, y: 0.79), CGPoint(x: 0.10, y: 0.80),
    ]

    private static func hash(_ x: Double) -> Double { abs(sin(x * 12.9898) * 43758.5453).truncatingRemainder(dividingBy: 1) }
}

public extension View {
    /// A02 "before being born" on the sign-in photo. `pulse` true (Apple tapped) → the rim brightens for a beat.
    /// `arrival`: how long the light takes to rise (2.4 s; the splash passes its light, so 0.5 s right after it).
    func genitaUnborn(pulse: Bool = false, head: UnitPoint = UnitPoint(x: 372 / 757, y: 510 / 1009), lightDiameter: CGFloat = 440 / 757, arrival: Double? = nil) -> some View {
        modifier(UnbornModifier(pulse: pulse, head: head, lightDiameter: lightDiameter, arrival: arrival ?? (GenitaSplash.handedOff ? 0.5 : 2.4)))
    }
}
