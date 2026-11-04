import XCTest
@testable import Genita

/// b17 "What's off?" hold to say (HoldToSay.swift): mic → POST /v1/transcribe (Muse Voice Transcribe) → the field.
/// Every failure ends idle, with one neutral line, the mic closed, and nothing written into the field.
@MainActor final class HoldToSayTests: XCTestCase {
    final class FakeRecorder: HoldToSayRecording {
        var permission = true
        var permissionDelay: Duration = .zero
        var startError: Error?
        var clip = Data(count: GenitaProtocol.sampleRate * 2)   // 1 s
        private(set) var starts = 0, stops = 0, cancels = 0
        /// the mic is open between a successful start and a stop / cancel
        private(set) var open = false
        func requestPermission() async -> Bool {
            if permissionDelay > .zero { try? await Task.sleep(for: permissionDelay) }
            return permission
        }
        func start() throws {
            starts += 1
            if let startError { throw startError }
            open = true
        }
        func stop() -> Data { stops += 1; open = false; return clip }
        func cancel() { cancels += 1; open = false }
    }

    struct Boom: Error {}

    /// counts calls; answers `text`, throws, or waits
    final class FakeServer: @unchecked Sendable {
        private let lock = NSLock()
        private var _calls = 0
        private var _bytes = 0
        var calls: Int { lock.withLock { _calls } }
        var bytes: Int { lock.withLock { _bytes } }
        let answer: @Sendable () async throws -> String
        init(_ answer: @escaping @Sendable () async throws -> String) { self.answer = answer }
        var transcribe: @Sendable (Data) async throws -> String {
            { [self] pcm in
                lock.withLock { _calls += 1; _bytes = pcm.count }
                return try await answer()
            }
        }
    }

