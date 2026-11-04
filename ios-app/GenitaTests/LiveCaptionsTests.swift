import XCTest
@testable import Genita

/// Live captions r01 state machine (LiveCaptions.swift): partial → final → check, the reply revealed at the playhead,
/// the 5 s clear, barge-in, noise and "didn't catch that". Time is a number (ms), so no test waits.
final class LiveCaptionsTests: XCTestCase {
    private func ev(_ json: String) -> ServerEvent { try! ServerEvent.decode(json) }
    private func transcript(_ text: String, final: Bool, source: String = "voice") -> ServerEvent {
        ev(#"{"type":"transcript","text":"\#(text)","final":\#(final),"turnId":1,"source":"\#(source)"}"#)
    }
    private func delta(_ id: Int, _ text: String) -> ServerEvent { ev(#"{"type":"reply.delta","utteranceId":\#(id),"text":"\#(text)"}"#) }
    private func reply(_ id: Int, _ text: String) -> ServerEvent {
        ev(#"{"type":"reply","utteranceId":\#(id),"text":"\#(text)","emotion":"neutral","interpret":false,"final":true}"#)
    }
    /// one audio clause of utterance `id`: words (w, s, e) on the reply timeline
    private func audio(_ id: Int, sentence: Int, offset: Int, words: [(String, Int, Int)]) -> ServerEvent {
        let w = words.map { #"{"w":"\#($0.0)","s":\#($0.1),"e":\#($0.2)}"# }.joined(separator: ",")
        return ev(#"{"type":"audio","utteranceId":\#(id),"seq":1,"sentence":\#(sentence),"offsetMs":\#(offset),"durationMs":500,"sampleRate":24000,"model":"m","words":[\#(w)]}"#)
    }
    private let speechStart = #"{"type":"speech.start","turnId":1}"#
    private let speechEnd = #"{"type":"speech.end","turnId":1}"#

    func testPartialThenFinalTurnsBarsIntoACheck() {
        var c = LiveCaptions()
        c.apply(ev(speechStart), now: 0)
        var f = c.frame(now: 10, level: 0.5, playheadMs: nil)
        XCTAssertEqual(f.you?.phase, .sound)
        XCTAssertEqual(f.you?.text, "…")
        c.apply(transcript("Can you help me", final: false), now: 400)
        f = c.frame(now: 410, level: 0.5, playheadMs: nil)
        XCTAssertEqual(f.you?.phase, .words)
        XCTAssertEqual(f.you?.text, "Can you help me")
        c.apply(transcript("Can you help me pick a jacket", final: false), now: 800)
        XCTAssertEqual(c.frame(now: 810, level: 0.5, playheadMs: nil).you?.text, "Can you help me pick a jacket")
        c.apply(ev(speechEnd), now: 1000)
        c.apply(transcript("Can you help me pick a jacket for tonight?", final: true), now: 1200)
        f = c.frame(now: 1210, level: 0, playheadMs: nil)
        XCTAssertEqual(f.you?.phase, .heard, "final transcript = check")
        XCTAssertEqual(f.you?.text, "Can you help me pick a jacket for tonight?")
        XCTAssertFalse(f.you!.dim)
        XCTAssertNil(f.reply)
        // a final within 1.5 s of speech.end never turns into "didn't catch that"
        XCTAssertEqual(c.frame(now: 5000, level: 0, playheadMs: nil).you?.phase, .heard)
    }

    func testTypedTurnGoesStraightToTheCheck() {
        var c = LiveCaptions()
        c.apply(transcript("hello there", final: true, source: "text"), now: 0)
        XCTAssertEqual(c.frame(now: 1, level: nil, playheadMs: nil).you, .init(text: "hello there", phase: .heard, dim: false, rolled: false))
    }

    func testLocalMicShowsSoundAfter150msAndDropsNoiseAfter1200ms() {
        var c = LiveCaptions()
        XCTAssertNil(c.frame(now: -50, level: 0.02, playheadMs: nil).you, "a quiet room sets the resting level")
        XCTAssertNil(c.frame(now: 0, level: 0.3, playheadMs: nil).you)
        XCTAssertNil(c.frame(now: 100, level: 0.3, playheadMs: nil).you, "not before 150 ms")
        XCTAssertEqual(c.frame(now: 160, level: 0.3, playheadMs: nil).you?.phase, .sound)
        XCTAssertEqual(c.frame(now: 400, level: 0.0, playheadMs: nil).you?.phase, .sound, "still within 1200 ms of the last sound")
        XCTAssertNil(c.frame(now: 1500, level: 0.0, playheadMs: nil).you, "no speech.start: it was noise (CAP-X1)")
    }

    func testSpeechEndWithoutAFinalSaysDidntCatchThat() {
        var c = LiveCaptions()
        c.apply(ev(speechStart), now: 0)
        c.apply(ev(speechEnd), now: 1000)
        XCTAssertEqual(c.frame(now: 2400, level: 0, playheadMs: nil).you?.phase, .sound)
        let f = c.frame(now: 2510, level: 0, playheadMs: nil)
        XCTAssertEqual(f.you?.phase, .missed)
        XCTAssertEqual(f.you?.text, "Didn't catch that. Say it again?")
        XCTAssertEqual(c.frame(now: 4000, level: 0, playheadMs: nil).you?.phase, .missed)
        XCTAssertNil(c.frame(now: 4120, level: 0, playheadMs: nil).you, "gone after 1.6 s")
    }

    func testReplyWordsFollowThePlayheadNeverAhead() {
        var c = LiveCaptions()
        c.apply(transcript("what should I wear", final: true), now: 0)
        c.apply(delta(4, "The navy one."), now: 100)
        c.apply(delta(4, " It goes with your boots."), now: 200)
        c.apply(audio(4, sentence: 0, offset: 0, words: [("The", 0, 150), ("navy", 150, 400), ("one.", 400, 700)]), now: 300)
        // nothing plays yet: no words, the user's line stays full
        var f = c.frame(now: 310, level: 0, playheadMs: nil)
        XCTAssertNil(f.reply)
        XCTAssertFalse(f.you!.dim)
        f = c.frame(now: 400, level: 0, playheadMs: 10)
        XCTAssertEqual(f.reply?.text, "The")
        XCTAssertEqual(f.you?.dim, true, "the user's line yields to one dim line once the companion talks")
        XCTAssertEqual(c.frame(now: 500, level: 0, playheadMs: 160).reply?.text, "The navy")
        // the second sentence's audio hasn't come: the first ends, nothing past it
        XCTAssertEqual(c.frame(now: 600, level: 0, playheadMs: 720).reply?.text, "The navy one.")
        c.apply(audio(4, sentence: 1, offset: 800, words: [("It", 800, 900), ("goes", 900, 1100), ("with", 1100, 1200), ("your", 1200, 1300), ("boots.", 1300, 1600)]), now: 700)
        XCTAssertEqual(c.frame(now: 900, level: 0, playheadMs: 950).reply?.text, "The navy one. It goes")
        // audio.timing (aligner) replaces that clause's words
        c.apply(ev(#"{"type":"audio.timing","utteranceId":4,"sentence":1,"seq":2,"words":[{"w":"It","s":800,"e":850},{"w":"goes","s":850,"e":900},{"w":"with","s":900,"e":1000},{"w":"your","s":1000,"e":1100},{"w":"boots","s":1100,"e":1400}],"phonemes":[]}"#), now: 950)
        XCTAssertEqual(c.frame(now: 1000, level: 0, playheadMs: 960).reply?.text, "The navy one. It goes with")
        // the playhead never moves words backwards
        XCTAssertEqual(c.frame(now: 1010, level: 0, playheadMs: 0).reply?.text, "The navy one. It goes with")
    }

    func testReplyFadesFiveSecondsAfterItsVoiceEnds() {
        var c = LiveCaptions()
        c.apply(transcript("hi", final: true), now: 0)
        c.apply(delta(1, "Hey you."), now: 10)
        c.apply(audio(1, sentence: 0, offset: 0, words: [("Hey", 0, 200), ("you.", 200, 500)]), now: 20)
        c.apply(reply(1, "Hey you."), now: 30)
        _ = c.frame(now: 100, level: 0, playheadMs: 100)
        // the player stops: voice done, everything shown
        var f = c.frame(now: 700, level: 0, playheadMs: nil)
        XCTAssertEqual(f.reply?.text, "Hey you.")
        f = c.frame(now: 5600, level: 0, playheadMs: nil)
        XCTAssertNotNil(f.reply, "still there 4.9 s later")
        f = c.frame(now: 5701, level: 0, playheadMs: nil)
        XCTAssertTrue(f.isEmpty, "both lines go 5 s after the last word (CAP-6)")
    }

    func testBargeInFreezesAndDimsTheReply() {
        var c = LiveCaptions()
        c.apply(transcript("tell me a story", final: true), now: 0)
        c.apply(delta(2, "Once upon a time there was a fox."), now: 10)
        c.apply(audio(2, sentence: 0, offset: 0, words: [("Once", 0, 200), ("upon", 200, 400), ("a", 400, 450), ("time", 450, 700), ("there", 700, 900), ("was", 900, 1000), ("a", 1000, 1050), ("fox.", 1050, 1400)]), now: 20)
        XCTAssertEqual(c.frame(now: 500, level: 0, playheadMs: 420).reply?.text, "Once upon a")
        // the user talks over it: speech.start alone (maybe echo) keeps the reply
        c.apply(ev(speechStart), now: 520)
        XCTAssertEqual(c.frame(now: 530, level: 0.5, playheadMs: 460).reply?.text, "Once upon a time")
        c.apply(ev(#"{"type":"utterance.cancelled","utteranceId":2,"reason":"barge_in"}"#), now: 600)
        let f = c.frame(now: 610, level: 0.5, playheadMs: 1200)
        XCTAssertEqual(f.reply?.text, "Once upon a time", "frozen at the last word heard")
        XCTAssertEqual(f.reply?.cut, true, "dimmed")
        // the user's words replace the old turn
        c.apply(transcript("wait, a different one", final: false), now: 900)
        let g = c.frame(now: 910, level: 0.5, playheadMs: nil)
        XCTAssertNil(g.reply)
        XCTAssertEqual(g.you?.text, "wait, a different one")
        XCTAssertEqual(g.you?.phase, .words)
    }

    func testDeviceVoiceRevealsSentenceBySentence() {
        var c = LiveCaptions()
        c.apply(delta(3, "Sure thing."), now: 0)
        c.apply(delta(3, " Here it is."), now: 0)
        c.apply(ev(#"{"type":"say","utteranceId":3,"sentence":0,"text":"Sure thing.","emotion":"neutral","lang":"en-US"}"#), now: 0)
        XCTAssertEqual(c.frame(now: 10, level: nil, playheadMs: 0).reply?.text, "Sure thing.")
        // the second sentence hasn't been received for speaking yet: never shown ahead of it (Codex P2)
        XCTAssertEqual(c.frame(now: 20, level: nil, playheadMs: 11 * 62 + 1).reply?.text, "Sure thing.")
        c.apply(ev(#"{"type":"say","utteranceId":3,"sentence":1,"text":"Here it is.","emotion":"neutral","lang":"en-US"}"#), now: 30)
        XCTAssertEqual(c.frame(now: 40, level: nil, playheadMs: 11 * 62 + 2).reply?.text, "Sure thing. Here it is.")
    }

    func testHoldBeatAndSplitWordsMatchByText() {
        var c = LiveCaptions()
        c.apply(delta(6, "I see that golden puppy soaking up the sun."), now: 0)
        // a hold beat ("Hmm,") is audio only (sentence 0, no caption); the answer's voice is sentence 1 and its timing
        // splits "soaking" across two frames
        c.apply(audio(6, sentence: 0, offset: 0, words: [("Hmm,", 0, 300)]), now: 10)
        c.apply(audio(6, sentence: 1, offset: 400, words: [("I", 400, 450), ("see", 450, 600), ("that", 600, 700), ("golden", 700, 900),
                                                           ("puppy", 900, 1100), ("so", 1100, 1200), ("aking", 1200, 1350), ("up", 1350, 1450)]), now: 20)
        XCTAssertNil(c.frame(now: 30, level: nil, playheadMs: 200).reply, "the beat shows no words")
        XCTAssertEqual(c.frame(now: 40, level: nil, playheadMs: 460).reply?.text, "I see")
        XCTAssertEqual(c.frame(now: 50, level: nil, playheadMs: 1150).reply?.text, "I see that golden puppy soaking")
        XCTAssertEqual(c.frame(now: 60, level: nil, playheadMs: 1400).reply?.text, "I see that golden puppy soaking up")
    }

    func testLocalStopFreezesInsteadOfShowingTheRest() {
        var c = LiveCaptions()
        c.apply(delta(7, "One two three four."), now: 0)
        c.apply(audio(7, sentence: 0, offset: 0, words: [("One", 0, 100), ("two", 100, 200), ("three", 200, 300), ("four.", 300, 400)]), now: 0)
        c.apply(reply(7, "One two three four."), now: 0)
        XCTAssertEqual(c.frame(now: 10, level: nil, playheadMs: 150).reply?.text, "One two")
        c.cut(utteranceId: 7, now: 20)   // face tap: CallController sees it in `cancelled` before the server's cancel
        let f = c.frame(now: 30, level: nil, playheadMs: nil)
        XCTAssertEqual(f.reply?.text, "One two")
        XCTAssertEqual(f.reply?.cut, true)
    }

    func testFinalReplyTextWinsOverDeltas() {
        var c = LiveCaptions()
        c.apply(delta(8, "Let me check that."), now: 0)
        c.apply(delta(8, " It's sunny."), now: 0)
        c.apply(reply(8, "It's sunny."), now: 10)   // the server dropped the first sentence
        c.apply(audio(8, sentence: 0, offset: 0, words: [("It's", 0, 200), ("sunny.", 200, 500)]), now: 20)
        XCTAssertEqual(c.frame(now: 30, level: nil, playheadMs: 250).reply?.text, "It's sunny.")
    }

    func testReplyWithNoAudioShowsWholeAfterTheWait() {
        var c = LiveCaptions()
        c.apply(delta(5, "Sorry, try again."), now: 0)
        c.apply(reply(5, "Sorry, try again."), now: 100)
        XCTAssertNil(c.frame(now: 2000, level: nil, playheadMs: nil).reply, "never before the voice could have started")
        XCTAssertEqual(c.frame(now: 3200, level: nil, playheadMs: nil).reply?.text, "Sorry, try again.")
    }

    func testLongLinesKeepTheNewestWords() {
        let long = Array(repeating: "words", count: 40).joined(separator: " ") + " newest"
        let (t, rolled) = LiveCaptions.tail(long, max: LiveCaptions.youMaxChars)
        XCTAssertTrue(rolled)
        XCTAssertTrue(t.hasSuffix("newest"))
        XCTAssertLessThanOrEqual(t.count, LiveCaptions.youMaxChars)
        XCTAssertFalse(t.hasPrefix(" "))
    }

    // TF 341 (Chelsea, 18:30): on a real iPhone the mic level never rests under 0.08 (room, breath, AEC residue).
    // The heard line must survive that noise until the reply, and the user's words must not depend on it.
    func testNoisyMicNeverWipesTheUsersWords() {
        var c = LiveCaptions()
        var now: Double = 0
        func tick(_ ms: Double, level: Float = 0.2) -> LiveCaptions.Frame { now += ms; return c.frame(now: now, level: level, playheadMs: nil) }
        _ = tick(200)   // noise alone: "…"
        c.apply(ev(speechStart), now: now)
        c.apply(transcript("What should I eat", final: false), now: now)
        XCTAssertEqual(tick(100).you?.text, "What should I eat")
        c.apply(transcript("What should I eat tonight?", final: true), now: now)
        // thinking: the mic keeps hearing the room
        for _ in 0..<60 { XCTAssertEqual(tick(33).you?.phase, .heard, "the heard line stays through mic noise") }
        c.apply(delta(9, "Wednesday night, you need food."), now: now)
        c.apply(audio(9, sentence: 0, offset: 0, words: [("Wednesday", 0, 300), ("night,", 300, 600)]), now: now)
        let f = c.frame(now: now + 10, level: 0.3, playheadMs: 100)
        XCTAssertEqual(f.you?.text, "What should I eat tonight?")
        XCTAssertEqual(f.you?.dim, true)
        XCTAssertEqual(f.reply?.text, "Wednesday")
    }

    func testMicStateOnlyHidesTheSoundPlaceholder() {
        let heard = LiveCaptions.Frame.YouRow(text: "hi", phase: .heard, dim: false, rolled: false)
        let sound = LiveCaptions.Frame.YouRow(text: "…", phase: .sound, dim: false, rolled: false)
        XCTAssertEqual(LiveCaptions.visibleYou(heard, micOn: false), heard, "words the server heard always show")
        XCTAssertNil(LiveCaptions.visibleYou(sound, micOn: false))
        XCTAssertEqual(LiveCaptions.visibleYou(sound, micOn: true), sound)
    }

    func testCaptionBottomSits16AboveTheCameraButton() {
        let grid = CallHUDGrid(size: CGSize(width: 390, height: 844), safeTop: 47, safeBottom: 34)
        XCTAssertEqual(grid.captionBottom(), 626, accuracy: 0.01)
    }
}
