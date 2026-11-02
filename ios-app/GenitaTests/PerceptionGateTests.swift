import XCTest
@testable import Genita

/// PERC-2 (#320): when the app sends a face crop for perception.
@MainActor final class PerceptionGateTests: XCTestCase {
    private let still = [UInt8](repeating: 100, count: 24 * 24)
    private let moved = [UInt8](repeating: 140, count: 24 * 24)
    private let t0 = Date(timeIntervalSince1970: 1_000)

    func testFirstFrameIsSent() {
        var gate = PerceptionGate()
        XCTAssertTrue(gate.shouldSend(now: t0, thumb: still))
    }

    func testAStillFaceIsSentEvery2_5Seconds() {
        var gate = PerceptionGate()
        _ = gate.shouldSend(now: t0, thumb: still)
        XCTAssertFalse(gate.shouldSend(now: t0 + 1.5, thumb: still))
        XCTAssertFalse(gate.shouldSend(now: t0 + 2.4, thumb: still))
        XCTAssertTrue(gate.shouldSend(now: t0 + 2.5, thumb: still))
    }

    func testAChangedFaceIsSentEarlyButNotWithin1Second() {
        var gate = PerceptionGate()
        _ = gate.shouldSend(now: t0, thumb: still)
        XCTAssertFalse(gate.shouldSend(now: t0 + 0.5, thumb: moved), "≥ 1 s apart")
        XCTAssertTrue(gate.shouldSend(now: t0 + 1.0, thumb: moved))
    }

    func testDifferenceIsMeanAbsoluteOnAZeroToOneScale() {
        XCTAssertEqual(PerceptionGate.difference(still, still), 0)
        XCTAssertEqual(PerceptionGate.difference(still, moved), 40.0 / 255.0, accuracy: 0.0001)
        XCTAssertEqual(PerceptionGate.difference(still, []), 1, "no previous thumb = changed")
    }

    func testOnlySendsWhenServerAsksCameraIsFrontAndChatting() {
        XCTAssertTrue(PerceptionGate.active(serverOn: true, cameraOn: true, front: true, mode: .chat, live: true))
        XCTAssertFalse(PerceptionGate.active(serverOn: false, cameraOn: true, front: true, mode: .chat, live: true), "flag off on the server")
        XCTAssertFalse(PerceptionGate.active(serverOn: true, cameraOn: false, front: true, mode: .chat, live: true))
        XCTAssertFalse(PerceptionGate.active(serverOn: true, cameraOn: true, front: false, mode: .chat, live: true), "rear camera = fridge, not a face")
        XCTAssertFalse(PerceptionGate.active(serverOn: true, cameraOn: true, front: true, mode: .interpret, live: true))
        XCTAssertFalse(PerceptionGate.active(serverOn: true, cameraOn: true, front: true, mode: .chat, live: false))
    }

    func testPerceptionFrameEncodesLikeTheSample() throws {
        let data = try JSONEncoder().encode(ClientMessage.perceptionFrame(image: "/9j/"))
        let o = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(o["type"] as? String, "perception.frame")
        XCTAssertEqual(o["image"] as? String, "/9j/")
    }
}

/// Codex P2 (11/3): a crop that was in flight when the sampler stopped (call ended / socket lost) never reaches a new call.
@MainActor final class PerceptionSamplerTests: XCTestCase {
    func testStaleCropFromAStoppedRunIsDropped() {
        let sampler = PerceptionSampler()
        var sent: [String] = []
        let crop = FaceCrop.Result(jpeg: Data([1, 2, 3]), thumb: [UInt8](repeating: 9, count: 576))
        sampler.start(frame: { nil }, active: { true }, send: { sent.append($0) })
        let old = sampler.generation
        sampler.stop()
        sampler.start(frame: { nil }, active: { true }, send: { sent.append($0) })
        sampler.deliver(crop, generation: old, active: true, send: { sent.append($0) })
        XCTAssertEqual(sent, [], "crop from the stopped run")
        sampler.deliver(crop, generation: sampler.generation, active: true, send: { sent.append($0) })
        XCTAssertEqual(sent, [Data([1, 2, 3]).base64EncodedString()])
        sampler.deliver(crop, generation: sampler.generation, active: false, send: { sent.append($0) })
        XCTAssertEqual(sent.count, 1, "inactive now")
        sampler.stop()
    }
}
