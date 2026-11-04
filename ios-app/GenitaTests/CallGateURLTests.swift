import XCTest
@testable import Genita

/// MV-01 (GATE-A): the call socket opts into the server's audio gate with this device and its last known owner.
@MainActor final class CallGateURLTests: XCTestCase {
    private func query(_ url: URL) -> [String: String] {
        Dictionary(uniqueKeysWithValues: (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
    }

    func testGatedURLNamesTheDeviceAndItsLastKnownOwner() throws {
        let base = URL(string: "wss://example.invalid/v1/session")!
        let url = CallEndpoint.gated(base, device: .phone, owner: .mac, epoch: 7)
        XCTAssertEqual(url.path, "/v1/session")
        XCTAssertEqual(query(url), ["device": "iphone", "owner": "mac", "epoch": "7"])
    }

    func testServerOwnershipOnTheCallSocketIsParsed() {
        XCTAssertEqual(CallController.serverOwnership(#"{"type":"ownership","owner":"mac","epoch":5,"by":null,"trigger":"current"}"#), OwnershipClaim(owner: .mac, epoch: 5))
        XCTAssertNil(CallController.serverOwnership(#"{"type":"ownership","owner":null,"epoch":6}"#), "a release is not a claim")
        XCTAssertNil(CallController.serverOwnership(#"{"type":"reply","text":"ownership"}"#))
    }

    /// #652 merge condition: when the server says the Mac holds the conversation (heard on the gated call socket), the
    /// iPhone leaves the silent call for R1 "Continue on your Mac." with Continue here, and Continue here takes it back.
    func testServerSaysTheMacOwnsItSoTheIPhoneShowsR1WithContinueHere() throws {
        let handoff = PhoneHandoff.shared
        handoff.setAccount("gate-test-\(UUID().uuidString.prefix(8))")
        defer { handoff.setAccount(nil) }
        XCTAssertTrue(handoff.ownership.isOwner, "a fresh account starts on this iPhone")
        let epoch = handoff.ownership.state.epoch
        CallController.shared.handle(#"{"type":"ownership","owner":"mac","epoch":\#(epoch + 3),"conversationId":"c","by":"mac","trigger":"move"}"#)
        XCTAssertFalse(handoff.ownership.isOwner, "the call socket's owner reached the handoff layer")
        XCTAssertNotEqual(handoff.surface, .active)
        let copy = try XCTUnwrap(HandoffCopy.phone(handoff.surface), "the R1 / R1-E waiting sheet (it carries Continue here)")
        XCTAssertTrue([HandoffCopy.phoneWaiting, .phoneUnreachable].contains(copy))
        handoff.continueHere()
        XCTAssertTrue(handoff.ownership.isOwner, "Continue here takes the conversation back")
        XCTAssertEqual(handoff.surface, .active)
    }

    func testFreshInstallPresenceUsesTheDeployedServer() throws {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        let presence = try XCTUnwrap(PresenceEndpoint.current(device: .phone, environment: [:], defaults: defaults))
        XCTAssertEqual(presence.url.host, URL(string: CallEndpoint.defaultURL)?.host, "not 127.0.0.1 (#289 F5)")
        XCTAssertEqual(presence.url.path, "/v1/presence")
    }

    func testGatedURLKeepsOtherQueryItemsAndReplacesOldGateItems() throws {
        let base = URL(string: "ws://127.0.0.1:8788/v1/session?x=1&device=mac&epoch=3")!
        let url = CallEndpoint.gated(base, device: .phone, owner: .phone, epoch: 0)
        XCTAssertEqual(query(url), ["x": "1", "device": "iphone", "owner": "iphone", "epoch": "0"])
    }

    func testTheCallConnectsWithTheGatedURL() throws {
        final class Recorder: CallConnection, @unchecked Sendable {
            var onOpen: (@MainActor () -> Void)?
            var onMessage: (@MainActor (CallSocket.Incoming) -> Void)?
            var onClose: (@MainActor (CallSocket.Closure) -> Void)?
            var url: URL?
            func connect(url: URL, token: String?) { self.url = url }
            func send(_ message: ClientMessage) {}
            func send(audio: Data) {}
            func close() {}
            func disconnect() {}
        }
        @MainActor final class SilentAudio: CallAudioPlaying {
            var onMicFrame: (@Sendable (Data) -> Void)?
            var onPlaybackStarted: ((Int) -> Void)?
            var onUtterancePlayed: ((Int) -> Void)?
            var onInterrupted: (() -> Void)?
            var isPlaying: Bool { false }
            func start() {}
            func stop() {}
            func openMic() -> Bool { true }
            func closeMic() {}
            func enqueue(pcm: Data, utteranceId: Int) {}
            func markComplete(utteranceId: Int) {}
            func flush() {}
            func resetSession() {}
            func playbackPositionMs(utteranceId: Int) -> Double? { nil }
        }
        @MainActor final class SilentVoice: CallVoiceRendering {
            var onPCM: ((Data, Int) -> Void)?
            var onRendered: ((Int) -> Void)?
            func say(_ sentence: ServerEvent.Say) {}
            func replyArrived(_ utteranceId: Int) {}
            func cancel() {}
            func forget(_ utteranceId: Int) {}
            func mouthLevel(utteranceId: Int, positionMs: Double) -> Float? { nil }
        }
        let recorder = Recorder()
        let call = CallController(audio: SilentAudio(), voice: SilentVoice(), makeSocket: { recorder })
        let micWasOn = CallController.micWasOn
        CallController.micWasOn = false
        defer { CallController.micWasOn = micWasOn; call.end() }
        call.begin(.companion(name: "Test", userName: "", profile: "", traits: [], voiceId: nil),
                   endpoint: CallEndpoint(url: URL(string: "wss://example.invalid/v1/session")!, token: nil))
        let url = try XCTUnwrap(recorder.url)
        let state = PhoneHandoff.shared.ownership.state
        XCTAssertEqual(query(url), ["device": "iphone", "owner": state.owner.serverName, "epoch": String(state.epoch)])
    }
}
