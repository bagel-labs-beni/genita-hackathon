import SwiftUI
import AppKit

/// MAC-0 · launch "A · Eclipse" (Chelsea 11/4, 춘식이 spec). Reference, moving:
/// ./_qa-scripts/genita-splash/mac/mac-launch-r02.html?v=A — `MacSplashFrame.at` is a port of its `render(t)`.
/// The Mac's own layout (not the iPhone GenitaSplash board): dark glass A′ mark rotated −14° at (210, 118), a white
/// disc in its round counter at (220, 116) with the calm corona behind it, the wordmark at (210, 192), #070707.
/// Hand-off never crossfades two opaque layers: the window colour itself turns #070707 → #FDFDFD (the mark ends
/// as ink on white, like the app icon), then the mark lifts out and the first screen rises in.
enum MacSplash {
    static let dark = (r: 7.0, g: 7.0, b: 7.0)
    static let light = (r: 253.0, g: 253.0, b: 253.0)
    static func mix(_ a: (r: Double, g: Double, b: Double), _ b: (r: Double, g: Double, b: Double), _ k: Double) -> Color {
        Color(red: (a.r + (b.r - a.r) * k) / 255, green: (a.g + (b.g - a.g) * k) / 255, blue: (a.b + (b.b - a.b) * k) / 255)
    }
    /// Minimum time on screen before the hand-off: longer signed out (the first impression), short signed in.
    static func minimumMs(signedIn: Bool) -> Double { signedIn ? 900 : 1600 }
    /// The splash is gone this long after the hand-off starts.
    static let handoffMs: Double = 900
}

/// One frame of the launch, a pure function of t (ms since the first frame) and the hand-off time X.
struct MacSplashFrame {
    var markOpacity = 0.0, markY = 0.0, markScale = 0.96
    var wordOpacity = 0.0, wordY = 6.0
    var disc = 0.0, corona = 0.0, coronaScale = 1.0
    var orbitOpacity = 0.0, orbitAngle = 0.0
    var bgMix = 0.0
    var status = 0.0
    var content = 0.0            // the first screen: 0 hidden … 1 in place
    var splashClear = false      // the splash background is gone (same colour as the first screen by then)
    var done = false

    private static func c(_ x: Double) -> Double { max(0, min(1, x)) }
    private static func eo(_ x: Double) -> Double { 1 - pow(1 - x, 3) }                 // ease-out
    private static func io(_ x: Double) -> Double { -(cos(.pi * x) - 1) / 2 }           // sine in-out
    private static func ei(_ x: Double) -> Double { x * x }                             // ease-in (exits)
    private static func breath(_ t: Double, _ period: Double) -> Double { (1 - cos(2 * .pi * t / period)) / 2 }

    /// - Parameters: `x` = hand-off time (nil while /me hasn't answered), `rm` = Reduce Motion.
    static func at(_ t: Double, handoff x: Double?, reduceMotion rm: Bool) -> MacSplashFrame {
        var f = MacSplashFrame()
        let mIn = eo(c(t / (rm ? 200 : 600)))
        let wIn = eo(c((t - (rm ? 0 : 400)) / (rm ? 200 : 500)))
        f.markOpacity = mIn; f.markScale = 0.96 + 0.04 * mIn
        f.wordOpacity = wIn; f.wordY = 6 * (1 - wIn)
        f.disc = rm ? mIn : eo(c((t - 200) / 500))
        f.corona = rm ? 0.7 * mIn : 0.8 * eo(c((t - 300) / 900))
        if !rm && t > 1200 { let b = breath(t - 1200, 2400); f.corona = 0.8 - 0.25 * b; f.coronaScale = 1 + 0.12 * b }
        if !rm {
            let p = ((t - 150) / 2400).truncatingRemainder(dividingBy: 1)
            f.orbitAngle = (p < 0 ? p + 1 : p) * 2 * .pi
            f.orbitOpacity = 0.5 * c((t - 150) / 600) * (x.map { 1 - c((t - $0) / 200) } ?? 1)
        }
        // "Connecting…" once the check runs past 5 s
        if t > 5000 && (x == nil || t < x!) { f.status = c((t - 5000) / 400) }
        guard let x, t >= x else { return f }
        let d = t - x
        f.corona *= 1 - c(d / 250); f.coronaScale *= 1 - 0.1 * eo(c(d / 250))
        f.bgMix = io(c(d / (rm ? 250 : 450)))
        f.disc *= 1 - c(d / 300)
        let e = ei(c((d - (rm ? 0 : 300)) / (rm ? 250 : 300)))
        f.markOpacity *= 1 - e; f.markY = -10 * e
        f.wordOpacity *= 1 - e; f.wordY = -10 * e
        f.splashClear = d >= (rm ? 250 : 450)
        f.content = rm ? c(d / 250) : eo(c((d - 450) / 350))
        f.done = d > MacSplash.handoffMs
        return f
    }
}

