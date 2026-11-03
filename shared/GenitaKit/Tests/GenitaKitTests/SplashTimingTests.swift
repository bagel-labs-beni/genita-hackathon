import Foundation
import Testing
@testable import GenitaKit

/// Chelsea 11/3 "the splash goes by too fast" → 춘식이 11/4 spec. On screen from its own first frame:
/// A′ 3.3 s (still hold 1.9–2.5 s, hand-off 2.5–3.3 s), Reduce Motion 1.5 s, signed-in relaunch 0.9 s.
@Suite struct SplashTimingTests {
    @Test func onScreenDurations() {
        #expect(abs(GenitaSplash.onScreen(mode: .full, reduceMotion: false) - 3.3) < 0.0001)
        #expect(abs(GenitaSplash.onScreen(mode: .full, reduceMotion: true) - 1.5) < 0.0001)
        #expect(abs(GenitaSplash.onScreen(mode: .short, reduceMotion: false) - 0.9) < 0.0001)
        #expect(abs(GenitaSplash.onScreen(mode: .short, reduceMotion: true) - 0.9) < 0.0001)
    }
    @Test func theFinishedMarkHoldsBeforeTheHandOff() {
        // haptic at 1.9 s, then 600 ms still before the hand-off
        #expect(abs((GenitaSplash.handoffAt - GenitaSplash.hapticAt) - 0.6) < 0.0001)
        #expect(GenitaSplash.shortStill == GenitaSplash.Still(fadeIn: 0.2, outAt: 0.55, out: 0.35))
        #expect(GenitaSplash.calmStill == GenitaSplash.Still(fadeIn: 0.3, outAt: 1.1, out: 0.4))
    }
}
