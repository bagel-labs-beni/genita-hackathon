import XCTest

/// Launch splash A′ Corona calm (motion lane): frames at the motion page's frame times over the real A02,
/// ≤ 2.7 s to A02, tap skips.
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
        var env = ["GENITA_REVIEW_STAGE": "signIn"] // A02 under the splash, as at a first launch
        if let at { env["GENITA_SPLASH_AT"] = at }
        app.launchEnvironment = env
        app.launch()
        return app
    }

    func testSplashFrames() throws {
        for t in ["0.7", "1.1", "1.5", "1.9", "2.0", "2.08", "2.2", "2.4", "2.65"] {
            let app = launch(at: t)
            XCTAssertTrue(app.descendants(matching: .any)["splash"].waitForExistence(timeout: 10), "splash at \(t)")
            shot(app, "call-splash-t\(Int((Double(t) ?? 0) * 1000))ms") // no "." in the name: the export cuts there
            app.terminate()
        }
    }

    func testSplashHandsOverToA02Within2700ms() throws {
        let app = launch()
        let elapsed = app.descendants(matching: .any)["splashElapsedMs"]
        XCTAssertTrue(elapsed.waitForExistence(timeout: 10))
        let ms = Int(elapsed.label) ?? .max
        print("splash held the first screen for \(ms) ms")
        XCTAssertLessThanOrEqual(ms, 2700, "splash must hand over to A02 within 2.7 s")
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
