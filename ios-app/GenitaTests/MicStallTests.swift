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

    /// iOS P0 (TF 341): the first reply on the speaker changes the route; the rebuild right after it saw a 0 Hz input
    /// and the old handler turned the mic off silently (pill: Listening, uplink: nothing, mic watch: stopped).
    func testAnEngineChangeNeverTurnsTheUsersMicOff() {
        XCTAssertTrue(MicStall.rebuildWithMic(micOpen: true, engineHasMic: false), "mic on, engine lost it: rebuild with the mic")
        XCTAssertTrue(MicStall.rebuildWithMic(micOpen: true, engineHasMic: true))
        XCTAssertTrue(MicStall.rebuildWithMic(micOpen: false, engineHasMic: true), "a mic engine kept for playback stays one")
        XCTAssertFalse(MicStall.rebuildWithMic(micOpen: false, engineHasMic: false))
    }

    func testAnEngineWithNoMicIsRebuiltEverySecondOnceTheReplyIsDone() {
        XCTAssertFalse(MicStall.mayHeal(now: 10, lastHeal: 0, heals: 0, engineHasMic: false, queuedBuffers: 12), "never over a queued reply")
        XCTAssertTrue(MicStall.mayHeal(now: 10, lastHeal: 8.9, heals: 1, engineHasMic: false, queuedBuffers: 0))
        XCTAssertFalse(MicStall.mayHeal(now: 10, lastHeal: 9.5, heals: 1, engineHasMic: false, queuedBuffers: 0))
        XCTAssertFalse(MicStall.mayHeal(now: 10, lastHeal: 8, heals: 6, engineHasMic: false, queuedBuffers: 0), "after 5 tries it backs off")
    }

    func testAQuietTapWaitsForTheReplyToFinish() {
        XCTAssertFalse(MicStall.mayHeal(now: 100, lastHeal: 0, heals: 0, engineHasMic: true, queuedBuffers: 3))
        XCTAssertTrue(MicStall.mayHeal(now: 100, lastHeal: 0, heals: 0, engineHasMic: true, queuedBuffers: 0))
        XCTAssertFalse(MicStall.mayHeal(now: 100, lastHeal: 98, heals: 1, engineHasMic: true, queuedBuffers: 0))
    }

    // MARK: TF 351 — our own voice-processing build posted a configuration change that rebuilt again (7 in 3 s)

    private func change(now: TimeInterval = 10, lastBuild: TimeInterval = 9.6, wantMic: Bool = true, hasMic: Bool = true,
                        builtIn: Double = 48_000, nowIn: Double = 48_000, builtOut: Double = 48_000, nowOut: Double = 48_000,
                        running: Bool = true, recent: Int = 0) -> MicStall.ConfigAction {
        MicStall.onConfigChange(now: now, lastBuild: lastBuild, wantMic: wantMic, hasMic: hasMic, builtIn: builtIn, nowIn: nowIn,
                                builtOut: builtOut, nowOut: nowOut, running: running, recentRebuilds: recent)
    }

    func testAChangeRightAfterOurOwnBuildWaitsForTheWindowToPass() {
        guard case let .wait(s) = change(now: 10, lastBuild: 9.6) else { return XCTFail("rebuilt inside the window") }
        XCTAssertEqual(s, 0.35, accuracy: 0.001)
    }

    func testAChangeThatLeftTheFormatsAsBuiltNeverRebuilds() {
        XCTAssertEqual(change(lastBuild: 0, running: true), .keep, "the self-induced change of the TF 351 loop")
        XCTAssertEqual(change(lastBuild: 0, running: false), .restart, "stopped by the change: start it again in place")
    }

    func testARealRouteOrFormatChangeRebuilds() {
        XCTAssertEqual(change(lastBuild: 0, nowOut: 44_100), .rebuild, "speaker 48 → 44.1 kHz")
        XCTAssertEqual(change(lastBuild: 0, nowIn: 0), .rebuild, "the mic reads 0 Hz")
        XCTAssertEqual(change(lastBuild: 0, wantMic: true, hasMic: false, builtIn: 0, nowIn: 0), .rebuild, "the mic is on, the engine has none")
    }

    func testConfigRebuildsAreCappedPerFiveSeconds() {
        XCTAssertEqual(change(lastBuild: 0, nowOut: 44_100, recent: 3), .keep)
        XCTAssertEqual(change(lastBuild: 0, nowOut: 44_100, running: false, recent: 3), .restart)
    }

    func testAMicThatGivesOnlyDigitalSilenceAfterABuildIsCaught() {
        XCTAssertFalse(MicStall.silentSinceBuild(now: 10.5, lastNonZero: nil, since: 10), "it gets 1 s")
        XCTAssertTrue(MicStall.silentSinceBuild(now: 11.2, lastNonZero: nil, since: 10))
        XCTAssertTrue(MicStall.silentSinceBuild(now: 11.2, lastNonZero: 9.9, since: 10), "a sample from the engine before does not count")
        XCTAssertFalse(MicStall.silentSinceBuild(now: 11.2, lastNonZero: 10.3, since: 10))
    }
}