    private func until(_ what: String, timeout: TimeInterval = 3, _ ok: () -> Bool) async {
        let end = Date().addingTimeInterval(timeout)
        while !ok() {
            if Date() > end { return XCTFail("timed out waiting for \(what)") }
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    func testHoldThenReleaseFillsTheFieldAfterWhatWasTyped() async {
        let mic = FakeRecorder()
        let server = FakeServer { "I actually prefer warm colors." }
        let hold = HoldToSay(recorder: mic)
        hold.start(transcribe: server.transcribe)
        XCTAssertEqual(hold.phase, .starting)
        await until("listening") { hold.listening }
        XCTAssertTrue(mic.open)
        hold.stop()
        XCTAssertFalse(mic.open, "the mic closes on release")
        XCTAssertEqual(hold.phase, .transcribing, "Transcribing… while the clip is on its way")
        await until("idle") { hold.phase == .idle }
        XCTAssertEqual(hold.heard?.words, "I actually prefer warm colors.")
        XCTAssertEqual(HoldToSay.append(hold.heard?.words ?? "", to: "  Not quite. "), "Not quite. I actually prefer warm colors.", "after what was typed")
        XCTAssertNil(hold.note)
        XCTAssertEqual(server.calls, 1)
        XCTAssertEqual(server.bytes, GenitaProtocol.sampleRate * 2, "the whole clip goes up")
    }

    func testServerErrorShowsTheNeutralLineAndLeavesTheFieldAlone() async {
        let mic = FakeRecorder()
        let server = FakeServer { throw GenitaAuthError.server(status: 404, code: "not_found", retryAfterSec: nil) }
        let hold = HoldToSay(recorder: mic)
        hold.start(transcribe: server.transcribe)
        await until("listening") { hold.listening }
        hold.stop()
        await until("idle") { hold.phase == .idle }
        XCTAssertEqual(hold.note, HoldToSay.failedLine)
        XCTAssertNil(hold.heard, "nothing is written into the field")
        XCTAssertFalse(mic.open)
        // the next hold works again
        hold.start(transcribe: FakeServer { "Blue" }.transcribe)
        await until("listening again") { hold.listening }
        XCTAssertNil(hold.note)
        hold.stop()
        await until("idle again") { hold.phase == .idle }
        XCTAssertEqual(hold.heard?.words, "Blue")
        // the same words again still reach the field (a new id)
        let first = hold.heard
        hold.start(transcribe: FakeServer { "Blue" }.transcribe)
        await until("listening 3") { hold.listening }
        hold.stop()
        await until("idle 3") { hold.phase == .idle }
        XCTAssertEqual(hold.heard?.words, "Blue")
        XCTAssertNotEqual(hold.heard, first)
    }

    func testOfflineAndEmptyAnswersAreTheSameNeutralLine() async {
        for answer in [{ throw GenitaAuthError.offline } as @Sendable () async throws -> String, { "   " }] {
            let hold = HoldToSay(recorder: FakeRecorder())
            hold.start(transcribe: FakeServer(answer).transcribe)
            await until("listening") { hold.listening }
            hold.stop()
            await until("idle") { hold.phase == .idle }
            XCTAssertEqual(hold.note, HoldToSay.failedLine)
            XCTAssertNil(hold.heard)
        }
    }

    func testASlowServerTimesOut() async {
        let server = FakeServer { try await Task.sleep(for: .seconds(30)); return "too late" }
        let hold = HoldToSay(recorder: FakeRecorder())
        hold.timeout = .milliseconds(200)
        hold.start(transcribe: server.transcribe)
        await until("listening") { hold.listening }
        let t0 = Date()
        hold.stop()
        await until("idle") { hold.phase == .idle }
        XCTAssertLessThan(Date().timeIntervalSince(t0), 2, "the deadline, not the server, ends it")
        XCTAssertEqual(hold.note, HoldToSay.failedLine)
        XCTAssertNil(hold.heard)
    }

    func testMicDeniedNeverRecordsOrCallsTheServer() async {
        let mic = FakeRecorder(); mic.permission = false
        let server = FakeServer { "x" }
        let hold = HoldToSay(recorder: mic)
        hold.start(transcribe: server.transcribe)
        await until("idle") { hold.phase == .idle }
        XCTAssertEqual(hold.note, HoldToSay.micLine)
        hold.stop()
        XCTAssertEqual(mic.starts, 0)
        XCTAssertEqual(server.calls, 0)
    }

    func testMicThatWontOpenIsReleasedAndTheLineShows() async {
        let mic = FakeRecorder(); mic.startError = Boom()
        let server = FakeServer { "x" }
        let hold = HoldToSay(recorder: mic)
        hold.start(transcribe: server.transcribe)
        await until("idle") { hold.phase == .idle && mic.starts == 1 }
        XCTAssertEqual(hold.note, HoldToSay.failedLine)
        XCTAssertEqual(mic.cancels, 1, "a half-open mic is released")
        // the finger is still down: no retry loop until it lifts
        hold.start(transcribe: server.transcribe)
        XCTAssertEqual(hold.phase, .idle)
        hold.stop()
        XCTAssertEqual(server.calls, 0)
    }

    func testLetGoWhileThePermissionPromptIsUpRecordsNothing() async {
        let mic = FakeRecorder(); mic.permissionDelay = .milliseconds(150)
        let hold = HoldToSay(recorder: mic)
        hold.start(transcribe: FakeServer { "x" }.transcribe)
        hold.stop()
        await until("idle") { hold.phase == .idle }
        try? await Task.sleep(for: .milliseconds(250))
        XCTAssertEqual(mic.starts, 0)
        XCTAssertNil(hold.note)
    }

    func testATapShorterThanAQuarterSecondSendsNothing() async {
        let mic = FakeRecorder(); mic.clip = Data(count: 2_000)
        let server = FakeServer { "x" }
        let hold = HoldToSay(recorder: mic)
        hold.start(transcribe: server.transcribe)
        await until("listening") { hold.listening }
        hold.stop()
        XCTAssertEqual(hold.phase, .idle)
        XCTAssertEqual(hold.note, HoldToSay.failedLine)
        XCTAssertEqual(server.calls, 0)
    }

    func testClosingTheSheetMidHoldOrMidSendDropsEverything() async {
        // mid hold: the mic closes, nothing is sent
        let mic = FakeRecorder()
        let server = FakeServer { "late words" }
        let hold = HoldToSay(recorder: mic)
        hold.start(transcribe: server.transcribe)
        await until("listening") { hold.listening }
        hold.cancel()
        XCTAssertFalse(mic.open)
        XCTAssertEqual(mic.cancels, 1)
        XCTAssertEqual(hold.phase, .idle)
        XCTAssertEqual(server.calls, 0)
        // mid send: the late answer changes nothing
        let slow = FakeServer { try await Task.sleep(for: .milliseconds(200)); return "late words" }
        hold.start(transcribe: slow.transcribe)
        await until("listening 2") { hold.listening }
        hold.stop()
        XCTAssertEqual(hold.phase, .transcribing)
        hold.cancel()
        XCTAssertEqual(hold.phase, .idle)
        try? await Task.sleep(for: .milliseconds(400))
        XCTAssertNil(hold.heard)
        XCTAssertNil(hold.note)
    }

    func testWithinReturnsNilOnThrowAndOnTimeout() async {
        let ok = await HoldToSay.within(.seconds(1)) { "a" }
        XCTAssertEqual(ok, "a")
        let threw = await HoldToSay.within(.seconds(1)) { throw Boom() }
        XCTAssertNil(threw)
        let slow = await HoldToSay.within(.milliseconds(50)) { try await Task.sleep(for: .seconds(5)); return "b" }
        XCTAssertNil(slow)
    }

    func testClipBufferStopsAt31Seconds() {
        let clip = ClipBuffer()
        let frame = Data(count: GenitaProtocol.sampleRate * 2 / 10)   // 100 ms
        for _ in 0..<400 { clip.append(frame) }   // 40 s offered
        XCTAssertLessThanOrEqual(clip.take().count, ClipBuffer.maxBytes)
        XCTAssertEqual(clip.take().count, 0, "take empties it")
    }
}
