import AVFoundation
import XCTest
@testable import Genita

/// Device voice mode (PROTOCOL.md "Device voice mode"): `say` text → system voice → the call's player.
@MainActor final class DeviceVoiceTests: XCTestCase {
    func testDecodesSayAndReadyTts() throws {
        let say = try ServerEvent.decode(#"{"type":"say","utteranceId":3,"sentence":0,"text":"That's huge, congrats!","emotion":"happy","lang":"en-US"}"#)
        guard case let .say(s) = say else { return XCTFail("not say: \(say)") }
        XCTAssertEqual(s.utteranceId, 3)
        XCTAssertEqual(s.lang, "en-US")
        let ready = try ServerEvent.decode(#"{"type":"ready","protocol":1,"sessionId":"s","mode":"chat","audio":{"in":"pcm_s16le_24000_mono","out":"pcm_s16le_24000_mono","frameHeaderBytes":8},"lip":{"requested":"atlas","active":"none","reason":"device_tts"},"voiceId":"v","bargeIn":{"minMs":400,"minWords":2},"tts":"device"}"#)
        guard case let .ready(r) = ready else { return XCTFail("not ready") }
        XCTAssertEqual(r.tts, .device)
    }

    func testCallControllerFollowsReadyTts() throws {
        let call = CallController()
        call.handle(try ServerEvent.decode(#"{"type":"ready","protocol":1,"sessionId":"s","mode":"chat","audio":{"in":"pcm_s16le_24000_mono","out":"pcm_s16le_24000_mono","frameHeaderBytes":8},"lip":{"requested":"none","active":"none","reason":"device_tts"},"voiceId":"v","bargeIn":{"minMs":400,"minWords":2},"tts":"device"}"#))
        XCTAssertEqual(call.tts, .device)
        // An older server without `tts` speaks itself.
        call.handle(try ServerEvent.decode(#"{"type":"ready","protocol":1,"sessionId":"s","mode":"chat","audio":{"in":"pcm_s16le_24000_mono","out":"pcm_s16le_24000_mono","frameHeaderBytes":8},"lip":{"requested":"none","active":"none","reason":null},"voiceId":"v","bargeIn":{"minMs":400,"minWords":2}}"#))
        XCTAssertEqual(call.tts, .server)
    }

    func testRenderConvertsSynthesizerBuffersTo24kS16AndMeasuresTheMouth() throws {
        // 22.05 kHz float, 0.2 s of a loud 220 Hz tone (the usual system voice format)
        let input = try XCTUnwrap(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 22_050, channels: 1, interleaved: false))
        let n = 4_410
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: input, frameCapacity: AVAudioFrameCount(n)))
        buffer.frameLength = AVAudioFrameCount(n)
        for i in 0..<n { buffer.floatChannelData![0][i] = 0.5 * sin(2 * .pi * 220 * Float(i) / 22_050) }
        let render = SpeechRender(sampleRate: 24_000, stepMs: 40)
        let out = try XCTUnwrap(render.convert(buffer))
        let tail = render.finish()
        let samples = (out.pcm.count + (tail?.pcm.count ?? 0)) / 2
        XCTAssertGreaterThan(samples, 4_700, "≈ 0.2 s at 24 kHz once the converter is drained")
        XCTAssertLessThanOrEqual(samples, 4_900)
        XCTAssertEqual(out.levels.count + (tail?.levels.count ?? 0), Int((Double(samples) / 960).rounded(.up)))
        XCTAssertGreaterThan(out.levels.first ?? 0, 0.9, "a loud tone is an open mouth")
        XCTAssertEqual(SpeechRender.level(ArraySlice(repeating: Int16(0), count: 960)), 0, "silence is a closed mouth")
    }

    func testMouthLevelFollowsPosition() {
        let voice = DeviceVoice()
        XCTAssertNil(voice.mouthLevel(utteranceId: 1, positionMs: 0))
    }
}
