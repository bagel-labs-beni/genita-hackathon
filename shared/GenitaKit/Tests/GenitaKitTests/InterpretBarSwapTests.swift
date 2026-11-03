import SwiftUI
import Testing
@testable import GenitaKit

/// ui-deferred: the interpret bar's title/subtitle never crossfade (a fade is the window where the old and the
/// new label are both drawn). It is the S09 push on a spring, or an instant swap under Reduce Motion / review stills.
struct InterpretBarSwapTests {
    @Test func reduceMotionSwapsInstantly() {
        #expect(InterpretBarView.swap(reduceMotion: true) == nil)
    }

    @Test func normalMotionUsesTheStatusLineSpring() {
        guard !GenitaMotion.reviewStill else { return }
        #expect(InterpretBarView.swap(reduceMotion: false) == .spring(duration: 0.3, bounce: 0))
    }

    @Test func everyBarChangeIsANewLineIdentity() {
        // the push keys on the text itself: two states with the same words don't animate, a new state does
        var b = InterpretBoard(companionName: "Jin")
        b.apply(InterpretBoardTests.pair(nil))
        let listening = b.bar
        b.apply(InterpretBoardTests.pair("Korean"))
        #expect(listening.title != b.bar.title)
        #expect(listening.subtitle != b.bar.subtitle)
    }
}
