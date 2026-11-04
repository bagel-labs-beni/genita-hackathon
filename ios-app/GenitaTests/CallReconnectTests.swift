import XCTest
@testable import Genita

@MainActor final class CallReconnectTests: XCTestCase {
    func testCancelledIDPlaysServerPCMAfterReconnectAndReportsPlaybackDone() async throws {
        let audio = ReconnectAudio(), voice = ReconnectVoice(), sockets = ReconnectSockets()
        let call = begin(audio, voice, sockets)
        defer { call.end() }
        var connections = 0
        call.onConnected = { connections += 1 }
        let old = sockets.connections[0]
        old.onMessage?(.text(ready("old")))
        old.onMessage?(.text(timing(id: 1, seq: 1)))
        old.onMessage?(.binary(frame(seq: 1)))
        XCTAssertTrue(call.playing)
        old.onMessage?(.text(cancelled(1)))
        old.onMessage?(.text(timing(id: 1, seq: 2)))
        old.onMessage?(.binary(frame(seq: 2)))
        old.onMessage?(.text(reply(1)))
        XCTAssertEqual(audio.enqueued, [1], "cancellation still suppresses late PCM in the same session")
        XCTAssertEqual(old.playbackDone, [])
        // Leave both a sequence mapping and a fallback utterance from the old server behind.
        old.onMessage?(.text(timing(id: 99, seq: 7)))
        let current = try await reconnect(old, sockets)
        current.onMessage?(.text(ready("new")))
        XCTAssertEqual(connections, 2, "Initial and recovered calls both retry handoff identity")

        // Queued callbacks from the replaced socket cannot cancel the new session or replace its ready.
        old.onMessage?(.text(cancelled(1)))
        old.onMessage?(.text(ready("late-old")))
        old.onMessage?(.binary(frame(seq: 7)))
        old.onOpen?()
        old.onClose?(.failed("late close"))
        XCTAssertEqual(connections, 2, "A replaced socket cannot trigger identity resolution")
        XCTAssertEqual(call.sessionId, "new")
        XCTAssertEqual(old.sent.count, 1, "late open cannot restart the old socket")
        XCTAssertEqual(current.sent.count, 1, "only the new socket's start")
        current.onMessage?(.text(timing(id: 1, seq: 1)))
        current.onMessage?(.binary(frame(seq: 1)))
        current.onMessage?(.binary(frame(seq: 7))) // no old seq=7 → utterance=99 mapping
        current.onMessage?(.text(reply(1)))
        XCTAssertEqual(audio.enqueued, [1, 1, 1])
        XCTAssertEqual(audio.starts, [1, 1], "reused IDs must signal playback start again")
        XCTAssertTrue(call.playing)
        XCTAssertEqual(current.playbackDone, [], "wait for the player, not just reply")
        audio.finish(1)
        XCTAssertEqual(current.playbackDone, [1])
        XCTAssertFalse(call.playing)
    }

    func testCancelledIDPlaysDeviceSayAfterReconnectAndReportsPlaybackDone() async throws {
        let audio = ReconnectAudio(), voice = ReconnectVoice(), sockets = ReconnectSockets()
        let call = begin(audio, voice, sockets)
        defer { call.end() }
        let old = sockets.connections[0]
        old.onMessage?(.text(ready("old", tts: "device")))
        old.onMessage?(.text(say(1)))
        old.onMessage?(.text(cancelled(1)))
        old.onMessage?(.text(say(2))) // unfinished rendering must be discarded too
        let current = try await reconnect(old, sockets)
        current.onMessage?(.text(ready("new", tts: "device")))
        XCTAssertTrue(voice.pending.isEmpty)
        current.onMessage?(.text(say(1)))
        current.onMessage?(.text(reply(1)))
        XCTAssertEqual(voice.pending.map(\.utteranceId), [1])
        XCTAssertEqual(current.playbackDone, [])
        voice.render(1)
        XCTAssertEqual(audio.enqueued, [1])
        XCTAssertTrue(call.playing)
        XCTAssertEqual(current.playbackDone, [])
        audio.finish(1)
        XCTAssertEqual(current.playbackDone, [1])
        XCTAssertFalse(call.playing)
    }

    func testNewSessionDropsDeviceFallbackAndCurrentUtterance() async throws {
        let audio = ReconnectAudio(), voice = ReconnectVoice(), sockets = ReconnectSockets()
        let call = begin(audio, voice, sockets)
        defer { call.end() }
        let old = sockets.connections[0]
        old.onMessage?(.text(ready("old")))
        old.onMessage?(.text(say(1))) // device fallback while ready.tts is server
        let current = try await reconnect(old, sockets)
        current.onMessage?(.text(ready("new")))
        current.onMessage?(.text(reply(1)))
        XCTAssertEqual(voice.replies, [], "a server reply must not wait on the old device fallback")
        XCTAssertEqual(current.playbackDone, [1])
        current.onMessage?(.binary(frame(seq: 99)))
        XCTAssertEqual(audio.enqueued, [-1], "never attribute a frame to the old current utterance")
    }

    private func begin(_ audio: ReconnectAudio, _ voice: ReconnectVoice, _ sockets: ReconnectSockets) -> CallController {
        let call = CallController(audio: audio, voice: voice, makeSocket: { sockets.make() })
        let micWasOn = CallController.micWasOn
        CallController.micWasOn = false
        defer { CallController.micWasOn = micWasOn }
        call.begin(.companion(name: "Test", userName: "", profile: "", traits: [], voiceId: nil),
                   endpoint: CallEndpoint(url: URL(string: "wss://example.invalid/v1/session")!, token: nil))
        sockets.connections[0].onOpen?()
        return call
    }