/// The A′ brandmark outline (the app icon's path, 152 × 71 in its own units).
struct MacBrandmarkShape: Shape {
    private static let d = "M0 35.4971C0.00142835 24.6412 68.2085 -18.0441 104.946 8.62793C100.159 5.69154 94.5276 3.99707 88.5 3.99707C73.9919 3.99707 61.7766 13.806 58.1191 27.1533C37.8275 28.8303 24.0007 32.1607 24 35.9971C24.0005 39.8521 37.962 43.1943 58.415 44.8633C62.403 57.6865 74.3646 66.9971 88.5 66.9971C94.5277 66.9971 100.159 65.3027 104.946 62.3662C68.2085 89.0386 0.00104011 46.3528 0 35.4971ZM89 26.5C92.8333 26 104.2 25.2 119 26L119.005 26.0088C138.682 27.7146 152 30.9926 152 34.7578C152 38.5483 138.503 41.845 118.608 43.541C119.512 40.6063 120 37.4891 120 34.2578C120 32.8659 119.908 31.4954 119.732 30.1514C113.435 28.8832 100.576 26.1383 89 26.5Z"
    /// Parsed once: absolute M / L / C / Z only (all this path uses).
    private static let path: Path = {
        var p = Path()
        var nums: [CGFloat] = []
        var cmd: Character = " "
        func flush() {
            switch cmd {
            case "M": if nums.count >= 2 { p.move(to: CGPoint(x: nums[0], y: nums[1])) }
            case "L": if nums.count >= 2 { p.addLine(to: CGPoint(x: nums[0], y: nums[1])) }
            case "C": if nums.count >= 6 { p.addCurve(to: CGPoint(x: nums[4], y: nums[5]), control1: CGPoint(x: nums[0], y: nums[1]), control2: CGPoint(x: nums[2], y: nums[3])) }
            case "Z": p.closeSubpath()
            default: break
            }
            nums.removeAll()
        }
        var token = ""
        func endNumber() { if let v = Double(token) { nums.append(CGFloat(v)) }; token = "" }
        for ch in d {
            if "MLCZ".contains(ch) { endNumber(); flush(); cmd = ch }
            else if ch == " " || ch == "," { endNumber() }
            else if ch == "-" { endNumber(); token = "-" }
            else { token.append(ch) }
        }
        endNumber(); flush()
        return p
    }()
    func path(in rect: CGRect) -> Path {
        Self.path.applying(CGAffineTransform(scaleX: rect.width / 152, y: rect.height / 71))
    }
}

