import XCTest

/// Launch splash (motion lane): frames of the keyframe timeline, ≤ 1.6 s to the first screen, tap skips.
/// `--splash-demo` turns it on under UI tests; DEBUG `GENITA_SPLASH_AT=<s>` freezes one instant.
final class SplashUITests: XCTestCase {
    private func shot(_ app: XCUIApplication, _ name: String) {
        let s = XCTAttachment(screenshot: app.screenshot())
        s.name = name
        s.lifetime = .keepAlways
        add(s)
    }

    private func launch(at: String? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", "--splash-demo"]
        var env = ["GENITA_REVIEW_STAGE": "name"]
        if let at { env["GENITA_SPLASH_AT"] = at }
        app.launchEnvironment = env
        app.launch()
        return app
    }

    func testSplashFrames() throws {
        for t in ["0.2", "0.6", "0.86", "1.2", "1.4"] {
            let app = launch(at: t)
            XCTAssertTrue(app.descendants(matching: .any)["splash"].waitForExistence(timeout: 10), "splash at \(t)")
            shot(app, "call-splash-t\(Int((Double(t) ?? 0) * 1000))ms") // no "." in the name: the export cuts there
            app.terminate()
        }
    }

    func testSplashWakesIntoFirstScreenWithin1600ms() throws {
        let app = launch()
        let elapsed = app.descendants(matching: .any)["splashElapsedMs"]
        XCTAssertTrue(elapsed.waitForExistence(timeout: 10))
        let ms = Int(elapsed.label) ?? .max
        print("splash held the first screen for \(ms) ms")
        XCTAssertLessThanOrEqual(ms, 1600, "splash must hand over to the first screen within 1.6 s")
        XCTAssertFalse(app.descendants(matching: .any)["splash"].exists)
        shot(app, "call-splash-first-screen")
    }

    func testTapSkipsTheSplash() throws {
        let app = launch(at: "0.5") // frozen: never wakes by itself
        let splash = app.descendants(matching: .any)["splash"]
        XCTAssertTrue(splash.waitForExistence(timeout: 10))
        splash.tap()
        XCTAssertTrue(splash.waitForNonExistence(timeout: 2), "tap wakes the app")
    }
}