    private func reconnect(_ old: ReconnectConnection, _ sockets: ReconnectSockets) async throws -> ReconnectConnection {
        old.onClose?(.failed("connection lost"))
        for _ in 0..<200 {
            if sockets.connections.count == 2 {
                let current = sockets.connections[1]
                current.onOpen?()
                return current
            }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw NSError(domain: "CallReconnectTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "reconnect did not open a new socket"])
    }

    private func ready(_ id: String, tts: String = "server") -> String {
        #"{"type":"ready","protocol":1,"sessionId":"\#(id)","mode":"chat","audio":{"in":"pcm_s16le_24000_mono","out":"pcm_s16le_24000_mono","frameHeaderBytes":8},"lip":{"requested":"none","active":"none","reason":null},"voiceId":"v","bargeIn":{"minMs":400,"minWords":2},"tts":"\#(tts)"}"#
    }
    private func timing(id: Int, seq: Int) -> String {
        #"{"type":"audio","utteranceId":\#(id),"seq":\#(seq),"sentence":0,"offsetMs":0,"durationMs":20,"sampleRate":24000,"model":"test","words":[]}"#
    }
    private func say(_ id: Int) -> String {
        #"{"type":"say","utteranceId":\#(id),"sentence":0,"text":"Hello","emotion":"neutral","lang":"en-US"}"#
    }
    private func cancelled(_ id: Int) -> String {
        #"{"type":"utterance.cancelled","utteranceId":\#(id),"reason":"barge_in"}"#
    }
    private func reply(_ id: Int) -> String {
        #"{"type":"reply","utteranceId":\#(id),"text":"Hello","emotion":"neutral","interpret":false,"final":true}"#
    }
    private func frame(seq: UInt32) -> Data {
        AudioFrameHeader(kind: GenitaProtocol.frameKindTTSPCM, seq: seq).encoded() + Data([1, 0, 2, 0])
    }
}

@MainActor private final class ReconnectAudio: CallAudioPlaying {
    var onMicFrame: (@Sendable (Data) -> Void)?
    var onPlaybackStarted: ((Int) -> Void)?
    var onUtterancePlayed: ((Int) -> Void)?
    var onInterrupted: (() -> Void)?
    var enqueued: [Int] = [], starts: [Int] = []
    private var started: Set<Int> = [], pending: Set<Int> = [], complete: Set<Int> = []
    var isPlaying: Bool { !pending.isEmpty }
    func start() {}
    func stop() { flush() }
    func openMic() -> Bool { true }
    func closeMic() {}
    func enqueue(pcm: Data, utteranceId: Int) {
        enqueued.append(utteranceId)
        pending.insert(utteranceId)
        if started.insert(utteranceId).inserted { starts.append(utteranceId); onPlaybackStarted?(utteranceId) }
    }
    func markComplete(utteranceId: Int) {
        complete.insert(utteranceId)
        if !pending.contains(utteranceId) { finish(utteranceId) }
    }
    func finish(_ id: Int) {
        pending.remove(id)
        if complete.remove(id) != nil { onUtterancePlayed?(id) }
    }
    func flush() { pending.removeAll(); complete.removeAll() }
    func resetSession() { flush(); started.removeAll() }
    func playbackPositionMs(utteranceId: Int) -> Double? { nil }
}

@MainActor private final class ReconnectVoice: CallVoiceRendering {
    var onPCM: ((Data, Int) -> Void)?
    var onRendered: ((Int) -> Void)?
    var pending: [ServerEvent.Say] = []
    var replies: [Int] = []
    private var complete: Set<Int> = []
    func say(_ sentence: ServerEvent.Say) { pending.append(sentence) }
    func replyArrived(_ id: Int) {
        replies.append(id)
        complete.insert(id)
        if !pending.contains(where: { $0.utteranceId == id }) { onRendered?(id) }
    }
    func render(_ id: Int) {
        guard pending.contains(where: { $0.utteranceId == id }) else { return }
        pending.removeAll { $0.utteranceId == id }
        onPCM?(Data([1, 0, 2, 0]), id)
        if complete.remove(id) != nil { onRendered?(id) }
    }
    func cancel() { pending.removeAll(); complete.removeAll() }
    func forget(_ utteranceId: Int) {}
    func mouthLevel(utteranceId: Int, positionMs: Double) -> Float? { nil }
}

@MainActor private final class ReconnectSockets {
    var connections: [ReconnectConnection] = []
    func make() -> ReconnectConnection {
        let socket = ReconnectConnection()
        connections.append(socket)
        return socket
    }
}

private final class ReconnectConnection: CallConnection, @unchecked Sendable {
    var onOpen: (@MainActor () -> Void)?
    var onMessage: (@MainActor (CallSocket.Incoming) -> Void)?
    var onClose: (@MainActor (CallSocket.Closure) -> Void)?
    var sent: [ClientMessage] = []
    var playbackDone: [Int] { sent.compactMap { if case let .playbackDone(id) = $0 { return id }; return nil } }
    func connect(url: URL, token: String?) {}
    func send(_ message: ClientMessage) { sent.append(message) }
    func send(audio: Data) {}
    func close() {}
    func disconnect() {}
}
