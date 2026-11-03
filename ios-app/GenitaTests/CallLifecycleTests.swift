import XCTest
@testable import Genita

/// Audit 11/4 (call lane): scene, hang-up, handoff-return and local-stop rules of CallController.
@MainActor final class CallLifecycleTests: XCTestCase {
    private var savedMicWasOn = false
    private var savedGrace = 0
    override func setUp() async throws { savedMicWasOn = CallController.micWasOn; savedGrace = CallController.backgroundGraceMs }
    override func tearDown() async throws { CallController.micWasOn = savedMicWasOn; CallController.backgroundGraceMs = savedGrace }

    // IC-02 step 4 (coordinator 11/4): Home or lock and back within the grace — the same call goes on: same session,
    // no `stop`, no new `start` (so no greeting), the mic back on.
    func testBackWithinTheGraceResumesTheSameCall() async throws {
        CallController.backgroundGraceMs = 10_000
        let (call, sockets, _) = begin(micOn: true)
        defer { call.end() }
        let socket = sockets.connections[0]
        socket.onMessage?(.text(ready("s1")))
        let starts = socket.sent.filter { if case .start = $0 { return true }; return false }.count
        call.sceneActivityChanged(.background)
        XCTAssertFalse(call.micOn, "paused: the mic is closed in the background")
        XCTAssertTrue(call.inBackgroundGrace)
        try await Task.sleep(for: .milliseconds(100))
        call.sceneActivityChanged(.active)
        XCTAssertFalse(call.inBackgroundGrace)
        XCTAssertFalse(call.isEnded)
        XCTAssertTrue(call.micOn, "the mic comes back as it was")
        XCTAssertEqual(sockets.connections.count, 1, "same session")
        XCTAssertFalse(socket.closedWithStop)
        XCTAssertEqual(socket.sent.filter { if case .start = $0 { return true }; return false }.count, starts, "no new start, no greeting")
    }

