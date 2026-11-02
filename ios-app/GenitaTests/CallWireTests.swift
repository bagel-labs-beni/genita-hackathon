import XCTest
@testable import Genita

/// F4-L10 · Audio framing and protocol parsing against genita-server/PROTOCOL.md (v1).
@MainActor final class CallWireTests: XCTestCase {
    // MARK: binary frames

    func testParsesServerAudioHeader() throws {
        // "GA" | kind 1 | reserved | seq 0x01020304 LE | 4 bytes PCM
        let frame = Data([0x47, 0x41, 1, 0, 0x04, 0x03, 0x02, 0x01, 0x10, 0x00, 0xF0, 0xFF])
        let header = try XCTUnwrap(AudioFrameHeader(frame: frame))
        XCTAssertEqual(header.kind, GenitaProtocol.frameKindTTSPCM)
        XCTAssertEqual(header.seq, 0x0102_0304)
        let payload = AudioFrameHeader.payload(of: frame)
        XCTAssertEqual(payload, Data([0x10, 0x00, 0xF0, 0xFF]))
        XCTAssertEqual(PCM.floats(fromS16LE: payload), [Float(16) / 32768, Float(-16) / 32768])
    }

    func testRejectsFramesThatAreNotGenitaAudio() {
        XCTAssertNil(AudioFrameHeader(frame: Data([0x47, 0x41, 1, 0, 0, 0, 0])), "shorter than the 8-byte header")
        XCTAssertNil(AudioFrameHeader(frame: Data([0x52, 0x49, 1, 0, 1, 0, 0, 0])), "wrong magic")
    }

    func testHeaderRoundTripsLikeTheServer() throws {
        let header = AudioFrameHeader(kind: 1, seq: 41)
        XCTAssertEqual(header.encoded(), Data([0x47, 0x41, 1, 0, 41, 0, 0, 0]))
        XCTAssertEqual(AudioFrameHeader(frame: header.encoded()), header)
    }

    // MARK: mic framing

    func testFramerCuts80msFramesOf3840Bytes() {
        var framer = PCMFramer()
        XCTAssertEqual(GenitaProtocol.micFrameSamples, 1920)
        XCTAssertTrue(framer.append([Int16](repeating: 1, count: 1000)).isEmpty)
        let frames = framer.append([Int16](repeating: 2, count: 3000))
        XCTAssertEqual(frames.count, 2)
        XCTAssertEqual(frames.map(\.count), [3840, 3840])
        XCTAssertEqual(framer.pendingSamples, 160)
        // order and little-endian bytes are preserved across the split
        XCTAssertEqual(Array(frames[0].prefix(2)), [1, 0])
        XCTAssertEqual(Array(frames[0].suffix(2)), [2, 0])
    }

    func testPCMEncodingIsLittleEndianSigned() {
        XCTAssertEqual(PCM.data(from: [Int16(-2), 258]), Data([0xFE, 0xFF, 0x02, 0x01]))
        XCTAssertEqual(PCM.durationMs(bytes: 3840), 80)
    }

    // MARK: server events

    func testDecodesReadyAndReadsLipPlan() throws {
        let json = #"{"type":"ready","protocol":1,"sessionId":"s1","mode":"chat","audio":{"in":"pcm_s16le_24000_mono","out":"pcm_s16le_24000_mono","frameHeaderBytes":8},"lip":{"requested":"atlas","active":"none","reason":"device_tts"},"voiceId":"v","bargeIn":{"minMs":400,"minWords":2}}"#
        guard case let .ready(r) = try ServerEvent.decode(json) else { return XCTFail() }
        XCTAssertEqual(r.lip.active, .none)
        XCTAssertEqual(r.lip.reason, "device_tts")
        XCTAssertEqual(r.bargeIn.minMs, 400)
    }

