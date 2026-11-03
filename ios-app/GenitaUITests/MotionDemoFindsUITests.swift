import XCTest

/// Motion details cards 4–6 (춘식이 r02, `_qa-scripts/genita-splash/motion/index.html`) played slowly for the
/// motion lane's screen recordings. `--motion-demo` keeps every motion running (`GenitaMotion.reviewStill` false)
/// and GENITA_REVIEW_STILL is not set. Not in the normal CI lists: the recording workflow runs these on purpose.
/// No timing asserts; the waits only make each motion visible on video.
///
/// Same launch as FindsSheetUITests: GENITA_REVIEW_STAGE=conversation, the call from the replay server on
/// 127.0.0.1:8789 (ios-app/Tools/call-replay), the sheet from GENITA_FINDS_STATE (FindsFixture.swift; 43 and 44
/// are the demo states). Without the replay server the fixture still plays, about 8 s late.
final class MotionDemoFindsUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = true
    }

    private func launch(_ state: Int) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", "--motion-demo"]
        app.launchEnvironment = [
            "GENITA_REVIEW_STAGE": "conversation",
            "GENITA_SERVER_URL": "ws://127.0.0.1:8789/v1/session",
            "GENITA_FINDS_STATE": String(state),
        ]
        app.launch()
        return app
    }

    private func pause(_ seconds: TimeInterval = 1.5) { Thread.sleep(forTimeInterval: seconds) }

    private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }

    private func capture(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "motion-" + name
        shot.lifetime = .keepAlways
        add(shot)
    }

    /// Card 4: the sheet comes up searching, the recipe card rises on the spring with header → title → info →
    /// photo lifting in 40 ms apart, the picture slots sweep, then (sheet opened full) the pictures fade in.
    func testMotion4FindsSheet() throws {
        let app = launch(43)
        XCTAssertTrue(any(app, "findsSheet").waitForExistence(timeout: 20), "sheet")
        pause(3.5) // searching → card rises → half; the 56 pt picture sweeps
        let grab = any(app, "findsGrab")
        if grab.exists { grab.tap() } // half → full: the step picture slots sweep too
        pause(5) // the pictures arrive (fixture: 5 s after the card) and fade in
        capture(app, "04-finds-sheet")
        pause(1.5)
    }

    /// Card 5: ingredient chips press to 0.96 and spring back, colors change in 200 ms, one selection tick per tap;
    /// the "?" kimchi chip turns ✓ with the replace effect (fixture: 6 s after the card).
    func testMotion5IngredientChip() throws {
        let app = launch(44)
        XCTAssertTrue(any(app, "findsSheet").waitForExistence(timeout: 20), "sheet")
        pause(1.5)
        let soy = app.buttons["chip-soy sauce"], egg = app.buttons["chip-egg"]
        XCTAssertTrue(soy.waitForExistence(timeout: 5), "soy sauce chip")
        soy.tap(); pause()
        if egg.exists { egg.tap(); pause() }
        // bring the "?" chips into view before kimchi turns ✓
        egg.swipeLeft(); pause(3)
        let kimchi = app.buttons["chip-kimchi"]
        if kimchi.exists, kimchi.isHittable { kimchi.tap(); pause() ; kimchi.tap(); pause() }
        capture(app, "05-ingredient-chip")
        pause(1)
    }

    /// Card 6: PF-1 "Save to Finds" → the bookmark pops as it fills, one blue shine crosses the card, a success
    /// haptic; unsave (nothing extra), then save again from the bookmark.
    func testMotion6Save() throws {
        let app = launch(22)
        XCTAssertTrue(any(app, "findsSheet").waitForExistence(timeout: 20), "sheet")
        pause(2)
        let cta = app.buttons["findCTA"]
        XCTAssertTrue(cta.waitForExistence(timeout: 5), "Save to Finds")
        cta.tap(); pause(2.5)
        let bookmark = app.buttons["findSave"]
        if bookmark.exists { bookmark.tap(); pause() } // unsave
        if bookmark.exists { bookmark.tap(); pause(2.5) } // save again from the bookmark
        capture(app, "06-save")
        pause(1)
    }
}