/// The splash itself for one frame (drawn over the window's 420 × 296 content; the background runs under the
/// title bar so the bar takes the same colour).
struct MacLaunchSplashView: View {
    let frame: MacSplashFrame
    var timeSeconds: Double = 0
    private let k: CGFloat = 0.8                          // mark scale: 152 × 0.8 ≈ 122 pt wide
    var body: some View {
        let bg = MacSplash.mix(MacSplash.dark, MacSplash.light, frame.bgMix)
        let word = MacSplash.mix((r: 243, g: 234, b: 223), (r: 17, g: 17, b: 17), frame.bgMix)
        let rim = MacSplash.mix((r: 255, g: 242, b: 226), (r: 255, g: 255, b: 255), frame.bgMix)
        ZStack(alignment: .topLeading) {
            (frame.splashClear ? Color.clear : bg).ignoresSafeArea()
            if frame.corona > 0.001 {
                CoronaView(center: CGPoint(x: 220, y: 116), radius: 22, amp: frame.corona, lean: .zero, time: timeSeconds, size: CGSize(width: 420, height: 296))
                    .scaleEffect(frame.coronaScale, anchor: UnitPoint(x: 220.0 / 420, y: 116.0 / 296))
            }
            Circle().fill(Color.white).frame(width: 44, height: 44)
                .shadow(color: GenitaCorona.edge.opacity(0.8), radius: 6)
                .position(x: 220, y: 116).opacity(frame.disc)
            mark(rim: rim)
                .scaleEffect(frame.markScale)
                .position(x: 210, y: 118 + frame.markY).opacity(frame.markOpacity)
            resourceImage("logo").renderingMode(.template).resizable().foregroundStyle(word)
                .frame(width: 76, height: 27.2).position(x: 210, y: 192 + frame.wordY).opacity(frame.wordOpacity)
            if frame.status > 0 {
                Text("Connecting…").font(MacSheetInk.sans(12)).foregroundStyle(Color(white: 140.0 / 255))
                    .frame(width: 420).position(x: 210, y: 232).opacity(frame.status)
            }
        }
        .frame(width: 420, height: 296, alignment: .topLeading)
        .allowsHitTesting(!frame.splashClear)
        .accessibilityElement().accessibilityLabel("Genita").accessibilityIdentifier("macLaunch")
    }

    /// Dark glass A′: ink body, top sheen, warm specular rim (clipped inside the outline), the blue orbit dot.
    private func mark(rim: Color) -> some View {
        let shape = MacBrandmarkShape()
        return ZStack(alignment: .topLeading) {
            ZStack {
                shape.fill(LinearGradient(colors: [Color(white: 28.0 / 255), Color(white: 11.0 / 255)], startPoint: .top, endPoint: .bottom))
                Rectangle().fill(LinearGradient(stops: [.init(color: .white.opacity(0.12), location: 0), .init(color: .white.opacity(0), location: 0.55),
                                                        .init(color: .black.opacity(0.10), location: 1)], startPoint: .top, endPoint: .bottom))
                    .clipShape(shape)
                shape.stroke(LinearGradient(stops: [.init(color: rim.opacity(0.95), location: 0), .init(color: rim.opacity(0.35), location: 0.5),
                                                    .init(color: rim.opacity(0.70), location: 1)], startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 2.2)
                    .clipShape(shape)
            }
            .frame(width: 152, height: 71).offset(x: 6, y: 6)
            if frame.orbitOpacity > 0 {
                Circle().fill(GenitaCorona.accent).frame(width: 4.2, height: 4.2)
                    .position(x: 6 + 88.5 + 66 * cos(frame.orbitAngle), y: 6 + 35.5 + 9 * sin(frame.orbitAngle))
                    .opacity(frame.orbitOpacity)
            }
        }
        .frame(width: 164, height: 83, alignment: .topLeading)
        .scaleEffect(k)
        .rotationEffect(.degrees(-14))
        .frame(width: 164, height: 83)
    }
}

/// The first window's content under the live launch: runs the timeline until the hand-off ends, then gets out of the
/// way. `content` is the first screen (MAC-1 / CS01 / home); it rises in as the splash hands off.
struct MacLaunchHost<Content: View>: View {
    let checking: Bool
    let signedIn: Bool
    @ViewBuilder var content: () -> Content
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var start = Date()
    @State private var answered: Date?
    @State private var skipped: Date?
    @State private var done = false

