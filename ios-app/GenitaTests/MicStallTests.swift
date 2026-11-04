import XCTest
@testable import Genita

/// DEMO P0 11/4 (TF 331): after the first reply the user's voice stopped reaching the server while the pill said
/// Listening, and turning the mic off and on did not bring it back. The call's mic now notices an input tap that went
/// quiet and rebuilds it.
final class MicStallTests: XCTestCase {
    func testATapThatKeepsDeliveringIsHealthy() {
        XCTAssertFalse(MicStall.stalled(now: 100, lastBuffer: 99.98, since: 50))
    }

    func testATapSilentPastTheThresholdIsStalled() {
        // the second turn: the mic is on, the tap last delivered 2 s ago
        XCTAssertTrue(MicStall.stalled(now: 100, lastBuffer: 98, since: 50))
    }

    func testAJustOpenedOrRebuiltInputGetsTimeForItsFirstBuffer() {
        XCTAssertFalse(MicStall.stalled(now: 100, lastBuffer: nil, since: 99.5), "rebuilt 0.5 s ago")
        XCTAssertFalse(MicStall.stalled(now: 100, lastBuffer: 90, since: 99.5), "an older buffer is from the engine before")
        XCTAssertTrue(MicStall.stalled(now: 100, lastBuffer: nil, since: 98), "rebuilt 2 s ago and nothing yet")
    }

    func testReopeningAnInputThatNeverDeliveredRebuildsIt() {
        // openMic's check: no grace (`since` -inf) — an engine kept with the mic that has gone quiet is replaced
        XCTAssertTrue(MicStall.stalled(now: 100, lastBuffer: nil, since: -.infinity))
        XCTAssertTrue(MicStall.stalled(now: 100, lastBuffer: 97, since: -.infinity))
        XCTAssertFalse(MicStall.stalled(now: 100, lastBuffer: 99.9, since: -.infinity))
    }
}
