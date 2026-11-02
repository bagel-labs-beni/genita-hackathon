import XCTest

/// F10-U-FINDS (Finds tab: F0 empty, F1 list, F2 reopen) and F5-U-CAM (CAM-H boxes over the live preview).
/// Screens come from recorded cards/events (Resources/finds-fixture.json), the call itself from the replay server on 8789.
/// Compare with design-r02/revisions/r03/board.html (Finds 탭에서 다시 열기) and design-flow/revisions/r01/board.html (CAM-H).
final class FindsTabUITests: XCTestCase {
    private func launch(_ extra: [String: String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        var env = ["GENITA_REVIEW_STAGE": "conversation", "GENITA_SERVER_URL": "ws://127.0.0.1:8789/v1/session"]
        env.merge(extra) { $1 }
        app.launchEnvironment = env
        app.launch()
        return app
    }

    private func capture(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "call-" + name
        shot.lifetime = .keepAlways
        add(shot)
    }

    private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }

    private func assertNoCallCue(_ app: XCUIApplication, _ screen: String) {
        XCTAssertFalse(any(app, "callCue").exists, "\(screen): the call-only cue is not shown over Finds")
    }

    func testFindsListFrame() throws {
        let app = launch(["GENITA_FINDS_TAB": "list"])
        XCTAssertTrue(any(app, "findsList").waitForExistence(timeout: 20), "F1: the list")
        assertNoCallCue(app, "F1")
        XCTAssertTrue(app.buttons["findsRow-Kimchi fried rice with tofu and egg"].waitForExistence(timeout: 5), "saved card")
        XCTAssertTrue(any(app, "findsDay-Saved").exists, "Saved heading")
        XCTAssertTrue(any(app, "findsDay-From today’s call").exists)
        XCTAssertTrue(any(app, "findsDay-Yesterday").exists)
        Thread.sleep(forTimeInterval: 1.0) // pictures
        capture(app, "finds-tab-F1-list")
    }

    func testEmptyFrame() throws {
        let app = launch(["GENITA_FINDS_TAB": "empty"])
        XCTAssertTrue(any(app, "findsEmpty").waitForExistence(timeout: 20), "F0: empty state")
        XCTAssertTrue(app.buttons["findsBackToCall"].exists)
        Thread.sleep(forTimeInterval: 0.6)
        capture(app, "finds-tab-F0-empty")
        app.buttons["findsBackToCall"].tap()
        XCTAssertTrue(app.buttons["more"].waitForExistence(timeout: 5), "back on the call")
    }

    func testReopenCardThenTalkAboutIt() throws {
        let app = launch(["GENITA_FINDS_TAB": "detail"])
        let sheet = any(app, "findsSheet")
        XCTAssertTrue(sheet.waitForExistence(timeout: 25), "F2: card in the sheet over the list")
        assertNoCallCue(app, "F2")
        Thread.sleep(forTimeInterval: 1.5)
        XCTAssertEqual(sheet.value as? String, "half")
        XCTAssertTrue(any(app, "findCamera").exists, "the camera moment is kept with the card")
        XCTAssertTrue(app.buttons["findTalk"].exists, "button continues the call")
        // Figma F2 (138:2): 520 tall sheet with the X, CTA 58 above the bottom
        XCTAssertTrue(app.buttons["findCloseCard"].exists, "F2 has the X close button")
        capture(app, "finds-tab-F2-reopen")
        app.buttons["findTalk"].tap()
        Thread.sleep(forTimeInterval: 0.8)
        XCTAssertFalse(any(app, "findsTab").exists, "tab closed, the card stays over the call")
        XCTAssertEqual(sheet.value as? String, "half")
        XCTAssertTrue(any(app, "callCue").waitForExistence(timeout: 5), "back on the call: current cue returns")
        capture(app, "finds-tab-F2-talk")
    }

    /// The X on a reopened card goes back to the list (nothing to undo: it never left Finds).
    func testReopenedCardCloseGoesBackToList() throws {
        let app = launch(["GENITA_FINDS_TAB": "detail"])
        XCTAssertTrue(any(app, "findsSheet").waitForExistence(timeout: 25))
        let x = app.buttons["findCloseCard"]
        XCTAssertTrue(x.waitForExistence(timeout: 5))
        x.tap()
        XCTAssertTrue(any(app, "findsList").waitForExistence(timeout: 5), "back on the list")
        XCTAssertFalse(any(app, "findsSheet").exists, "the sheet is gone")
    }

    func testSwipeDeleteThenUndo() throws {
        let app = launch(["GENITA_FINDS_TAB": "list"])
        let row = app.buttons["findsRow-Wear the trench coat."]
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        row.swipeLeft()
        XCTAssertTrue(app.buttons["findDelete"].waitForExistence(timeout: 3), "swipe shows Delete")
        capture(app, "finds-tab-swipe")
        app.buttons["findDelete"].tap()
        XCTAssertTrue(any(app, "findsToast").waitForExistence(timeout: 3), "Deleted · Undo")
        XCTAssertFalse(row.exists, "the row left the list")
        capture(app, "finds-tab-delete-undo")
        app.buttons["findsUndo"].tap()
        XCTAssertTrue(row.waitForExistence(timeout: 3), "Undo brings it back")
    }

    // MARK: CAM-H

    private let camera = ["GENITA_FIXTURE_CAMERA": "bundle:finds-frame-fridge-1", "GENITA_CALL_AUTOCAMERA": "1", "GENITA_FIXTURE_SCRIPT": "none"]

