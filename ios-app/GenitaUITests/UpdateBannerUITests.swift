import XCTest

/// Server-driven update nudge (GET /v1/app-config → updates.ios): the banner appears with a TestFlight
/// action and a dismiss that sticks for that build. DEBUG `--update-banner-demo` = latestBuild above the install.
final class UpdateBannerUITests: XCTestCase {
    func testBannerShowsAndDismisses() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", "--update-banner-demo"]
        app.launchEnvironment = ["GENITA_REVIEW_STAGE": "name", "GENITA_REVIEW_STILL": "1"]
        app.launch()
        let banner = app.descendants(matching: .any)["updateBanner"]
        XCTAssertTrue(banner.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["updateBannerAction"].exists)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "call-update-banner"
        shot.lifetime = .keepAlways
        add(shot)
        app.buttons["updateBannerDismiss"].tap()
        XCTAssertTrue(banner.waitForNonExistence(timeout: 5))
    }
}
