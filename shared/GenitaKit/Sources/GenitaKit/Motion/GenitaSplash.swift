import SwiftUI
#if os(iOS)
import CoreMotion
import UIKit
#endif

/// Launch splash, variant B "Orbit" (Chelsea's pick, 11/2): on a dark field the brandmark's eye outline draws
/// itself and the orbit line sweeps through; a light rises from behind the mark until it stands as a
/// silhouette with a rim glow around its edges (light haptic at the peak); then the light floods out and
/// carries into the first screen (A02's bright backdrop). ≤ 1.6 s, tap/click skips. Tilt (iPhone), finger or
/// pointer shifts where the light sits, so the rim moves around the mark. Reduce Motion: the finished frame,
/// still, 0.5 s, then a fade. UI tests skip it unless `--splash-demo`.
/// Times live in `Timing`; colours in the initialiser — match design/publish/motion when it changes.
public struct GenitaSplash: View {
    public struct Timing: Sendable {
        public var eyeDraw = 0.55
        public var orbitAt = 0.28
        public var orbit = 0.45
        public var lightAt = 0.32
        /// the light peaks here (haptic)
        public var lightPeak = 0.85
        public var fillAt = 0.5
        public var fill = 0.32
        /// auto wake (exit start); exit lasts `exit` → first screen at wakeAt + exit ≤ 1.6 s
        public var wakeAt = 1.2
        public var exit = 0.38
        public static let standard = Timing()
    }

    var timing: Timing
    var field: Color
    var ink: Color
    var light: Color
    var onFinished: () -> Void

    @State private var start: Date?
    @State private var exiting = false
    @State private var gone = false
    @State private var lean = CGSize.zero // −1…1 each axis
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    #if os(iOS)
    @State private var motion = CMMotionManager()
    #endif
    /// built once per splash (not per frame)
    private let timeline: KeyframeTimeline<Frame>

    public init(timing: Timing = .standard,
                field: Color = Color(red: 10 / 255, green: 10 / 255, blue: 11 / 255),
                ink: Color = Color(red: 14 / 255, green: 14 / 255, blue: 15 / 255),
                light: Color = Color(red: 1, green: 0.972, blue: 0.93),
                onFinished: @escaping () -> Void) {
        self.timing = timing
        self.field = field
        self.ink = ink
        self.light = light
        self.onFinished = onFinished
        self.timeline = Self.makeTimeline(timing)
    }

    struct Frame {
        var eye = 0.0     // outline trim of the eye/G
        var orbit = 0.0   // trim of the orbit line
        var stroke = 1.0  // outline opacity
        var fill = 0.0    // silhouette fill
        var light = 0.0   // backlight strength (0…1, peaks at lightPeak)
        var rise = 1.0    // backlight position: 1 = below the mark, 0 = centred behind it
        static let finished = Frame(eye: 1, orbit: 1, stroke: 0, fill: 1, light: 0.8, rise: 0)
    }

    private static func makeTimeline(_ t: Timing) -> KeyframeTimeline<Frame> {
        KeyframeTimeline(initialValue: Frame()) {
            KeyframeTrack(\.eye) { CubicKeyframe(1, duration: t.eyeDraw) }
            KeyframeTrack(\.orbit) {
                LinearKeyframe(0, duration: t.orbitAt)
                CubicKeyframe(1, duration: t.orbit)
            }
            KeyframeTrack(\.stroke) {
                LinearKeyframe(1, duration: t.fillAt + t.fill * 0.6)
                CubicKeyframe(0, duration: 0.22)
            }
            KeyframeTrack(\.fill) {
                LinearKeyframe(0, duration: t.fillAt)
                CubicKeyframe(1, duration: t.fill)
            }
            KeyframeTrack(\.light) {
                LinearKeyframe(0, duration: t.lightAt)
                CubicKeyframe(1, duration: t.lightPeak - t.lightAt)
                SpringKeyframe(0.8, duration: 0.35, spring: .smooth)
            }
            KeyframeTrack(\.rise) {
                LinearKeyframe(1, duration: t.lightAt)
                SpringKeyframe(0, duration: t.lightPeak - t.lightAt + 0.1, spring: .bouncy(duration: 0.6, extraBounce: 0.05))
            }
        }
    }

