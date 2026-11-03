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

    private func launch(at: String? = nil, lateFirstFrame: String? = nil, mode: String = "full") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", "--splash-demo"]
        // A02 under the splash, as at a first launch; the mode is pinned (a session left in the simulator's
        // keychain by another test would otherwise pick the short relaunch splash)
        var env = ["GENITA_REVIEW_STAGE": "signIn", "GENITA_SPLASH_MODE": mode]
        if let at { env["GENITA_SPLASH_AT"] = at }
        if let lateFirstFrame { env["GENITA_SPLASH_LATE_FIRST_FRAME"] = lateFirstFrame }
        app.launchEnvironment = env
        app.launch()
        return app
    }

    func testSplashFrames() throws {
        for t in ["0.0", "0.3", "0.7", "1.1", "1.5", "1.9", "2.0", "2.08", "2.2", "2.4", "2.55"] { // the hand-off ends at 2.6 s
            let app = launch(at: t)
            XCTAssertTrue(app.descendants(matching: .any)["splash"].waitForExistence(timeout: 10), "splash at \(t)")
            shot(app, "call-splash-t\(Int((Double(t) ?? 0) * 1000))ms") // no "." in the name: the export cuts there
            app.terminate()
        }
    }

    /// On screen 2.6 s from its own first frame (not from launch: Chelsea 11/3 "too fast"), then A02.
    func testSplashHandsOverToA02About2600msAfterItsFirstFrame() throws {
        let app = launch()
        let visible = app.descendants(matching: .any)["splashVisibleMs"]
        XCTAssertTrue(visible.waitForExistence(timeout: 15))
        let ms = Int(visible.label) ?? .max
        let total = app.descendants(matching: .any)["splashElapsedMs"].label
        print("splash on screen \(ms) ms; since launch \(total) ms")
        XCTAssertGreaterThanOrEqual(ms, 2400, "the whole of A′ is seen")
        XCTAssertLessThanOrEqual(ms, 2900, "and hands over to A02 at its end")
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

    /// Chelsea 11/3: "the splash goes by too fast". On a phone the first frame comes late (cold launch work); the
    /// splash clock started at launch, so it skipped ahead and was on screen ~1 s. It must be on screen ≥ 1.2 s.
    func testSplashStaysOnScreenAtLeast1200msEvenWhenTheFirstFrameIsLate() throws {
        let app = launch(lateFirstFrame: "1.5")
        let visible = app.descendants(matching: .any)["splashVisibleMs"]
        XCTAssertTrue(visible.waitForExistence(timeout: 15))
        let ms = Int(visible.label) ?? 0
        print("splash was on screen for \(ms) ms (first frame 1.5 s late)")
        XCTAssertGreaterThanOrEqual(ms, 1200, "splash on screen at least 1.2 s")
        XCTAssertLessThanOrEqual(ms, 2900, "and not dragged past its own timeline")
    }

    /// Signed-in relaunch: the still lit mark for 0.6 s, then the conversation.
    func testSignedInRelaunchSplashIsShort() throws {
        let app = launch(mode: "short")
        let visible = app.descendants(matching: .any)["splashVisibleMs"]
        XCTAssertTrue(visible.waitForExistence(timeout: 15))
        let ms = Int(visible.label) ?? .max
        print("short splash on screen \(ms) ms")
        XCTAssertGreaterThanOrEqual(ms, 500)
        XCTAssertLessThanOrEqual(ms, 1000)
    }

    /// Evidence frames of the short relaunch splash: fade in 0.15 s, hold, crossfade 0.25–0.6 s.
    func testShortSplashFrames() throws {
        for t in ["0.0", "0.08", "0.15", "0.25", "0.4", "0.55"] {
            let app = launch(at: t, mode: "short")
            XCTAssertTrue(app.descendants(matching: .any)["splash"].waitForExistence(timeout: 10), "short splash at \(t)")
            shot(app, "call-splash-short-t\(Int((Double(t) ?? 0) * 1000))ms")
            app.terminate()
        }
    }
}
