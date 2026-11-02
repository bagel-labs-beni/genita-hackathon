import SwiftUI
#if os(iOS)
import CoreMotion
import UIKit
#elseif os(macOS)
import AppKit
#endif

/// Colours of the B+ backlight (motion page, dark theme). Change here only.
public enum GenitaLight {
    public static let field = Color(red: 7 / 255, green: 7 / 255, blue: 7 / 255)        // #070707 launch + A02
    public static let body = Color(red: 6 / 255, green: 7 / 255, blue: 8 / 255)         // #060708 mark body
    public static let figure = Color(red: 3 / 255, green: 3 / 255, blue: 4 / 255)       // #030304 silhouette
    public static let glint = Color(red: 191 / 255, green: 231 / 255, blue: 255 / 255)  // #BFE7FF rim / outline
    public static let accent = Color(red: 0, green: 162 / 255, blue: 1)                 // #00A2FF orbit dot
    public static let mote = Color(red: 230 / 255, green: 246 / 255, blue: 255 / 255)   // #E6F6FF light motes
}

/// The light behind the mark / the silhouette: a radial glow (glint → accent 10 % → clear) and faint rays
/// (repeating conic, one turn per 140 s). `intensity` 0…1+ (Apple-tap beat goes to 1.6).
public struct GenitaBacklight: View {
    public var intensity: Double
    public var time: Double
    public init(intensity: Double, time: Double) {
        self.intensity = intensity
        self.time = time
    }
    public var body: some View {
        GeometryReader { g in
            let d = min(g.size.width, g.size.height)
            ZStack {
                Circle()
                    .fill(AngularGradient(stops: Self.rayStops, center: .center))
                    .frame(width: d * 1.5, height: d * 1.5)
                    .mask(RadialGradient(colors: [.white, .white.opacity(0)], center: .center, startRadius: d * 0.12, endRadius: d * 0.75))
                    .rotationEffect(.degrees(time / 140 * 360))
                    .opacity(0.18 * min(intensity, 1.3))
                Circle()
                    .fill(RadialGradient(stops: [
                        .init(color: Color(red: 242 / 255, green: 250 / 255, blue: 1).opacity(0.95), location: 0),
                        .init(color: Color(red: 206 / 255, green: 237 / 255, blue: 1).opacity(0.66), location: 0.16),
                        .init(color: Color(red: 128 / 255, green: 208 / 255, blue: 1).opacity(0.30), location: 0.40),
                        .init(color: GenitaLight.accent.opacity(0.10), location: 0.66),
                        .init(color: GenitaLight.accent.opacity(0), location: 1),
                    ], center: .center, startRadius: 0, endRadius: d / 2))
                    .frame(width: d, height: d)
                    .opacity(min(1, 0.82 * intensity))
                    .brightness(max(0, intensity - 1) * 0.25)
            }
            .frame(width: g.size.width, height: g.size.height)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// repeating-conic-gradient(from 8deg, clear 0, .42 at 2°, clear 5°, clear 13°)
    static let rayStops: [Gradient.Stop] = {
        let ray = Color(red: 214 / 255, green: 240 / 255, blue: 1)
        var stops: [Gradient.Stop] = []
        var a = 8.0
        while a < 368 {
            for (da, o) in [(0.0, 0.0), (2.0, 0.42), (5.0, 0.0)] {
                let loc = (a + da - 8) / 360
                if loc <= 1 { stops.append(.init(color: ray.opacity(o), location: loc)) }
            }
            a += 13
        }
        return stops
    }()
}

/// Tilt / pointer → a lean of −1…1 per axis (motion page: ±0.35 rad → ±1). iPhone uses device motion,
/// Mac the pointer over the view (`onContinuousHover`). Off for Reduce Motion and UI tests.
final class GenitaLeanSource {
    #if os(iOS)
    private let motion = CMMotionManager()
    #endif
    func start(_ update: @escaping (CGSize) -> Void) {
        #if os(iOS)
        guard motion.isDeviceMotionAvailable, !motion.isDeviceMotionActive, !GenitaMotion.reviewStill else { return }
        motion.deviceMotionUpdateInterval = 1 / 60
        motion.startDeviceMotionUpdates(to: .main) { data, _ in
            guard let a = data?.attitude else { return }
            update(CGSize(width: max(-1, min(1, a.roll / 0.35)), height: max(-1, min(1, (a.pitch - 0.6) / 0.35))))
        }
        #endif
    }
    func stop() {
        #if os(iOS)
        if motion.isDeviceMotionActive { motion.stopDeviceMotionUpdates() }
        #endif
    }
}

enum GenitaHaptic {
    /// soft = splash light peak, light = Apple tap
    static func impact(soft: Bool, intensity: CGFloat) {
        #if os(iOS)
        UIImpactFeedbackGenerator(style: soft ? .soft : .light).impactOccurred(intensity: intensity)
        #endif
    }
}

/// An image from the app bundle's Resources (PNG), cross-platform.
func genitaBundleImage(_ name: String) -> Image? {
    guard let url = Bundle.main.url(forResource: name, withExtension: "png") else { return nil }
    #if os(iOS)
    return UIImage(contentsOfFile: url.path).map { Image(uiImage: $0) }
    #elseif os(macOS)
    return NSImage(contentsOf: url).map { Image(nsImage: $0) }
    #else
    return nil
    #endif
}
