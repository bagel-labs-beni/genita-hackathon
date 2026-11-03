import SwiftUI

/// 춘식이's motion details r02, cards 7–9 (`_qa-scripts/genita-splash/motion/index.html`):
/// PREP-1 checklist marks, onboarding titles revealed line by line, the interpret "Hold to talk" level bars.
/// Screens keep their own colours and sizes; these pieces only add the motion. Every piece checks
/// `MotionDetails.live(reduceMotion:)` (flag on, no Reduce Motion, not a UI test) before it moves.
public enum MotionOnboarding {
    // MARK: card 7 · PREP-1 checklist

    /// Active row spinner: one turn every 0.8 s.
    public static let spinnerTurn: Double = 0.8
    /// Done: the disc fades in over 150 ms …
    public static let discFade = Animation.easeOut(duration: 0.15)
    /// … and the check is drawn in 200 ms, 50 ms after the disc starts.
    public static let checkDraw = Animation.easeOut(duration: 0.2).delay(0.05)
    /// Row text colour pending → done.
    public static let rowText = Animation.easeOut(duration: 0.2)

    // MARK: card 8 · titles line by line, progress dots

    /// Each title line: opacity 0 → 1, 6 pt up → 0, blur 4 → 0 over 380 ms on (0.16, 1, 0.3, 1), 70 ms apart.
    public static let lineDuration: Double = 0.38
    public static let lineGap: Double = 0.07
    public static let lineRise: CGFloat = 6
    public static let lineBlur: CGFloat = 4
    /// Lines the reveal is timed for; a longer title shows its extra lines at the end.
    public static let maxLines = 8
    /// The whole reveal for `lines` lines.
    public static func lineRevealTotal(lines: Int = maxLines) -> Double { lineDuration + lineGap * Double(max(0, lines - 1)) }
    /// The progress dots' one capsule moving to the current card.
    public static let dotSpring = Animation.spring(response: 0.38, dampingFraction: 0.75)

    private static let expoOut = UnitCurve.bezier(startControlPoint: UnitPoint(x: 0.16, y: 1), endControlPoint: UnitPoint(x: 0.3, y: 1))
    /// 0 … 1 for line `line`, `elapsed` seconds after the reveal started (lines past `maxLines` come with the last one).
    public static func lineProgress(elapsed: Double, line: Int) -> Double {
        let t = (elapsed - lineGap * Double(min(line, maxLines - 1))) / lineDuration
        if t <= 0 { return 0 }
        if t >= 1 { return 1 }
        return expoOut.value(at: t)
    }

    // MARK: card 9 · Hold to talk

    /// Press: the fill sweeps in from the left in 150 ms; release: it drains in 200 ms.
    public static let holdFill = Animation.easeOut(duration: 0.15)
    public static let holdDrain = Animation.easeOut(duration: 0.2)
    public static let holdScale: CGFloat = 0.98
}

// MARK: - Card 7 · the done mark

/// The check drawn by `.trim` (20 pt box, from the motion board's SVG: M5.8 10.3 l2.8 2.8 5.6 −6).
public struct MotionCheckShape: Shape {
    public init() {}
    public func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 20
        var p = Path()
        p.move(to: CGPoint(x: rect.minX + 5.8 * s, y: rect.minY + 10.3 * s))
        p.addLine(to: CGPoint(x: rect.minX + 8.6 * s, y: rect.minY + 13.1 * s))
        p.addLine(to: CGPoint(x: rect.minX + 14.2 * s, y: rect.minY + 7.1 * s))
        return p
    }
}

/// Card 7 done: the disc fades in (150 ms) and the check draws itself (200 ms, 50 ms later) when `done`
/// turns true. Shown complete when it appears already done, and complete at once when `animated` is false.
public struct MotionDoneMark: View {
    var done: Bool
    var disc: Color
    var check: Color
    var lineWidth: CGFloat
    var animated: Bool
    @State private var discOn: Bool
    @State private var drawn: Bool

