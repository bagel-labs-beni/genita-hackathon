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

    func testReplayAnswersAPingWithAPong() throws {
        var received: [String] = []
        let replay = try XCTUnwrap(PreviewReplay(session: "r1") { if case let .text(text) = $0 { received.append(text) } })
        replay.handle(.ping(t: 1))
        XCTAssertEqual(received.count, 1)
        XCTAssertTrue(received[0].contains("pong"))
        replay.stop()
    }
}
