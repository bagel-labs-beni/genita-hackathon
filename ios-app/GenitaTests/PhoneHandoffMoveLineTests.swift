import XCTest
@testable import Genita

/// MV-E: "Mac not responding. Still here." is the call's status line for 3 s, then it clears itself.
@MainActor final class PhoneHandoffMoveLineTests: XCTestCase {
    func testMoveFailedLineClearsItselfAfterThreeSeconds() async throws {
        let handoff = PhoneHandoff.shared
        handoff.moveFailed = true
        XCTAssertTrue(handoff.moveFailed)
        try await Task.sleep(for: .milliseconds(2500))
        XCTAssertTrue(handoff.moveFailed, "still up before 3 s")
        for _ in 0..<40 where handoff.moveFailed { try await Task.sleep(for: .milliseconds(100)) }
        XCTAssertFalse(handoff.moveFailed, "gone after 3 s")
    }

    /// CRASH-1 / MOVE-2: P01's pull down closes on a long or flicked pull, never on a slider drag or a nudge.
    func testPairingSheetPullClosesOnlyOnADownwardPull() {
        XCTAssertTrue(PairingSheetPull.closes(translation: 200, predicted: 260), "QA's 500→700 drag")
        XCTAssertTrue(PairingSheetPull.closes(translation: 40, predicted: 300), "a flick")
        XCTAssertFalse(PairingSheetPull.closes(translation: 30, predicted: 60), "a nudge springs back")
        XCTAssertTrue(PairingSheetPull.vertical(CGSize(width: 10, height: 200)))
        XCTAssertFalse(PairingSheetPull.vertical(CGSize(width: 120, height: 40)), "P02's Adjust sliders")
    }
    /// Closing drops a half-entered code and leaves the call alone (MOVE-2: Cancel / outside tap / pull down).
    func testClosePairingDropsTheHalfCode() {
        let handoff = PhoneHandoff.shared
        handoff.code = "48"; handoff.settings = true; handoff.pairingFailed = true
        handoff.closePairing()
        XCTAssertFalse(handoff.settings)
        XCTAssertEqual(handoff.code, "")
        XCTAssertFalse(handoff.pairingFailed)
    }
}