    public init(done: Bool, disc: Color, check: Color, lineWidth: CGFloat = 1.9, animated: Bool) {
        self.done = done
        self.disc = disc
        self.check = check
        self.lineWidth = lineWidth
        self.animated = animated
        _discOn = State(initialValue: done)
        _drawn = State(initialValue: done)
    }

    public var body: some View {
        ZStack {
            Circle().fill(disc).opacity(discOn ? 1 : 0)
            MotionCheckShape().trim(from: 0, to: drawn ? 1 : 0)
                .stroke(check, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
        }
        .onChange(of: done) { _, now in
            guard now else { discOn = false; drawn = false; return }
            guard animated else { discOn = true; drawn = true; return }
            discOn = false; drawn = false
            withAnimation(MotionOnboarding.discFade) { discOn = true }
            withAnimation(MotionOnboarding.checkDraw) { drawn = true }
        }
        .accessibilityHidden(true)
    }
}

// MARK: - Card 8 · title lines (SwiftUI Text)

/// Draws a Text one line at a time: line i at `MotionOnboarding.lineProgress(elapsed:line: i)` (opacity, 6 pt rise,
/// blur lifting). `elapsed` is animated linearly by `motionLineReveal`.
@available(iOS 18.0, macOS 15.0, *)
public struct MotionLineRevealRenderer: TextRenderer {
    public var elapsed: Double
    public init(elapsed: Double) { self.elapsed = elapsed }
    public var animatableData: Double {
        get { elapsed }
        set { elapsed = newValue }
    }
    public func draw(layout: Text.Layout, in ctx: inout GraphicsContext) {
        let finished = elapsed >= MotionOnboarding.lineRevealTotal()
        for (i, line) in layout.enumerated() {
            let p = finished ? 1 : MotionOnboarding.lineProgress(elapsed: elapsed, line: i)
            if p >= 1 { ctx.draw(line); continue }
            var c = ctx
            c.opacity = p
            c.translateBy(x: 0, y: MotionOnboarding.lineRise * (1 - p))
            c.addFilter(.blur(radius: MotionOnboarding.lineBlur * (1 - p)))
            c.draw(line)
        }
    }
}

@available(iOS 18.0, macOS 15.0, *)
struct MotionTextLineReveal<Key: Equatable>: ViewModifier {
    var key: Key
    @State private var elapsed: Double = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        if MotionDetails.live(reduceMotion: reduceMotion) {
            content
                .textRenderer(MotionLineRevealRenderer(elapsed: elapsed))
                .onAppear { play() }
                .onChange(of: key) { _, _ in play() }
        } else {
            content
        }
    }

    private func play() {
        var t = Transaction(); t.disablesAnimations = true
        withTransaction(t) { elapsed = 0 }
        withAnimation(.linear(duration: MotionOnboarding.lineRevealTotal())) { elapsed = MotionOnboarding.lineRevealTotal() }
    }
}

// MARK: - Card 8 · title lines (views that draw their own text, e.g. Core Text labels)

