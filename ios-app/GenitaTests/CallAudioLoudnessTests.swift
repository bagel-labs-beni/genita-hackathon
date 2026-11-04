import AVFoundation
import AudioToolbox
import XCTest
@testable import Genita

/// TF 331 (CEO, iPhone): the companion's voice was too quiet in a call. The reply now goes through a peak limiter
/// with a pre-gain before the mixer (CallOutputLevel); the listening cue keeps its own quiet path.
@MainActor final class CallAudioLoudnessTests: XCTestCase {
    private let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(GenitaProtocol.sampleRate), channels: 1, interleaved: false)!

    func testTheReplyGoesThroughTheLoudnessStageBeforeTheMixer() throws {
        let engine = AVAudioEngine(), player = AVAudioPlayerNode(), cue = AVAudioPlayerNode()
        let stage = try XCTUnwrap(CallAudio.connectPlayback(player: player, cue: cue, in: engine, format: format), "iPhone has a loudness stage")
        XCTAssertEqual(stage.audioComponentDescription.componentType, kAudioUnitType_Effect)
        XCTAssertEqual(stage.audioComponentDescription.componentSubType, kAudioUnitSubType_PeakLimiter, "a limiter, so the gain never clips")
        XCTAssertTrue(engine.outputConnectionPoints(for: player, outputBus: 0).first?.node === stage, "reply → limiter")
        XCTAssertTrue(engine.outputConnectionPoints(for: stage, outputBus: 0).first?.node === engine.mainMixerNode, "limiter → mixer")
        XCTAssertTrue(engine.outputConnectionPoints(for: cue, outputBus: 0).first?.node === engine.mainMixerNode, "the cue skips the gain")
        XCTAssertEqual(cue.volume, 0.6, accuracy: 0.001)
        engine.prepare() // the graph renders with the limiter in it (a format it refuses would fail here)
    }

    func testThePreGainIsSetAndModerate() throws {
        let engine = AVAudioEngine()
        let stage = try XCTUnwrap(CallAudio.connectPlayback(player: AVAudioPlayerNode(), cue: AVAudioPlayerNode(), in: engine, format: format))
        let gain = CallOutputLevel.value(stage, AudioUnitParameterID(kLimiterParam_PreGain))
        XCTAssertEqual(gain, CallOutputLevel.preGainDB, accuracy: 0.01)
        // louder than before, but not so loud the echo canceller (and barge-in) suffers
        XCTAssertGreaterThanOrEqual(gain, 6)
        XCTAssertLessThanOrEqual(gain, 9)
        XCTAssertEqual(CallOutputLevel.value(stage, AudioUnitParameterID(kLimiterParam_AttackTime)), CallOutputLevel.attackSeconds, accuracy: 0.0001)
        XCTAssertEqual(CallOutputLevel.value(stage, AudioUnitParameterID(kLimiterParam_DecayTime)), CallOutputLevel.decaySeconds, accuracy: 0.0001)
    }
}
