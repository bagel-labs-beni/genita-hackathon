import XCTest

/// D99: the Settings C1 companion card subtitle — "Together N days" on one line, two lines when it does not fit, nothing
/// when the date is unknown. Screenshots only (the layout is the point); runs against the onboarding stub like the reset test.
final class CompanionCardUITests: XCTestCase {
    private func openSettings(_ fixture: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", "--stub-signin", "--fixture-image", "--fixture-companion-card", fixture]
        app.launchEnvironment = [
            "GENITA_REVIEW_STAGE": "conversation", "GENITA_REVIEW_STILL": "1",
            "GENITA_API_URL": "http://127.0.0.1:8790", "GENITA_SERVER_URL": "ws://127.0.0.1:9/v1/session",
        ]
        app.launch()
        XCTAssertTrue(app.buttons["openMenu"].waitForExistence(timeout: 15))
        app.buttons["openMenu"].tap()
        XCTAssertTrue(app.buttons["settings"].waitForExistence(timeout: 5))
        app.buttons["settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
        return app
    }
    /// the card is one combined accessibility element, so match on its label
    private func card(_ app: XCUIApplication, containing text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }
    private func capture(_ app: XCUIApplication, _ name: String) {
        Thread.sleep(forTimeInterval: 1)
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }

    func testCardWithDate() {
        let app = openSettings("dated")
        XCTAssertTrue(card(app, containing: "Tara voice · Together 12 days").waitForExistence(timeout: 5))
        capture(app, "d99-card-dated")
    }
    func testCardLongVoiceName() {
        let app = openSettings("long")
        XCTAssertTrue(card(app, containing: "Warm baritone, unhurried voice").waitForExistence(timeout: 5))
        capture(app, "d99-card-long-voice")
    }
    func testCardWithoutDate() {
        let app = openSettings("none")
        XCTAssertTrue(card(app, containing: "Tara voice").waitForExistence(timeout: 5))
        XCTAssertFalse(card(app, containing: "Together").exists)
        capture(app, "d99-card-no-date")
    }
}