/// For titles drawn outside SwiftUI Text (Core Text labels): while revealing, the view is drawn once per line band
/// (`pitch` pt tall, from the top) and each band rises, sharpens and fades in on its own. Before and after the
/// reveal it is the plain view; during it the plain view stays invisible underneath as the one accessibility element
/// (the band copies are hidden from accessibility).
struct MotionBandLineReveal<Key: Equatable>: ViewModifier {
    var pitch: CGFloat
    var key: Key
    /// set when the view is made, so the first frame is already the start of the reveal (no flash of the full title)
    @State private var start: Date? = Date()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        Group {
            if MotionDetails.live(reduceMotion: reduceMotion), let start, pitch > 0 {
                // the plain view stays (masked out, not hidden) so VoiceOver and UI tests keep the one title element
                content.mask { Color.clear }.overlay(alignment: .topLeading) {
                    GeometryReader { g in
                        let n = min(MotionOnboarding.maxLines * 2, max(1, Int((g.size.height / pitch).rounded(.up))))
                        TimelineView(.animation) { tl in
                            let elapsed = tl.date.timeIntervalSince(start)
                            ZStack(alignment: .topLeading) {
                                ForEach(0..<n, id: \.self) { i in
                                    let p = MotionOnboarding.lineProgress(elapsed: elapsed, line: i)
                                    content
                                        .frame(width: g.size.width, height: g.size.height)
                                        .mask(alignment: .topLeading) { band(i, of: n, width: g.size.width, height: g.size.height) }
                                        .blur(radius: MotionOnboarding.lineBlur * (1 - p))
                                        .offset(y: MotionOnboarding.lineRise * (1 - p))
                                        .opacity(p)
                                }
                            }
                        }
                    }
                    .accessibilityHidden(true)
                    .allowsHitTesting(false)
                }
            } else {
                content
            }
        }
        .onAppear { start = Date() }
        .onChange(of: key) { _, _ in start = Date() }
        .task(id: start) {
            guard let s = start else { return }
            let left = MotionOnboarding.lineRevealTotal() - Date().timeIntervalSince(s)
            if left > 0 { try? await Task.sleep(for: .seconds(left)) }
            if !Task.isCancelled, start == s { start = nil }
        }
    }

    /// Band i: from its line's top to the next line's top; the first and last bands reach past the view so glyphs
    /// drawn outside it (ascenders, descenders) still belong to a band.
    private func band(_ i: Int, of n: Int, width: CGFloat, height: CGFloat) -> some View {
        let reach: CGFloat = 40
        let top = i == 0 ? -reach : CGFloat(i) * pitch
        let bottom = i == n - 1 ? height + reach : CGFloat(i + 1) * pitch
        return Rectangle()
            .frame(width: width + 2 * reach, height: max(0, bottom - top))
            .offset(x: -reach, y: top)
    }
}

public extension View {
    /// Card 8 for a SwiftUI Text title: lines appear one after another (iOS 18 `TextRenderer`), replayed when `key` changes.
    @ViewBuilder func motionLineReveal<Key: Equatable>(key: Key) -> some View {
        if #available(iOS 18.0, macOS 15.0, *) { modifier(MotionTextLineReveal(key: key)) } else { self }
    }
    /// Card 8 for a title that draws its own text: line bands `pitch` pt tall from the top, replayed when `key` changes.
    func motionBandLineReveal<Key: Equatable>(pitch: CGFloat, key: Key) -> some View {
        modifier(MotionBandLineReveal(pitch: pitch, key: key))
    }
}

// MARK: - Card 9 · level bars over Hold to talk

/// Five 3 pt bars (3 pt apart, 4–20 pt tall) that follow the voice while the button is held. `level` (0…1) is read
/// every frame; without it the bars sway low and calm. Still (static low bars) under Reduce Motion and UI tests.
public struct MotionLevelBars: View {
    var active: Bool
    var level: (() -> Float)?
    var color: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(active: Bool, level: (() -> Float)? = nil, color: Color = .white) {
        self.active = active
        self.level = level
        self.color = color
    }

    public var body: some View {
        let moving = active && MotionDetails.live(reduceMotion: reduceMotion)
        TimelineView(.animation(minimumInterval: 1 / 30, paused: !moving)) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate
            let v = moving ? Double(max(0, min(1, level?() ?? 0))) : 0
            HStack(alignment: .bottom, spacing: 3) {
                ForEach(0..<5, id: \.self) { i in
                    RoundedRectangle(cornerRadius: 1.5).fill(color)
                        .frame(width: 3, height: Self.height(bar: i, time: t, level: v, moving: moving, live: level != nil))
                }
            }
            .frame(height: 22, alignment: .bottom)
        }
        .accessibilityHidden(true)
    }

    static func height(bar i: Int, time t: Double, level: Double, moving: Bool, live: Bool) -> CGFloat {
        guard moving else { return [5, 8, 6, 9, 5][i] }
        let sway = abs(sin(t / 0.14 + Double(i) * 1.3))
        if live { return CGFloat(4 + 16 * level * (0.45 + 0.55 * sway)) }
        // no level source yet: a calm low sway
        return CGFloat(4 + 5 * abs(sin(t / 0.26 + Double(i) * 0.9)))
    }
}
