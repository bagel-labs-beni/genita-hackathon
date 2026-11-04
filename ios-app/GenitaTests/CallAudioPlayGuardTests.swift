import AVFoundation
import XCTest
@testable import Genita

/// TF 331 CRASH-1: AVAudioPlayerNode.play() raised (SIGABRT) from a background expiry and a main-queue block.
/// A node plays only on its own running engine with an output connection; flush and stop never start one that isn't.
@MainActor final class CallAudioPlayGuardTests: XCTestCase {
    func testOnlyAnAttachedConnectedNodeOnARunningEngineIsReady() {
        let engine = AVAudioEngine()
        let node = AVAudioPlayerNode()
        XCTAssertFalse(CallAudio.ready(node, in: engine), "detached")
        engine.attach(node)
        XCTAssertFalse(CallAudio.ready(node, in: engine), "attached, not connected, engine stopped")
        engine.connect(node, to: engine.mainMixerNode, format: nil)
        XCTAssertFalse(CallAudio.ready(node, in: engine), "engine stopped")
        XCTAssertFalse(CallAudio.ready(node, in: AVAudioEngine()), "another engine")
    }
    func testFlushAndStopBeforeStartNeverPlay() {
        let audio = CallAudio()
        audio.flush()
        audio.resetSession()
        audio.stop()
        audio.enqueue(pcm: Data(count: 960), utteranceId: 1)
        audio.stop()
    }
}
