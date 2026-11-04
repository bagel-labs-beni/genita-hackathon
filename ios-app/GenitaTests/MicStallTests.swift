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
                        running: Bool = true, recent: Int = 0, vp: Bool = true, stopped: Bool = false) -> MicStall.ConfigAction {
        MicStall.onConfigChange(now: now, lastBuild: lastBuild, wantMic: wantMic, hasMic: hasMic, builtIn: builtIn, nowIn: nowIn,
                                builtOut: builtOut, nowOut: nowOut, running: running, recentRebuilds: recent,
                                voiceProcessing: vp, stoppedWithQueue: stopped)
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
        // the cap holds back rebuilds whose formats are as built (the TF 351 self-induced loop), not real format changes
        XCTAssertEqual(change(lastBuild: 0, wantMic: true, hasMic: false, builtIn: 0, nowIn: 0, recent: 3), .keep)
        XCTAssertEqual(change(lastBuild: 0, wantMic: true, hasMic: false, builtIn: 0, nowIn: 0, running: false, recent: 3), .restart)
    }

    // MARK: b14 — AirPods: no sound at all after the route moved (the capped change restarted into the old format)

    private let speaker = MicStall.Hardware(inRate: 48_000, inChannels: 1, outRate: 48_000, outChannels: 2,
                                            route: "in=MicrophoneBuiltIn out=Speaker")
    private let airPodsHFP = MicStall.Hardware(inRate: 16_000, inChannels: 1, outRate: 16_000, outChannels: 1,
                                               route: "in=BluetoothHFP out=BluetoothHFP")

    private func route(from built: MicStall.Hardware, to now: MicStall.Hardware, lastBuild: TimeInterval = 0, recent: Int = 0,
                       running: Bool = false) -> MicStall.ConfigAction {
        MicStall.onConfigChange(now: 10, lastBuild: lastBuild, wantMic: true, hasMic: true, builtIn: built.inRate, nowIn: now.inRate,
                                builtOut: built.outRate, nowOut: now.outRate, running: running, recentRebuilds: recent,
                                built: built, current: now)
    }

    func testARouteChangeToANewRateAlwaysRebuilds() {
        XCTAssertEqual(route(from: speaker, to: airPodsHFP), .rebuild, "AirPods mid-call: 48 → 16 kHz")
        XCTAssertEqual(route(from: speaker, to: airPodsHFP, recent: 3), .rebuild, "past the self-induced cap it still rebuilds")
        XCTAssertEqual(route(from: speaker, to: airPodsHFP, lastBuild: 9.8), .rebuild, "not held in the 750 ms window")
        XCTAssertEqual(route(from: speaker, to: airPodsHFP, running: true), .rebuild)
        XCTAssertEqual(route(from: airPodsHFP, to: speaker), .rebuild, "AirPods taken out")
    }

    func testANewRouteAtTheSameRateOrOnlyNewChannelsRebuildsToo() {
        var wideband = airPodsHFP
        wideband.inRate = 24_000; wideband.outRate = 24_000
        var speaker24 = speaker
        speaker24.inRate = 24_000; speaker24.outRate = 24_000
        XCTAssertEqual(route(from: speaker24, to: wideband), .rebuild, "speaker 24 kHz → HFP wide-band 24 kHz: the port moved")
        var mono = speaker
        mono.outChannels = 1
        XCTAssertEqual(route(from: speaker, to: mono, recent: 3), .rebuild, "2 → 1 output channels")
    }

    func testAFlappingRouteWaitsThenStillRebuilds() {
        XCTAssertEqual(route(from: speaker, to: airPodsHFP, recent: MicStall.maxHardwareRebuilds), .wait(MicStall.hardwareStormWaitS))
    }

    func testOurOwnBuildsChangeIsStillCoalescedAndATransientZeroIsNotARouteChange() {
        guard case .wait = route(from: speaker, to: speaker, lastBuild: 9.8) else { return XCTFail("self-induced change rebuilt") }
        XCTAssertFalse(MicStall.hardwareChanged(built: speaker, now: .init(inRate: 0, inChannels: 0, outRate: 48_000, outChannels: 2,
                                                                          route: speaker.route)))
        XCTAssertTrue(MicStall.hardwareChanged(built: speaker, now: airPodsHFP))
    }

    func testThePlaybackWatchdogFiresAfter800msAndBacksOff() {
        XCTAssertFalse(MicStall.playbackStalled(now: 10.7, lastProgress: 10, lastRecover: -.infinity, recoveries: 0))
        XCTAssertTrue(MicStall.playbackStalled(now: 10.8, lastProgress: 10, lastRecover: -.infinity, recoveries: 0))
        XCTAssertFalse(MicStall.playbackStalled(now: 11, lastProgress: 10, lastRecover: 10.5, recoveries: 2), "1.6 s after 2 tries")
        XCTAssertTrue(MicStall.playbackStalled(now: 12.2, lastProgress: 10, lastRecover: 10.5, recoveries: 2))
        XCTAssertFalse(MicStall.playbackStalled(now: 14, lastProgress: 10, lastRecover: 10, recoveries: 10), "at most every 5 s")
    }

    func testTheMicWatchdogFiresAfterTwoSecondsOfNoUplink() {
        XCTAssertFalse(MicStall.uplinkStalled(now: 11.9, lastProgress: 10, lastRecover: -.infinity, recoveries: 0))
        XCTAssertTrue(MicStall.uplinkStalled(now: 12, lastProgress: 10, lastRecover: -.infinity, recoveries: 0))
        XCTAssertFalse(MicStall.uplinkStalled(now: 13, lastProgress: 10, lastRecover: 10, recoveries: 2), "4 s after 2 tries")
        XCTAssertTrue(MicStall.uplinkStalled(now: 14, lastProgress: 10, lastRecover: 10, recoveries: 2))
    }

    func testAMicThatGivesOnlyDigitalSilenceAfterABuildIsCaught() {
        XCTAssertFalse(MicStall.silentSinceBuild(now: 10.5, lastNonZero: nil, since: 10), "it gets 1 s")
        XCTAssertTrue(MicStall.silentSinceBuild(now: 11.2, lastNonZero: nil, since: 10))
        XCTAssertTrue(MicStall.silentSinceBuild(now: 11.2, lastNonZero: 9.9, since: 10), "a sample from the engine before does not count")
        XCTAssertFalse(MicStall.silentSinceBuild(now: 11.2, lastNonZero: 10.3, since: 10))
    }

    /// TF 351 19:17–19:18: heals and config rebuilds kept going ~1/s for 17 s, then crashed. One gate for both.
    func testHealsAndConfigRebuildsShareOneCapAndAStoppedReplyIsCarried() {
        XCTAssertTrue(MicStall.mayRebuild(recent: 2))
        XCTAssertFalse(MicStall.mayRebuild(recent: 3))
        XCTAssertEqual(change(lastBuild: 0, running: false, recent: 3, stopped: true), .rebuild, "a queued reply is carried, never dropped")
        XCTAssertEqual(change(lastBuild: 0, running: false, vp: false), .restart, "no voice processing: restart only")
        XCTAssertEqual(change(lastBuild: 0, nowOut: 44_100, running: false, vp: false), .rebuild, "…unless the hardware format moved (b14)")
        XCTAssertEqual(change(lastBuild: 0, wantMic: true, hasMic: false, builtIn: 0, nowIn: 0, vp: false), .rebuild, "…unless the mic is gone")
    }
}
