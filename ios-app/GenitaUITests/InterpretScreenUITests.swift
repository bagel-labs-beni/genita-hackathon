import XCTest

/// F8-U-INT · iPhone interpretation states INT-1/2/3/5/6 on the real call screen, driven by a
/// recorded real interpret session (ios-app/Tools/call-replay/session-int.json, replayed on
/// 127.0.0.1:8789 by the Interpretation workflow). INT-4 (hold pressed) is a local press state;
/// its rendering is covered by the GenitaKit screen render.
final class InterpretScreenUITests: XCTestCase {
    func testInterpretStatesFromRecordedSession() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        app.launchEnvironment = [
            "GENITA_REVIEW_STAGE": "conversation",
            "GENITA_SERVER_URL": "ws://127.0.0.1:8789/v1/session",
            "GENITA_FIXTURE_SCRIPT": "none",
            "GENITA_CALL_AUTOMIC": "1",
        ]
        app.launch()
        let bar = app.descendants(matching: .any).matching(identifier: "interpretBar").firstMatch
        let speaker = app.descendants(matching: .any).matching(identifier: "interpretSpeaker").firstMatch

        func capture(_ name: String) {
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.name = "int-" + name
            shot.lifetime = .keepAlways
            add(shot)
        }
        func wait(_ element: XCUIElement, timeout: TimeInterval = 40, _ ok: (String) -> Bool) -> Bool {
            let end = Date().addingTimeInterval(timeout)
            while Date() < end {
                if element.exists, ok(element.label) { return true }
                Thread.sleep(forTimeInterval: 0.05)
            }
            return false
        }

        XCTAssertTrue(bar.waitForExistence(timeout: 15), "the recorded session starts in interpret mode")
        XCTAssertTrue(wait(bar) { $0.contains("Listening for the other language") }, "INT-1")
        XCTAssertTrue(app.buttons["interpretHold"].exists)
        XCTAssertFalse(app.buttons["micToggle"].exists)
        capture("INT-1-listening")
        XCTAssertTrue(wait(speaker) { $0.hasPrefix("Them") && $0.contains("Korean") }, "INT-2"); capture("INT-2-them-speaking")
        XCTAssertTrue(wait(bar) { $0.contains("Korean ↔ English") }, "pair detected")
        XCTAssertTrue(wait(speaker) { $0.contains("saying it in English") }, "INT-3"); capture("INT-3-jin-says-it")
        // INT-5: my English with its Korean line. "Jin · saying it in Korean" lasts ~1.5 s in the recording,
        // shorter than a UI query round trip on CI, so wait for the bubble itself (it stays until INT-6).
        let mine = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'interpretBubble' AND label CONTAINS '2호선'")).firstMatch
        XCTAssertTrue(mine.waitForExistence(timeout: 40), "INT-5"); capture("INT-5-my-reply-in-korean")
        XCTAssertTrue(wait(bar) { $0.contains("Couldn’t tell the language") }, "INT-6"); capture("INT-6-unclear")
        app.buttons["interpretStop"].tap()
        XCTAssertTrue(app.buttons["micToggle"].waitForExistence(timeout: 5), "back to the call screen")
        capture("INT-off")
    }
}
