import XCTest

/// F4-U-S09 · The call screen through its states, driven by a recorded real session
/// (ios-app/Tools/call-replay/server.mjs on 127.0.0.1:8788; the Call client workflow starts it).
final class CallScreenUITests: XCTestCase {
    func testCallStatesFromRecordedSession() throws {

        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        app.launchEnvironment = [
            "GENITA_REVIEW_STAGE": "conversation",
            "GENITA_SERVER_URL": "ws://127.0.0.1:8788/v1/session",
            "GENITA_FIXTURE_SCRIPT": "none", // fixture mic: no simulator mic or permission prompt
            "GENITA_CALL_AUTOMIC": "1",
            "GENITA_INTERRUPT_HOLD_MS": "5000", // the workflow also replays at --scale 3
            "GENITA_REVIEW_STILL": "1", // still face, no wave/spinner motion: the app goes idle between events
        ]
        app.launch()
        let cue = app.descendants(matching: .any).matching(identifier: "callCue").firstMatch

        func capture(_ name: String) {
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.name = "call-" + name
            shot.lifetime = .keepAlways
            add(shot)
        }
        func waitCue(_ prefix: String, timeout: TimeInterval = 60) -> Bool {
            let end = Date().addingTimeInterval(timeout)
            while Date() < end {
                if cue.exists, cue.label.hasPrefix(prefix) { return true }
                Thread.sleep(forTimeInterval: 0.05)
            }
            return false
        }

        XCTAssertTrue(app.buttons["micToggle"].waitForExistence(timeout: 10))
        capture("S09-start")
        XCTAssertTrue(waitCue("Listening"), "S09-L"); capture("S09-L-listening")
        XCTAssertEqual(app.buttons["micToggle"].label, "Turn microphone off")
        XCTAssertTrue(waitCue("Jin is thinking"), "thinking"); capture("S09-thinking")
        XCTAssertTrue(waitCue("Jin is talking"), "S09-S"); capture("S09-S-speaking")
        XCTAssertTrue(waitCue("Stopped. Go ahead."), "S09-X"); capture("S09-X-interrupted")
        XCTAssertTrue(waitCue("Listening", timeout: 15), "S09-X returns to Listening after the hold")
        XCTAssertTrue(waitCue("Jin is talking"), "second reply")
        XCTAssertTrue(waitCue("Couldn’t get an answer."), "S09-F"); capture("S09-F-answer-failed")
        XCTAssertTrue(waitCue("Reconnecting"), "S09-R"); capture("S09-R-reconnecting")
        XCTAssertTrue(waitCue("Listening", timeout: 40), "back after reconnect")

        app.buttons["more"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["moreSheet"].waitForExistence(timeout: 5))
        capture("MORE-B2-sheet")
        XCTAssertFalse(app.buttons["moreTextChat"].exists, "Text chat stays hidden while the bundled app-config flag is false")
        XCTAssertFalse(app.buttons["moreFlip"].isEnabled, "Flip camera needs the camera on")
        // INT-0: switching interpretation on closes the sheet and shows INT-1 over the face
        app.buttons["moreInterpret"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["interpretBar"].waitForExistence(timeout: 5), "INT-1")
        XCTAssertFalse(app.buttons["micToggle"].exists, "the rail gives way to the interpretation overlay")
        capture("MORE-B2-interpret-on")
        app.buttons["interpretStop"].tap()
        XCTAssertTrue(app.buttons["micToggle"].waitForExistence(timeout: 5))
        app.buttons["micToggle"].tap()
        Thread.sleep(forTimeInterval: 0.5)
        capture("S09-mic-off")
    }
}
