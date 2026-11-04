import XCTest
@testable import Genita

/// 11/4 (Chelsea, TF 341: "robot voice"): the app never speaks with the system voice. `say` is a caption only, and
/// the utterance still completes (playback_done) when its `reply` arrives.
@MainActor final class CaptionOnlyVoiceTests: XCTestCase {
    func testCallUsesCaptionOnlyVoiceNotTheSystemVoice() {
        XCTAssertTrue(CallController.makeVoice() is CaptionOnlyVoice)
        XCTAssertFalse(CallController.makeVoice() is DeviceVoice)
    }

    func testSayIsNeverRenderedToAudioAndTheReplyCompletesTheUtterance() throws {
        let voice = CaptionOnlyVoice()
        var pcm = 0
        var rendered: [Int] = []
        voice.onPCM = { _, _ in pcm += 1 }
        voice.onRendered = { rendered.append($0) }
        let event = try ServerEvent.decode(#"{"type":"say","utteranceId":7,"sentence":0,"text":"Sorry, I lost you for a sec.","emotion":"warm","lang":"en-US"}"#)
        guard case let .say(s) = event else { return XCTFail("not say") }
        voice.say(s)
        XCTAssertEqual(pcm, 0, "no system-voice audio")
        XCTAssertEqual(rendered, [], "not complete before the reply")
        voice.replyArrived(7)
        XCTAssertEqual(rendered, [7], "the reply completes it, so playback_done goes out")
        XCTAssertEqual(pcm, 0)
        XCTAssertNil(voice.mouthLevel(utteranceId: 7, positionMs: 100))
    }

    func testCancelAndForgetClear() throws {
        let voice = CaptionOnlyVoice()
        let event = try ServerEvent.decode(#"{"type":"say","utteranceId":2,"sentence":0,"text":"Hi.","emotion":"neutral","lang":"en-US"}"#)
        guard case let .say(s) = event else { return XCTFail("not say") }
        voice.say(s)
        voice.cancel()
        XCTAssertTrue(voice.captioned.isEmpty)
        voice.say(s)
        voice.forget(2)
        XCTAssertTrue(voice.captioned.isEmpty)
    }
}
