import XCTest
@testable import Genita

/// Appetize browser preview (shared/Call/BrowserPreview.swift): off unless launched with `--browser-preview`,
/// and its recorded sessions are real PROTOCOL.md events.
@MainActor final class BrowserPreviewTests: XCTestCase {
    func testOffWithoutTheLaunchArgument() {
        XCTAssertFalse(BrowserPreview.isActive, "a normal launch (and the unit test host) is not the preview")
    }

    func testRecordedSessionsDecodeAsServerEvents() throws {
        for session in ["r1", "int"] {
            let url = try XCTUnwrap(Bundle.main.url(forResource: "preview-session-\(session)", withExtension: "json"), session)
            let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            var events = try XCTUnwrap(root["handshake"] as? [[String: Any]])
            events += try XCTUnwrap(root["timeline"] as? [[String: Any]]).compactMap { $0["event"] as? [String: Any] }
            XCTAssertGreaterThan(events.count, 20, session)
            for event in events {
                let text = String(decoding: try JSONSerialization.data(withJSONObject: event), as: UTF8.self)
                XCTAssertNoThrow(try ServerEvent.decode(text), "\(session): \(text.prefix(80))")
            }
        }
    }

    /// UI QA CW (build 10): with the half sheet up the boxes sat ~140 pt above the fridge items, because the preview's
    /// stand-in camera showed frame 0 while the recorded recipe run's boxes are on frame 1. The preview camera is the
    /// frame the boxes were found on.
    func testPreviewCameraIsTheFrameTheRecipeBoxesWereFoundOn() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "finds-fixture", withExtension: "json"))
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let recipe = try XCTUnwrap((root["runs"] as? [[String: Any]])?.first { $0["kind"] as? String == "recipe" })
        let frames = try XCTUnwrap(recipe["frames"] as? [String])
        let boxFrames = Set(try XCTUnwrap(recipe["events"] as? [[String: Any]]).filter { $0["type"] as? String == "observe.boxes" }.compactMap { $0["frame"] as? Int })
        XCTAssertEqual(boxFrames.count, 1, "one camera frame for every box batch of the run")
        let frame = try XCTUnwrap(boxFrames.first)
        XCTAssertEqual(BrowserPreview.fixtureCamera, "bundle:" + frames[frame])
        XCTAssertNotNil(Bundle.main.url(forResource: frames[frame], withExtension: "jpg"), "bundled like the UI tests' camera")
    }

    func testReplayAnswersAPingWithAPong() throws {
        var received: [String] = []
        let replay = try XCTUnwrap(PreviewReplay(session: "r1") { if case let .text(text) = $0 { received.append(text) } })
        replay.handle(.ping(t: 1))
        XCTAssertEqual(received.count, 1)
        XCTAssertTrue(received[0].contains("pong"))
        replay.stop()
    }
}
