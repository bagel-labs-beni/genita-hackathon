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
}
