import SwiftUI
#if os(iOS)
import CoreMotion
import UIKit
#elseif os(macOS)
import AppKit
#endif

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
