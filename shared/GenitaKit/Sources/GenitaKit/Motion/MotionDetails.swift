import SwiftUI

/// 춘식이's motion details r02 (`_qa-scripts/genita-splash/motion/index.html`, cards 1–10): the timings,
/// curves and haptics those cards spec, in one place. Screens keep their own layout; these only add motion.
///
/// Rollback: app-config flag `motionDetails` (default ON). Off → every detail falls back to the screen's
/// previous look (no new motion, no new haptics). Reduce Motion and UI tests (`GenitaMotion.reviewStill`)
/// always get the static / fade version.
public enum MotionDetails {
    /// Rollback switch (`/v1/app-config` flags.motionDetails = false turns the details off without a build).
    @MainActor public static var enabled: Bool { GenitaAppConfigStore.shared.config.flag("motionDetails", default: true) }

    /// true when a detail should play at full motion: flag on, no Reduce Motion, not a UI test / review still.
    @MainActor public static func live(reduceMotion: Bool) -> Bool { enabled && !reduceMotion && !GenitaMotion.reviewStill }

    /// Cards 8 and 10: ease-out (0.16, 1, 0.3, 1).
    public static func easeOutExpo(_ duration: Double) -> Animation { .timingCurve(0.16, 1, 0.3, 1, duration: duration) }
}
