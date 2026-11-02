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

    func testFindsListFrame() throws {
        let app = launch(["GENITA_FINDS_TAB": "list"])
        XCTAssertTrue(any(app, "findsList").waitForExistence(timeout: 20), "F1: the list")
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
        XCTAssertLessThanOrEqual(any(app, "findsEmpty").frame.width, app.frame.width + 0.5, "F0 stays inside the screen (the orb art must not widen the layout)")
        Thread.sleep(forTimeInterval: 0.6)
        capture(app, "finds-tab-F0-empty")
        app.buttons["findsBackToCall"].tap()
        XCTAssertTrue(app.buttons["more"].waitForExistence(timeout: 5), "back on the call")
    }

    func testReopenCardThenTalkAboutIt() throws {
        let app = launch(["GENITA_FINDS_TAB": "detail"])
        let sheet = any(app, "findsSheet")
        XCTAssertTrue(sheet.waitForExistence(timeout: 25), "F2: card in the sheet over the list")
        Thread.sleep(forTimeInterval: 1.5)
        XCTAssertEqual(sheet.value as? String, "half")
        XCTAssertTrue(any(app, "findCamera").exists, "the camera moment is kept with the card")
        XCTAssertTrue(app.buttons["findTalk"].exists, "button continues the call")
        capture(app, "finds-tab-F2-reopen")
        app.buttons["findTalk"].tap()
        Thread.sleep(forTimeInterval: 0.8)
        XCTAssertFalse(any(app, "findsTab").exists, "tab closed, the card stays over the call")
        XCTAssertEqual(sheet.value as? String, "half")
        capture(app, "finds-tab-F2-talk")
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

    /// An ingredient chip is pressed: its box is lit, the others step back, the scene dims.
    func testChipLightsItsBox() throws {
        let app = launch(camera.merging(["GENITA_FINDS_STATE": "32"]) { $1 })
        XCTAssertTrue(any(app, "findsSheet").waitForExistence(timeout: 25))
        XCTAssertTrue(any(app, "cameraStage").waitForExistence(timeout: 15))
        Thread.sleep(forTimeInterval: 1.0)
        capture(app, "cam-H-chip-egg")
    }
}