    /// Debug: `GENITA_SPLASH_AT=<seconds>` freezes one instant (same switch as the iPhone splash), as ms.
    private static var frozenAt: Double? {
        #if DEBUG
        ProcessInfo.processInfo.environment["GENITA_SPLASH_AT"].flatMap { Double($0) }.map { $0 * 1000 }
        #else
        nil
        #endif
    }

    private var handoffMs: Double? {
        guard let answered else { return nil }
        let x = max(MacSplash.minimumMs(signedIn: signedIn), answered.timeIntervalSince(start) * 1000)
        if let skipped { return min(x, skipped.timeIntervalSince(start) * 1000) }
        return x
    }

    var body: some View {
        // One structure for the whole life of the window: the first screen is created as soon as /me answers (so it
        // sees every account / call event) and keeps its identity after the splash ends (open sheets survive);
        // the timeline pauses when the hand-off is over.
        TimelineView(.animation(minimumInterval: nil, paused: done)) { ctx in
            let t = done ? 1e9 : (Self.frozenAt ?? ctx.date.timeIntervalSince(start) * 1000)
            let f = MacSplashFrame.at(t, handoff: handoffMs, reduceMotion: reduceMotion)
            ZStack(alignment: .top) {
                if checking {
                    Color.clear.frame(width: 420, height: 296)
                } else {
                    content().opacity(f.content).offset(y: 8 * (1 - f.content)).allowsHitTesting(f.content > 0.5)
                        .accessibilityHidden(f.content < 0.5)
                }
                if !f.done {
                    MacLaunchSplashView(frame: f, timeSeconds: reduceMotion ? 0 : t / 1000)
                        .contentShape(Rectangle())
                        .onTapGesture { if answered != nil && skipped == nil { skipped = Date() } }
                }
            }
            // the window keeps the splash's 420 × 296 until the colour has turned, then takes the first screen's size
            // (not clipped: the splash background runs up under the title bar; the hidden screen is at opacity 0)
            .frame(height: f.splashClear ? nil : 296, alignment: .top)
            .background { if f.splashClear { MacSheetInk.sheet.ignoresSafeArea() } }
        }
        .onAppear { if !checking && answered == nil { answered = Date() } }
        .onChange(of: checking) { _, now in if !now && answered == nil { answered = Date() } }
        .task(id: handoffMs) {
            // stop the clock once the hand-off has finished (frozen review frames never finish)
            guard Self.frozenAt == nil, let x = handoffMs else { return }
            let end = start.addingTimeInterval((x + MacSplash.handoffMs + 50) / 1000)
            let wait = end.timeIntervalSinceNow
            if wait > 0 { try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000)) }
            if !Task.isCancelled { done = true }
        }
    }
}

#if DEBUG
/// Review renders (watch-shots harness): the launch at t ms with /me answering at `me` ms.
struct MacLaunchReviewFrame<Content: View>: View {
    let t: Double
    let me: Double
    let signedIn: Bool
    @ViewBuilder var content: () -> Content
    var body: some View {
        let x = max(MacSplash.minimumMs(signedIn: signedIn), me)
        let f = MacSplashFrame.at(t, handoff: t >= me ? x : nil, reduceMotion: false)
        ZStack(alignment: .top) {
            if t >= me { content().opacity(f.content).offset(y: 8 * (1 - f.content)) }
            else { Color.clear.frame(width: 420, height: 296) }
            if !f.done { MacLaunchSplashView(frame: f, timeSeconds: t / 1000) }
        }
        .frame(height: f.splashClear ? nil : 296, alignment: .top)
        .background(f.splashClear ? MacSheetInk.sheet : Color.clear)
    }
}
#endif