    /// Boxes pop on the live preview, then fade (the board's 4 s).
    func testBoxesOverLivePreviewThenFade() throws {
        let app = launch(camera.merging(["GENITA_FINDS_STATE": "30"]) { $1 })
        XCTAssertTrue(any(app, "cameraStage").waitForExistence(timeout: 25), "camera is the stage")
        XCTAssertTrue(any(app, "cameraPip").exists, "the face is the small window")
        Thread.sleep(forTimeInterval: 1.2) // pop 240 ms + 60 ms steps
        capture(app, "cam-H-boxes")
        Thread.sleep(forTimeInterval: 4.5)
        capture(app, "cam-H-faded")
    }

    /// Demo S3 · SAM pixel masks behind GENITA_SAM_MASKS_UI=1 (off by default): soft masks + one label per ingredient,
    /// from live #298 observe.boxes recorded on these frames. Captures for Chelsea's look before the flag goes on.
    /// `-c` = option (c): 25% fill, labels kept clear of the menu button and the PiP.
    func testSamMasksOverLivePreview() throws {
        for (state, frame, name) in [("33", "bundle:finds-frame-fridge-1", "cam-H-masks-fridge-c"), ("34", "bundle:finds-frame-counter-0", "cam-H-masks-counter-c")] {
            let app = launch(camera.merging(["GENITA_FINDS_STATE": state, "GENITA_FIXTURE_CAMERA": frame, "GENITA_SAM_MASKS_UI": "1"]) { $1 })
            XCTAssertTrue(any(app, "cameraStage").waitForExistence(timeout: 25), "camera is the stage")
            Thread.sleep(forTimeInterval: 1.4)
            capture(app, name)
            app.terminate()
        }
    }

    /// An ingredient chip is pressed: its box is lit, the others step back, the scene dims.
    func testChipLightsItsBox() throws {
        let app = launch(camera.merging(["GENITA_FINDS_STATE": "32"]) { $1 })
        XCTAssertTrue(any(app, "findsSheet").waitForExistence(timeout: 25))
        XCTAssertTrue(any(app, "cameraStage").waitForExistence(timeout: 15))
        Thread.sleep(forTimeInterval: 1.0)
        capture(app, "cam-H-chip-egg")
    }
}

// MARK: - CAM-1 and FT-NOSEE

/// F5-U-CAM: CAM-1 first camera notice (Figma 57:2) and FT-NOSEE "I don't see X" card (Figma 59:2).
final class CameraGuideUITests: XCTestCase {
    private let camera = ["GENITA_FIXTURE_CAMERA": "bundle:finds-frame-fridge-1", "GENITA_FIXTURE_SCRIPT": "none"]

    private func launch(_ extra: [String: String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        var env = ["GENITA_REVIEW_STAGE": "conversation", "GENITA_SERVER_URL": "ws://127.0.0.1:8789/v1/session"]
        env.merge(camera) { $1 }
        env.merge(extra) { $1 }
        app.launchEnvironment = env
        app.launch()
        return app
    }

    private func capture(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "call-" + name
        shot.lifetime = .keepAlways
        add(shot)
    }

    private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }

    /// First tap on the camera button: the notice, not the camera. "Turn on camera" then starts it.
    func testFirstCameraTapShowsGuideThenTurnsOn() throws {
        let app = launch(["GENITA_CAM1": "fresh"])
        let toggle = app.buttons["cameraToggle"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 25))
        toggle.tap()
        XCTAssertTrue(any(app, "cameraGuide").waitForExistence(timeout: 5), "CAM-1 first camera notice")
        XCTAssertTrue(app.staticTexts["I only see when it’s on."].exists)
        XCTAssertFalse(any(app, "cameraStage").exists, "the camera is not on yet")
        Thread.sleep(forTimeInterval: 0.8)
        capture(app, "cam-1-first-notice")
        app.buttons["cameraGuideTurnOn"].tap()
        XCTAssertTrue(any(app, "cameraStage").waitForExistence(timeout: 8), "Turn on camera starts the camera")
        XCTAssertFalse(any(app, "cameraGuide").exists)
    }

    func testNotNowLeavesCameraOff() throws {
        let app = launch(["GENITA_CAM1": "fresh"])
        let toggle = app.buttons["cameraToggle"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 25))
        toggle.tap()
        XCTAssertTrue(app.buttons["cameraGuideNotNow"].waitForExistence(timeout: 5))
        app.buttons["cameraGuideNotNow"].tap()
        Thread.sleep(forTimeInterval: 0.6)
        XCTAssertFalse(any(app, "cameraGuide").exists, "guide away")
        XCTAssertFalse(any(app, "cameraStage").exists, "camera stays off")
    }

    /// The card says what the camera did not show and to move the camera; it is not a sheet and guesses nothing.
    func testNoSeeCardOverCamera() throws {
        let app = launch(["GENITA_CALL_AUTOCAMERA": "1", "GENITA_FINDS_STATE": "26"])
        XCTAssertTrue(any(app, "cameraStage").waitForExistence(timeout: 25), "camera is the stage")
        let card = any(app, "noSeeCard")
        XCTAssertTrue(card.waitForExistence(timeout: 15), "FT-NOSEE card")
        XCTAssertTrue(card.label.contains("I don’t see cooked rice"), card.label)
        XCTAssertTrue(card.label.contains("Move the camera if it’s there."))
        XCTAssertFalse(any(app, "findsSheet").exists, "no sheet")
        Thread.sleep(forTimeInterval: 0.8)
        capture(app, "cam-NOSEE-card")
        card.tap()
        XCTAssertTrue(waitGone(card), "tap puts it away")
    }

    private func waitGone(_ e: XCUIElement) -> Bool {
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: e)
        return XCTWaiter().wait(for: [gone], timeout: 4) == .completed
    }
}
