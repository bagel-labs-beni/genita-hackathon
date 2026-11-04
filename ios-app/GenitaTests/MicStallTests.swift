import AVFoundation
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

    func testHealsThatBringNothingBackOff() {
        XCTAssertEqual(MicStall.gap(afterHeals: 0), 3)
        XCTAssertEqual(MicStall.gap(afterHeals: 1), 3)
        XCTAssertEqual(MicStall.gap(afterHeals: 2), 6)
        XCTAssertEqual(MicStall.gap(afterHeals: 3), 12)
        XCTAssertEqual(MicStall.gap(afterHeals: 9), 30)
    }

    /// Mac 331 16:06:57: mic 48 kHz (9 ch under VP), speaker 44.1 kHz → AUVoiceProcessor -10875. The speaker leg runs at
    /// the mic's rate so the VP unit's client-side input and output match.
    func testVoiceProcessingOutputRunsAtTheMicRate() throws {
        let mac = try XCTUnwrap(CallAudio.vpOutputFormat(micRate: 48_000, outputChannels: 2))
        XCTAssertEqual(mac.sampleRate, 48_000)
        XCTAssertEqual(mac.channelCount, 2)
        let phone = try XCTUnwrap(CallAudio.vpOutputFormat(micRate: 24_000, outputChannels: 0))
        XCTAssertEqual(phone.sampleRate, 24_000)
        XCTAssertEqual(phone.channelCount, 1)
        XCTAssertEqual(CallAudio.vpOutputFormat(micRate: 0, outputChannels: 2)?.sampleRate, nil, "no mic: the default wiring")
        XCTAssertEqual(CallAudio.vpOutputFormat(micRate: 48_000, outputChannels: 9)?.channelCount, 2)
    }
}
