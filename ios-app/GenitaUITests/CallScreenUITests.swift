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
            // L4: GenitaKit's fixture face set from the checkout, so the shots show the rendered Meta face
            "GENITA_FACE_SET_DIR": URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
                .appending(path: "shared/GenitaKit/Tests/GenitaKitTests/Fixtures/face-animal").path,
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
        // Chelsea P1: the call's first frame is a face layer of the companion (live / its poster / the scene), never the upload photo
        let face = app.descendants(matching: .any)["companionFace"]
        XCTAssertTrue(face.waitForExistence(timeout: 10))
        XCTAssertTrue(["live", "poster", "still", "ground"].contains(face.value as? String ?? ""), "face layer: \(String(describing: face.value))")
        // the S09 face is the companion's processed face (the face set's live frame or its rest-frame poster), not a still
        let faceEnd = Date().addingTimeInterval(8)
        while Date() < faceEnd, !["live", "poster"].contains(face.value as? String ?? "") { Thread.sleep(forTimeInterval: 0.1) }
        XCTAssertTrue(["live", "poster"].contains(face.value as? String ?? ""), "S09 shows the generated face, got \(String(describing: face.value))")
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

        // right after the reconnect the screen redraws; on a loaded runner the first tap can be lost (run 41536584305:
        // Listening was up, the rail visible, no sheet) — one more tap, then the sheet must be there
        let moreSheet = app.descendants(matching: .any)["moreSheet"]
        let more = app.buttons["more"]
        let moreFrame = more.frame, moreHittable = more.isHittable, moreEnabled = more.isEnabled
        more.tap()
        if !moreSheet.waitForExistence(timeout: 5) {
            // #291 family: did the first tap reach the action (more:N), did the sheet state flip (moreOpen), what is the link
            let probe = app.descendants(matching: .any)["debugInterpretProbe"].firstMatch
            let line = "MORE-291 probe=\(probe.exists ? probe.label : "missing") frame=\(moreFrame) hittable=\(moreHittable) enabled=\(moreEnabled)"
            print(line); print(String(app.debugDescription.prefix(6000)))
            let note = XCTAttachment(string: line + "\n\n" + app.debugDescription); note.name = "more-291-diagnostics"; note.lifetime = .keepAlways; add(note)
            more.tap()
        }
        XCTAssertTrue(moreSheet.waitForExistence(timeout: 5))
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

    /// D48 ①: a `profile.updated` in the call shows "Updated: no cilantro" under the status line, then it goes.
    /// The finds replay server (8789) only provides a live session; GENITA_PROFILE_CHIP=1 injects the event.
    func testProfileUpdatedChip() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        app.launchEnvironment = [
            "GENITA_REVIEW_STAGE": "conversation",
            "GENITA_SERVER_URL": "ws://127.0.0.1:8789/v1/session",
            "GENITA_PROFILE_CHIP": "1",
            "GENITA_PROFILE_CHIP_MS": "6000", // slow simulators: room to see it before it goes
            "GENITA_REVIEW_STILL": "1",
        ]
        app.launch()
        let chip = app.descendants(matching: .any).matching(identifier: "profileChip").firstMatch
        XCTAssertTrue(chip.waitForExistence(timeout: 20), "the Updated chip shows")
        XCTAssertTrue(chip.label.contains("Updated: no cilantro"))
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "call-S09-profile-updated-chip"
        shot.lifetime = .keepAlways
        add(shot)
        XCTAssertTrue(chip.waitForNonExistence(timeout: 15), "and goes after its time")
    }

    /// GK-1: `profile.asking` shows the soft "Getting to know you · {topic}" chip; the saved answer replaces it with
    /// CC-1 "Noted: …".
    func testProfileAskingChipThenNoted() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        app.launchEnvironment = [
            "GENITA_REVIEW_STAGE": "conversation",
            "GENITA_SERVER_URL": "ws://127.0.0.1:8789/v1/session",
            "GENITA_PROFILE_CHIP": "asking",
            "GENITA_ASKING_CHIP_MS": "20000",
            "GENITA_PROFILE_CHIP_MS": "6000",
            "GENITA_REVIEW_STILL": "1",
        ]
        app.launch()
        let asking = app.descendants(matching: .any).matching(identifier: "askingChip").firstMatch
        XCTAssertTrue(asking.waitForExistence(timeout: 20), "GK-1 shows")
        XCTAssertTrue(asking.label.contains("Getting to know you · How chatty calls should be"))
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "call-S09-GK1-asking"; shot.lifetime = .keepAlways; add(shot)
        let noted = app.descendants(matching: .any).matching(identifier: "profileChip").firstMatch
        XCTAssertTrue(noted.waitForExistence(timeout: 15), "the answer is saved: CC-1")
        XCTAssertTrue(noted.label.contains("Noted: quiet company"))
        XCTAssertFalse(asking.exists, "the question chip goes once it's answered")
        let shot2 = XCTAttachment(screenshot: app.screenshot()); shot2.name = "call-S09-CC1-noted"; shot2.lifetime = .keepAlways; add(shot2)
    }
}