    func testDecodesAudioTimingWithAtlasMouth() throws {
        let json = #"{"type":"audio","utteranceId":3,"seq":41,"sentence":0,"offsetMs":0,"durationMs":380,"sampleRate":24000,"model":"seamless-m4t-v2","words":[{"w":"That's","s":80,"e":310}],"mouth":[{"t":80,"v":"A"}]}"#
        guard case let .audio(a) = try ServerEvent.decode(json) else { return XCTFail() }
        XCTAssertEqual(a.utteranceId, 3)
        XCTAssertEqual(a.seq, 41)
        XCTAssertEqual(a.words.first?.w, "That's")
    }

    func testDecodesStateCancelErrorAndUnknown() throws {
        XCTAssertEqual(try ServerEvent.decode(#"{"type":"state","state":"interrupted"}"#), .state(.init(state: .interrupted)))
        XCTAssertEqual(try ServerEvent.decode(#"{"type":"utterance.cancelled","utteranceId":7,"reason":"barge_in"}"#), .utteranceCancelled(.init(utteranceId: 7, reason: .bargeIn)))
        guard case let .error(e) = try ServerEvent.decode(#"{"type":"error","code":"spark_unavailable","message":"x","retryable":true}"#) else { return XCTFail() }
        XCTAssertEqual(e.code, "spark_unavailable")
        guard case let .turnMetrics(m) = try ServerEvent.decode(#"{"type":"turn.metrics","utteranceId":1,"model":"m","ttsModel":null,"speechEndToCompleteMs":null,"replyStartToFirstTokenMs":900,"replyStartToFirstSentenceMs":null,"firstSentenceToFirstAudioMs":null,"speechEndToFirstAudioMs":2400,"audioMs":3000}"#) else { return XCTFail() }
        XCTAssertEqual(m.speechEndToFirstAudioMs, 2400)
        XCTAssertNil(m.ttsModel)
        XCTAssertEqual(try ServerEvent.decode(#"{"type":"something.new","x":1}"#), .unknown(type: "something.new"))
    }

    // MARK: client messages

    func testEncodesClientMessagesWithProtocolNames() throws {
        func object(_ m: ClientMessage) throws -> [String: Any] {
            try XCTUnwrap(JSONSerialization.jsonObject(with: Data(m.json().utf8)) as? [String: Any])
        }
        XCTAssertEqual(try object(.audioStart)["type"] as? String, "audio_start")
        XCTAssertEqual(try object(.audioStop)["type"] as? String, "audio_stop")
        XCTAssertEqual(try object(.bargeIn)["type"] as? String, "barge_in")
        let done = try object(.playbackDone(utteranceId: 9))
        XCTAssertEqual(done["type"] as? String, "playback_done")
        XCTAssertEqual(done["utteranceId"] as? Int, 9)
        let mode = try object(.mode(.interpret))
        XCTAssertEqual(mode["mode"] as? String, "interpret")
        let frames = try object(.frames(.init(images: ["a", "b"])))
        XCTAssertEqual(frames["type"] as? String, "frames")
        XCTAssertEqual(frames["images"] as? [String], ["a", "b"])
    }

    func testStartCarriesPersonaUserAndNoLip() throws {
        let start = ClientMessage.Start.companion(name: "Jin", userName: "Chelsea", profile: "likes tea", traits: ["Calm"], voiceId: nil)
        let o = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(ClientMessage.start(start).json().utf8)) as? [String: Any])
        XCTAssertEqual(o["type"] as? String, "start")
        XCTAssertEqual((o["persona"] as? [String: Any])?["name"] as? String, "Jin")
        XCTAssertEqual((o["persona"] as? [String: Any])?["kind"] as? String, "human")
        XCTAssertEqual((o["user"] as? [String: Any])?["name"] as? String, "Chelsea")
        XCTAssertEqual((o["lip"] as? [String: Any])?["mode"] as? String, "none")
        XCTAssertEqual(o["mic"] as? Bool, false, "the mic opens only when the user turns it on")
        XCTAssertNil(o["voiceId"], "absent keys stay absent, not null")
    }

    // MARK: status line

    func testCueShowsOneThingInBoardPriority() {
        func cue(link: CallCue.Link = .live, phase: Phase = .listening, playing: Bool = false, awaiting: Bool = false, mic: Bool = true, hold: Bool = false, failed: Bool = false, denied: Bool = false) -> CallCue {
            CallCue.derive(link: link, phase: phase, playing: playing, awaitingFirstAudio: awaiting, micOn: mic, interruptedHold: hold, answerFailed: failed, micDenied: denied)
        }
        XCTAssertEqual(cue(), .listening)
        XCTAssertEqual(cue(mic: false), .none, "no Listening pill while the mic is off")
        XCTAssertEqual(cue(phase: .thinking), .thinking)
        XCTAssertEqual(cue(phase: .speaking, awaiting: true), .thinking, "server says speaking, sound not out yet")
        XCTAssertEqual(cue(phase: .speaking), .speaking, "between sentences the pill stays")
        XCTAssertEqual(cue(phase: .listening, playing: true), .speaking)
        XCTAssertEqual(cue(phase: .listening, hold: true), .interrupted, "S09-X holds after the server is already listening")
        XCTAssertEqual(cue(phase: .speaking, playing: true, failed: true), .answerFailed)
        XCTAssertEqual(cue(link: .reconnecting, phase: .speaking, failed: true), .reconnecting)
        XCTAssertEqual(cue(link: .connecting), .none)
        XCTAssertEqual(cue(mic: false, denied: true), .micBlocked)
    }

    func testControllerHoldsInterruptedThenListens() async throws {
        let call = CallController()
        call.handle(#"{"type":"ready","protocol":1,"sessionId":"s","mode":"chat","audio":{"in":"a","out":"a","frameHeaderBytes":8},"lip":{"requested":"none","active":"none","reason":null},"voiceId":"v","bargeIn":{"minMs":400,"minWords":2}}"#)
        call.handle(#"{"type":"state","state":"thinking"}"#)
        XCTAssertEqual(call.cue, .thinking)
        call.handle(#"{"type":"state","state":"interrupted"}"#)
        call.handle(#"{"type":"state","state":"listening"}"#)
        XCTAssertEqual(call.cue, .interrupted)
        try await Task.sleep(for: .milliseconds(1400))
        XCTAssertEqual(call.cue, .none, "mic is off in this test, so no Listening pill")
        call.handle(#"{"type":"error","code":"spark_unavailable","message":"x","retryable":true}"#)
        XCTAssertEqual(call.cue, .answerFailed)
        call.handle(#"{"type":"speech.start","turnId":2}"#)
        XCTAssertNotEqual(call.cue, .answerFailed, "speaking again clears S09-F")
    }

    func testLipChangedReplacesTheReadyPlan() {
        let call = CallController()
        call.handle(#"{"type":"lip.changed","lip":{"requested":"atlas","active":"atlas","reason":null}}"#)
        XCTAssertEqual(call.lip?.active, .atlas)
    }

    func testToolCallsCountFindsOncePerReply() {
        let call = CallController()
        call.handle(#"{"type":"tool","utteranceId":1,"name":"web_search","status":"searching"}"#)
        call.handle(#"{"type":"tool","utteranceId":1,"name":"web_search","status":"done"}"#)
        call.handle(#"{"type":"tool","utteranceId":2,"name":"web_search","status":"searching"}"#)
        XCTAssertEqual(call.findsCount, 2)
    }

    func testHandoffPeerNameFitsMultipeerLimit() {
        let korean = HandoffLink.peerName(String(repeating: "채은의아이폰", count: 10))
        XCTAssertLessThanOrEqual(korean.utf8.count, 60, "MCPeerID throws over 63 bytes")
        XCTAssertTrue(korean.hasPrefix("채은의아이폰"))
        XCTAssertEqual(HandoffLink.peerName(""), "Genita")
    }

    func testFixtureVoicedEndTrimsTrailingSilence() {
        let loud = PCM.data(from: [Int16](repeating: 8000, count: 4800))  // 200 ms
        let quiet = Data(count: 4800 * 2)                                  // 200 ms silence
        XCTAssertEqual(FixtureMic.voicedEnd(loud + quiet), loud.count)
    }
}
