import XCTest

/// AU-15 (IM-02): the background import failed — the banner over the current onboarding screen, "Paste again" → I02
/// with the note, "Not now" closes it. Review fixture, no server. Screenshots `onb-import-fail-*`.
final class ImportFailBannerUITests: XCTestCase {
    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = "onb-import-fail-" + name; a.lifetime = .keepAlways; add(a)
    }

    func testBannerPasteAgainOpensI02WithTheNote() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        app.launchEnvironment = ["GENITA_REVIEW_STAGE": "image", "GENITA_REVIEW_VARIANT": "import-failed"]
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["importFailBanner"].waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 0.6); shot(app, "1-banner-V01")
        app.buttons["importFailPaste"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["importRetryNote"].waitForExistence(timeout: 5), "I02 with the note")
        XCTAssertFalse(app.descendants(matching: .any)["importFailBanner"].exists)
        Thread.sleep(forTimeInterval: 0.5); shot(app, "2-I02-note")
    }

    func testNotNowClosesTheBanner() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        app.launchEnvironment = ["GENITA_REVIEW_STAGE": "image", "GENITA_REVIEW_VARIANT": "import-failed"]
        app.launch()
        XCTAssertTrue(app.buttons["importFailDismiss"].waitForExistence(timeout: 10))
        app.buttons["importFailDismiss"].tap()
        XCTAssertFalse(app.descendants(matching: .any)["importFailBanner"].waitForExistence(timeout: 2))
    }
}
