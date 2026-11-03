import Foundation
import Testing
@testable import GenitaKit

/// Chelsea 11/3: "the splash goes by too fast". On screen from its own first frame: A′ 2.6 s, Reduce Motion
/// 1.2 s (0.3 in, hold, 0.35 crossfade), signed-in relaunch 0.6 s; never under 1.2 s except the short relaunch.
@Suite struct SplashTimingTests {
    @Test func onScreenDurations() {
        #expect(abs(GenitaSplash.onScreen(mode: .full, reduceMotion: false) - 2.6) < 0.0001)
        #expect(abs(GenitaSplash.onScreen(mode: .full, reduceMotion: true) - 1.2) < 0.0001)
        #expect(abs(GenitaSplash.onScreen(mode: .short, reduceMotion: false) - 0.6) < 0.0001)
        #expect(abs(GenitaSplash.onScreen(mode: .short, reduceMotion: true) - 0.6) < 0.0001)
    }
    @Test func firstLaunchIsNeverUnderTheMinimum() {
        for calm in [false, true] { #expect(GenitaSplash.onScreen(mode: .full, reduceMotion: calm) >= GenitaSplash.minimumOnScreen - 0.0001) }
        #expect(GenitaSplash.calmStill.fadeIn == 0.3 && GenitaSplash.calmStill.out == 0.35)
        #expect(GenitaSplash.shortStill.out == 0.35)
    }
}
