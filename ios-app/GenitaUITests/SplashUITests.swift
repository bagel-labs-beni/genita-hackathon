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
        // 춘식이 11/4: build-up, the still hold 1.9–2.5 s, the hand-off 2.5–3.3 s
        for t in ["0.3", "0.9", "1.5", "1.9", "2.2", "2.5", "2.7", "2.9", "3.1", "3.25"] {
            let app = launch(at: t)
            XCTAssertTrue(app.descendants(matching: .any)["splash"].waitForExistence(timeout: 10), "splash at \(t)")
            shot(app, "call-splash-t\(Int((Double(t) ?? 0) * 1000))ms") // no "." in the name: the export cuts there
            app.terminate()
        }
    }

    /// On screen 3.3 s from its own first frame (not from launch: Chelsea 11/3 "too fast"), then A02.
    func testSplashHandsOverToA02About3300msAfterItsFirstFrame() throws {
        let app = launch()
        let visible = app.descendants(matching: .any)["splashVisibleMs"]
        XCTAssertTrue(visible.waitForExistence(timeout: 15))
        let ms = Int(visible.label) ?? .max
        let total = app.descendants(matching: .any)["splashElapsedMs"].label
        print("splash on screen \(ms) ms; since launch \(total) ms")
        XCTAssertGreaterThanOrEqual(ms, 3100, "the whole of A′ is seen, with its hold")
        // 3.3 s of splash + the 30 ms deadline poll + a loaded CI main thread + any time the launching scene wasn't
        // active yet (#548 holds the clock then): b9-7c measured 3708 ms. Still well short of a second splash.
        XCTAssertLessThanOrEqual(ms, 4200, "and hands over to A02 at its end")
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
        XCTAssertLessThanOrEqual(ms, 3600, "and not dragged past its own timeline")
    }

    /// Signed-in relaunch: the still lit mark for 0.9 s, then the conversation.
    func testSignedInRelaunchSplashIsShort() throws {
        let app = launch(mode: "short")
        let visible = app.descendants(matching: .any)["splashVisibleMs"]
        XCTAssertTrue(visible.waitForExistence(timeout: 15))
        let ms = Int(visible.label) ?? .max
        print("short splash on screen \(ms) ms")
        XCTAssertGreaterThanOrEqual(ms, 800)
        XCTAssertLessThanOrEqual(ms, 1100)
    }

    /// Evidence frames of the short relaunch splash: in 0.2 s, hold to 0.55 s, crossfade to 0.9 s.
    func testShortSplashFrames() throws {
        for t in ["0.1", "0.3", "0.55", "0.75", "0.85"] {
            let app = launch(at: t, mode: "short")
            XCTAssertTrue(app.descendants(matching: .any)["splash"].waitForExistence(timeout: 10), "short splash at \(t)")
            shot(app, "call-splash-short-t\(Int((Double(t) ?? 0) * 1000))ms")
            app.terminate()
        }
    }
}