    public var body: some View {
        GeometryReader { g in
            let markWidth = min(g.size.width * 0.42, 220)
            ZStack {
                field
                if reduceMotion {
                    stage(.finished, width: markWidth)
                } else {
                    // seekable keyframes: the same timeline renders live, or frozen at GENITA_SPLASH_AT (review shots)
                    TimelineView(.animation(paused: start == nil || Self.frozenAt != nil || exiting)) { ctx in
                        let t = Self.frozenAt ?? start.map { ctx.date.timeIntervalSince($0) } ?? 0
                        stage(timeline.value(time: t), width: markWidth)
                    }
                }
                // the light floods out and carries into the first screen
                light.opacity(exiting ? 1 : 0)
            }
            .frame(width: g.size.width, height: g.size.height)
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { v in follow(v.location, in: g.size) }
                .onEnded { v in
                    // a tap (little movement) wakes the app; a drag just moves the light
                    if hypot(v.translation.width, v.translation.height) < 12 { wake() } else { follow(nil, in: g.size) }
                })
            #if os(macOS)
            .onContinuousHover { phase in
                if case let .active(p) = phase { follow(p, in: g.size) } else { follow(nil, in: g.size) }
            }
            #endif
        }
        .ignoresSafeArea()
        .opacity(gone ? 0 : 1)
        .accessibilityElement()
        .accessibilityLabel("Genita")
        .accessibilityHint("Tap to start")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { wake() }
        .accessibilityIdentifier("splash")
        .task { await run() }
        .onDisappear { stopTilt() }
    }

    /// DEBUG review shots: `GENITA_SPLASH_AT=0.4` renders that instant, still, and never auto-wakes (tap still does).
    static var frozenAt: Double? {
        #if DEBUG
        ProcessInfo.processInfo.environment["GENITA_SPLASH_AT"].flatMap(Double.init)
        #else
        nil
        #endif
    }

    @ViewBuilder private func stage(_ f: Frame, width: CGFloat) -> some View {
        let height = width * BrandMarkShape.size.height / BrandMarkShape.size.width
        // where the light sits: rises from below, then follows the tilt / finger
        let lightOffset = CGSize(width: lean.width * width * 0.22, height: f.rise * width * 0.9 + lean.height * width * 0.16)
        ZStack {
            // backlight: a warm bloom behind the mark
            RadialGradient(colors: [light.opacity(0.95), light.opacity(0.35), light.opacity(0)], center: .center, startRadius: 0, endRadius: width * 0.75)
                .frame(width: width * 1.8, height: width * 1.8)
                .scaleEffect(0.6 + 0.4 * f.light)
                .opacity(f.light)
                .offset(lightOffset)
                .blur(radius: 6)
            // rim: the mark's own shape, lit and blurred, peeking out around its edges (opposite the light)
            BrandMarkShape().fill(light)
                .frame(width: width, height: height)
                .scaleEffect(1.035)
                .blur(radius: 5)
                .opacity(f.light * f.fill)
                .offset(x: -lightOffset.width * 0.03, y: -lightOffset.height * 0.03)
            ZStack {
                BrandMarkShape().fill(ink).opacity(f.fill)
                BrandMarkShape(part: .eye).trim(from: 0, to: f.eye)
                    .stroke(light.opacity(0.92), style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
                    .opacity(f.stroke)
                BrandMarkShape(part: .orbit).trim(from: 0, to: f.orbit)
                    .stroke(light, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
                    .opacity(f.stroke)
            }
            .frame(width: width, height: height)
            .offset(x: lean.width * 4, y: lean.height * 4)
            .rotation3DEffect(.degrees(Double(lean.width) * 6), axis: (x: 0, y: 1, z: 0), perspective: 0.6)
            .rotation3DEffect(.degrees(Double(-lean.height) * 6), axis: (x: 1, y: 0, z: 0), perspective: 0.6)
        }
        .scaleEffect(exiting ? 1.12 : 1)
    }

    // MARK: timing

    @MainActor private func run() async {
        if reduceMotion {
            try? await Task.sleep(for: .milliseconds(500))
            wake()
            return
        }
        start = Date()
        if Self.frozenAt != nil { return } // review shot: hold the frame until tapped
        startTilt()
        #if os(iOS)
        let haptic = UIImpactFeedbackGenerator(style: .soft)
        haptic.prepare()
        try? await Task.sleep(for: .milliseconds(Int(timing.lightPeak * 1000)))
        if !exiting { haptic.impactOccurred(intensity: 0.8) } // the light peaks
        try? await Task.sleep(for: .milliseconds(Int((timing.wakeAt - timing.lightPeak) * 1000)))
        #else
        try? await Task.sleep(for: .milliseconds(Int(timing.wakeAt * 1000)))
        #endif
        wake()
    }

    @MainActor private func wake() {
        guard !exiting, !gone else { return }
        stopTilt()
        if reduceMotion {
            withAnimation(.easeOut(duration: 0.25)) { gone = true }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { onFinished() }
            return
        }
        // flood with light (first half), then let the first screen through (second half)
        withAnimation(.easeIn(duration: timing.exit * 0.45)) { exiting = true }
        withAnimation(.easeOut(duration: timing.exit * 0.55).delay(timing.exit * 0.45)) { gone = true }
        DispatchQueue.main.asyncAfter(deadline: .now() + timing.exit) { onFinished() }
    }

    // MARK: lean (tilt, finger, pointer)

    private func follow(_ point: CGPoint?, in size: CGSize) {
        guard !reduceMotion, !exiting else { return }
        let target: CGSize = point.map {
            CGSize(width: max(-1, min(1, ($0.x - size.width / 2) / (size.width / 2))),
                   height: max(-1, min(1, ($0.y - size.height / 2) / (size.height / 2))))
        } ?? .zero
        withAnimation(.interactiveSpring(response: 0.3, dampingFraction: 0.8)) { lean = target }
    }

    private func startTilt() {
        #if os(iOS)
        guard motion.isDeviceMotionAvailable, !GenitaMotion.reviewStill else { return }
        motion.deviceMotionUpdateInterval = 1 / 60
        motion.startDeviceMotionUpdates(to: .main) { data, _ in
            guard let a = data?.attitude else { return }
            let x = max(-1, min(1, a.roll / 0.35)), y = max(-1, min(1, (a.pitch - 0.6) / 0.35))
            MainActor.assumeIsolated { // delivered on the main queue
                guard !exiting else { return }
                withAnimation(.interactiveSpring(response: 0.35, dampingFraction: 0.85)) { lean = CGSize(width: x, height: y) }
            }
        }
        #endif
    }

    private func stopTilt() {
        #if os(iOS)
        if motion.isDeviceMotionActive { motion.stopDeviceMotionUpdates() }
        #endif
    }

    /// Show at launch? Not in UI tests / review screenshots (unless `--splash-demo`), not for the handoff demo.
    public static var shouldShowAtLaunch: Bool {
        let p = ProcessInfo.processInfo
        if p.arguments.contains("--splash-demo") { return true }
        if p.arguments.contains("--uitesting") || p.arguments.contains("--handoff-demo") { return false }
        #if DEBUG
        if p.environment["GENITA_REVIEW_STAGE"] != nil || p.environment["GENITA_REVIEW_STILL"] == "1" { return false }
        #endif
        return true
    }
}

struct SplashOverlayModifier: ViewModifier {
    var enabled: Bool
    @State private var visible = GenitaSplash.shouldShowAtLaunch
    @State private var shownAt = Date()
    @State private var elapsedMs: Int?
    func body(content: Content) -> some View {
        content.overlay {
            if enabled && visible {
                GenitaSplash {
                    elapsedMs = Int(Date().timeIntervalSince(shownAt) * 1000)
                    visible = false
                }
            }
        }
        #if DEBUG
        // UI test reads how long the splash held the first screen (≤ 1600 ms)
        .overlay(alignment: .topLeading) {
            if let elapsedMs {
                Color.clear.frame(width: 1, height: 1).accessibilityElement().accessibilityLabel("\(elapsedMs)").accessibilityIdentifier("splashElapsedMs")
            }
        }
        #endif
    }
}

public extension View {
    /// Launch splash over this (root) view, once per launch / window. The view underneath renders at once,
    /// so waking reveals a ready first screen.
    func genitaSplash(_ enabled: Bool = true) -> some View { modifier(SplashOverlayModifier(enabled: enabled)) }
}