    // RV-01 step 2: past the grace the paused call hangs up with `stop` (the next call greets as a new one).
    func testPastTheGraceTheCallHangsUpWithStop() async throws {
        CallController.backgroundGraceMs = 50
        let (call, sockets, _) = begin(micOn: true)
        defer { call.end() }
        sockets.connections[0].onMessage?(.text(ready("s1")))
        call.sceneActivityChanged(.background)
        for _ in 0..<50 where !call.isEnded { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(call.isEnded)
        XCTAssertTrue(sockets.connections[0].closedWithStop)
        call.sceneActivityChanged(.active)
        XCTAssertTrue(call.isEnded, "the call screen begins the new call (ConversationView.callBack)")
        XCTAssertFalse(call.micOn)
    }

    // AU-47: a permission alert, Control Center or the app switcher (.inactive) keeps the mic on; only .background closes it.
    func testInactiveSceneKeepsTheMicOnAndBackgroundClosesIt() {
        let (call, sockets, _) = begin(micOn: true)
        defer { call.end() }
        sockets.connections[0].onMessage?(.text(ready("s1")))
        XCTAssertTrue(call.micOn)
        call.sceneActivityChanged(.inactive)
        XCTAssertTrue(call.micOn, "an overlay must not close the mic")
        call.sceneActivityChanged(.active)
        XCTAssertTrue(call.micOn)
        call.sceneActivityChanged(.background)
        XCTAssertFalse(call.micOn)
        XCTAssertFalse(sockets.connections[0].closedWithStop, "background pauses, it does not hang up at once")
    }

    // AU-38: hanging up says `stop`; the call can begin again afterwards (call screen back on .active).
    func testEndSendsStopAndTheCallCanBeginAgain() {
        let (call, sockets, _) = begin(micOn: false)
        defer { call.end() }
        XCTAssertFalse(call.isEnded)
        call.end()
        XCTAssertTrue(call.isEnded)
        XCTAssertTrue(sockets.connections[0].closedWithStop)
        call.begin(start(), endpoint: endpoint())
        XCTAssertFalse(call.isEnded)
        XCTAssertEqual(sockets.connections.count, 2)
    }

    // AU-83 / AU-84: the conversation comes back from the Mac to the still-open iPhone call: a new server session
    // (seeded on the server from the Mac's turns), the old one closed without `stop`, the mic back as the user left it.
    func testRejoinReplacesTheSessionWithoutStopAndRestoresTheMic() {
        let (call, sockets, _) = begin(micOn: true)
        defer { call.end() }
        let old = sockets.connections[0]
        old.onMessage?(.text(ready("before-move")))
        XCTAssertTrue(call.micOn)
        call.suspend() // moved to the Mac
        XCTAssertFalse(call.micOn)

        call.rejoin()
        XCTAssertEqual(sockets.connections.count, 2)
        XCTAssertTrue(old.disconnected)
        XCTAssertFalse(old.closedWithStop, "a move back is not a hang-up")
        XCTAssertTrue(call.micOn, "the mic comes back on")
        let new = sockets.connections[1]
        new.onOpen?()
        XCTAssertTrue(new.sent.contains { if case .start = $0 { return true }; return false })
        old.onClose?(.normal) // the replaced socket's late close cannot start a reconnect
        XCTAssertEqual(sockets.connections.count, 2)
    }

    func testRejoinKeepsAMicTheUserLeftOff() {
        let (call, sockets, _) = begin(micOn: false)
        defer { call.end() }
        sockets.connections[0].onMessage?(.text(ready("s1")))
        call.rejoin()
        XCTAssertEqual(sockets.connections.count, 2)
        XCTAssertFalse(call.micOn)
    }

    func testRejoinDoesNothingAfterTheCallEnded() {
        let (call, sockets, _) = begin(micOn: false)
        call.end()
        call.rejoin()
        XCTAssertEqual(sockets.connections.count, 1)
    }

    // AU-50: a tap stops the reply here; frames of it already on their way do not play again.
    func testInterruptDropsLateFramesOfTheStoppedReply() {
        let (call, sockets, audio) = begin(micOn: false)
        defer { call.end() }
        let socket = sockets.connections[0]
        socket.onMessage?(.text(ready("s1")))
        socket.onMessage?(.text(timing(id: 1, seq: 1)))
        socket.onMessage?(.binary(frame(seq: 1)))
        XCTAssertTrue(call.playing)
        call.interrupt()
        XCTAssertFalse(call.playing)
        XCTAssertTrue(socket.sent.contains(.bargeIn))
        socket.onMessage?(.text(timing(id: 1, seq: 2)))
        socket.onMessage?(.binary(frame(seq: 2)))
        XCTAssertEqual(audio.enqueued, [1], "the in-flight frame of the stopped reply is dropped")
        XCTAssertFalse(call.playing)
        // the next reply plays
        socket.onMessage?(.text(timing(id: 2, seq: 3)))
        socket.onMessage?(.binary(frame(seq: 3)))
        XCTAssertEqual(audio.enqueued, [1, 2])
    }

    // AU-82 (GATE-A): once the conversation is on the Mac, nothing more of the companion plays on this iPhone.
    func testNoCompanionSoundWhileTheMacOwnsTheConversation() {
        let ownership = PhoneHandoff.shared.ownership
        let (call, sockets, audio) = begin(micOn: false)
        defer { call.end() }
        let socket = sockets.connections[0]
        socket.onMessage?(.text(ready("s1")))
        let epoch = ownership.state.epoch
        ownership.receive(OwnershipClaim(owner: .mac, epoch: epoch + 1))
        defer { ownership.receive(OwnershipClaim(owner: .phone, epoch: epoch + 2)) }
        XCTAssertFalse(ownership.isOwner)
        socket.onMessage?(.text(timing(id: 1, seq: 1)))
        socket.onMessage?(.binary(frame(seq: 1)))
        XCTAssertEqual(audio.enqueued, [], "the rest of a reply after the move is silent here")
        XCTAssertFalse(call.playing)
    }

    // AU-48: an engine rebuild keeps what is still to be heard, cut where the old player was.
    func testPlaybackCarryKeepsTheUnheardPart() {
        typealias E = PlaybackCarry.Entry<String>
        let queue = [E(utteranceId: 1, start: 0, frames: 100, buffer: "a"),
                     E(utteranceId: 1, start: 100, frames: 100, buffer: "b"),
                     E(utteranceId: 2, start: 200, frames: 50, buffer: "c")]
        let kept = PlaybackCarry.remaining(queue, playedTo: 130)
        XCTAssertEqual(kept.map(\.buffer), ["b", "c"])
        XCTAssertEqual(kept.map(\.skip), [30, 0])
        XCTAssertEqual(PlaybackCarry.remaining(queue, playedTo: nil).map(\.skip), [0, 0, 0])
        XCTAssertTrue(PlaybackCarry.remaining(queue, playedTo: 250).isEmpty)
    }

    // MARK: helpers

    private func begin(micOn: Bool) -> (CallController, LifecycleSockets, LifecycleAudio) {
        let audio = LifecycleAudio(), sockets = LifecycleSockets()
        let call = CallController(audio: audio, voice: LifecycleVoice(), makeSocket: { sockets.make() })
        // DEBUG fixture mic: turns on without the system permission prompt
        call.fixture = FixtureMic(steps: [], send: { _ in }, ended: { _ in })
        CallController.micWasOn = micOn
        call.begin(start(), endpoint: endpoint())
        sockets.connections[0].onOpen?()
        return (call, sockets, audio)
    }
    private func start() -> ClientMessage.Start { .companion(name: "Test", userName: "", profile: "", traits: [], voiceId: nil) }
    private func endpoint() -> CallEndpoint { CallEndpoint(url: URL(string: "wss://example.invalid/v1/session")!, token: nil) }
    private func ready(_ id: String) -> String {
        #"{"type":"ready","protocol":1,"sessionId":"\#(id)","mode":"chat","audio":{"in":"pcm_s16le_24000_mono","out":"pcm_s16le_24000_mono","frameHeaderBytes":8},"lip":{"requested":"none","active":"none","reason":null},"voiceId":"v","bargeIn":{"minMs":400,"minWords":2},"tts":"server"}"#
    }
    private func timing(id: Int, seq: Int) -> String {
        #"{"type":"audio","utteranceId":\#(id),"seq":\#(seq),"sentence":0,"offsetMs":0,"durationMs":20,"sampleRate":24000,"model":"test","words":[]}"#
    }
    private func frame(seq: UInt32) -> Data {
        AudioFrameHeader(kind: GenitaProtocol.frameKindTTSPCM, seq: seq).encoded() + Data([1, 0, 2, 0])
    }
}

@MainActor private final class LifecycleAudio: CallAudioPlaying {
    var onMicFrame: (@Sendable (Data) -> Void)?
    var onPlaybackStarted: ((Int) -> Void)?
    var onUtterancePlayed: ((Int) -> Void)?
    var onInterrupted: (() -> Void)?
    var enqueued: [Int] = []
    private var started: Set<Int> = [], pending: Set<Int> = []
    var isPlaying: Bool { !pending.isEmpty }
    func start() {}
    func stop() { flush() }
    func openMic() -> Bool { true }
    func closeMic() {}
    func enqueue(pcm: Data, utteranceId: Int) {
        enqueued.append(utteranceId)
        pending.insert(utteranceId)
        if started.insert(utteranceId).inserted { onPlaybackStarted?(utteranceId) }
    }
    func markComplete(utteranceId: Int) {}
    func flush() { pending.removeAll() }
    func resetSession() { flush(); started.removeAll() }
    func playbackPositionMs(utteranceId: Int) -> Double? { nil }
}

@MainActor private final class LifecycleVoice: CallVoiceRendering {
    var onPCM: ((Data, Int) -> Void)?
    var onRendered: ((Int) -> Void)?
    func say(_ sentence: ServerEvent.Say) {}
    func replyArrived(_ id: Int) {}
    func cancel() {}
    func forget(_ utteranceId: Int) {}
    func mouthLevel(utteranceId: Int, positionMs: Double) -> Float? { nil }
}

@MainActor private final class LifecycleSockets {
    var connections: [LifecycleConnection] = []
    func make() -> LifecycleConnection {
        let socket = LifecycleConnection()
        connections.append(socket)
        return socket
    }
}

private final class LifecycleConnection: CallConnection, @unchecked Sendable {
    var onOpen: (@MainActor () -> Void)?
    var onMessage: (@MainActor (CallSocket.Incoming) -> Void)?
    var onClose: (@MainActor (CallSocket.Closure) -> Void)?
    var sent: [ClientMessage] = []
    var closedWithStop = false
    var disconnected = false
    func connect(url: URL, token: String?) {}
    func send(_ message: ClientMessage) { sent.append(message) }
    func send(audio: Data) {}
    func close() { closedWithStop = true }
    func disconnect() { disconnected = true }
}
