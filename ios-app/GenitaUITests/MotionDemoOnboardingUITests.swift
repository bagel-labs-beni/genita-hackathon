import XCTest

/// Motion details cards 7–9 (춘식이 r02, `_qa-scripts/genita-splash/motion/index.html`) played slowly for the
/// motion lane's screen recordings. `--motion-demo` keeps every motion running (`GenitaMotion.reviewStill` false)
/// and GENITA_REVIEW_STILL is not set. Not in the normal CI lists: the recording workflow runs these on purpose.
/// No timing asserts; the waits only make each motion visible on video.
///
/// Needs the same local servers as the screens they show:
/// - 7 and 8: ios-app/Tools/onboarding-stub on 127.0.0.1:8790 (7 ends on PREP-1 ready; S07 → S09 after it uses the
///   call replay on 8788 if it is up, the demo doesn't need it)
/// - 9: the recorded interpret session (ios-app/Tools/call-replay/session-int.json) on 127.0.0.1:8789
final class MotionDemoOnboardingUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = true
    }

    private func stubPost(_ path: String, json: String = "{}") {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:8790" + path)!)
        req.httpMethod = "POST"; req.setValue("application/json", forHTTPHeaderField: "content-type"); req.httpBody = Data(json.utf8)
        let done = expectation(description: path)
        URLSession.shared.dataTask(with: req) { _, _, _ in done.fulfill() }.resume()
        wait(for: [done], timeout: 10)
    }

    private func onboardingApp() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", "--motion-demo", "--stub-signin", "--fixture-image"]
        app.launchEnvironment = [
            "GENITA_API_URL": "http://127.0.0.1:8790",
            "GENITA_SERVER_URL": "ws://127.0.0.1:8788/v1/session",
            "GENITA_FIXTURE_SCRIPT": "none",
        ]
        return app
    }

    private func pause(_ seconds: TimeInterval = 1.5) { Thread.sleep(forTimeInterval: seconds) }

    private func capture(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "motion-" + name
        shot.lifetime = .keepAlways
        add(shot)
    }

    /// Card 7: PREP-1 rows follow the stub's real prep stages (scene → expressions → mouth, polled by
    /// `followPrep`), one face image every 1.5 s so each row's spinner → check is easy to see (ready ≈ 23 s).
    func testMotion7Prep() throws {
        stubPost("/__reset")
        stubPost("/__prep", json: #"{"faceMs":1500}"#)
        let app = onboardingApp()
        app.launch()
        func element(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }
        let primary = app.buttons["primaryCTA"]

        // shortest real walk: I01 skip → N1–N3 → S0 → Skip → HISY-7 → V01 → V02-T → V04 → NM01 → Quick start → SUM
        XCTAssertTrue(app.buttons["skipImport"].waitForExistence(timeout: 15)); app.buttons["skipImport"].tap()
        XCTAssertTrue(element("skipTopics").waitForExistence(timeout: 5)); primary.tap()
        XCTAssertTrue(element("skipReplies").waitForExistence(timeout: 5)); primary.tap()
        XCTAssertTrue(element("skipAvoid").waitForExistence(timeout: 5)); primary.tap()
        XCTAssertTrue(element("hisyOpener").waitForExistence(timeout: 15))
        expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: app.buttons["hisyShowMe"]); waitForExpectations(timeout: 20)
        app.buttons["hisyShowMe"].tap(); pause(0.6)
        app.buttons.matching(identifier: "hisySkip").firstMatch.tap(); pause(0.6)
        app.buttons.matching(identifier: "hisyChoosePhoto").firstMatch.tap()
        XCTAssertTrue(app.buttons["uploadImage"].waitForExistence(timeout: 5))
        if app.buttons["rightsAck"].exists { app.buttons["rightsAck"].tap() }
        primary.tap()
        XCTAssertTrue(element("V02-T").waitForExistence(timeout: 15)); primary.tap()
        XCTAssertTrue(app.buttons["voice0"].waitForExistence(timeout: 10))
        expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: primary); waitForExpectations(timeout: 15)
        primary.tap()
        let name = app.textFields["companionNameInput"]
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        expectation(for: NSPredicate(format: "value != %@ AND value != %@", "", "Name"), evaluatedWith: name); waitForExpectations(timeout: 10)
        primary.tap()
        // D01 Quick start (skippers' default) → help → relationship → presence → SUM
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Quick start'")).firstMatch.waitForExistence(timeout: 10))
        primary.tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Think with me'")).firstMatch.tap(); primary.tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Trusted partner'")).firstMatch.tap(); primary.tap()
        app.buttons["Calm"].firstMatch.tap(); primary.tap()
        primary.tap()   // SUM Continue → PREP-1

        // PREP-1: watch the rows move with the server (scene at 3 s, expressions, then mouth = ready)
        XCTAssertTrue(element("PREP-1").waitForExistence(timeout: 15), "PREP-1")
        capture(app, "7-prep-start")
        for stage in ["scene", "expressions", "mouth"] {
            expectation(for: NSPredicate(format: "value == %@", "done"), evaluatedWith: element("prepStage-" + stage))
            waitForExpectations(timeout: 40)
            capture(app, "7-prep-\(stage)-done")
        }
        pause(2)
    }

    /// Card 8: HISY titles appear line by line and the progress capsule springs to the next dot; then the
    /// reference (V01) and wire (V02-T) titles do the same.
    func testMotion8OnboardingTitle() throws {
        stubPost("/__reset")
        let app = onboardingApp()
        app.launch()
        func element(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }
        let primary = app.buttons["primaryCTA"]

        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 15), "I01")
        pause()
        primary.tap()
        let input = element("responseInput")
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.tap()
        input.typeText("Communication style: warm and direct. Response preferences: two options, one recommended.")
        app.buttons["Dismiss keyboard"].tap()
        XCTAssertTrue(primary.waitForExistence(timeout: 5))
        primary.tap()

        // HISY-0 → cards 1…4 forward, one back, then on
        XCTAssertTrue(element("hisyOpener").waitForExistence(timeout: 20), "HISY-0")
        expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: app.buttons["hisyShowMe"]); waitForExpectations(timeout: 20)
        pause(2)
        app.buttons["hisyShowMe"].tap()
        pause(2)
        capture(app, "8-hisy-1")
        for _ in 0..<3 {
            app.buttons.matching(identifier: "hisyNext").firstMatch.tap()
            pause(2)
        }
        capture(app, "8-hisy-4")
        app.buttons.matching(identifier: "hisyBack").firstMatch.tap()
        pause(2)
        app.buttons.matching(identifier: "hisyNext").firstMatch.tap()
        pause(2)

        // HISY-7 → V01 (reference title) → V03 → V02-T (wire title)
        app.buttons.matching(identifier: "hisySkip").firstMatch.tap()
        XCTAssertTrue(element("hisyFace").waitForExistence(timeout: 5))
        pause(2)
        app.buttons.matching(identifier: "hisyChoosePhoto").firstMatch.tap()
        XCTAssertTrue(app.buttons["uploadImage"].waitForExistence(timeout: 5))
        pause(2)
        if app.buttons["rightsAck"].exists { app.buttons["rightsAck"].tap() }
        primary.tap()
        XCTAssertTrue(element("V02-T").waitForExistence(timeout: 15))
        pause(2)
        capture(app, "8-V02-T")
    }

    /// Card 9: Hold to talk on the recorded interpret session: press and hold ~2 s (fill from the left, bars over
    /// the button, 0.98 scale), release (drain + send), twice.
    func testMotion9HoldToTalk() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", "--motion-demo"]
        app.launchEnvironment = [
            "GENITA_REVIEW_STAGE": "conversation",
            "GENITA_SERVER_URL": "ws://127.0.0.1:8789/v1/session",
            "GENITA_FIXTURE_SCRIPT": "none",
            "GENITA_CALL_AUTOMIC": "1",
        ]
        app.launch()
        let hold = app.buttons["interpretHold"]
        XCTAssertTrue(hold.waitForExistence(timeout: 30), "interpret mode with Hold to talk")
        pause(2)
        capture(app, "9-hold-rest")
        hold.press(forDuration: 2.0)
        pause(1.5)
        hold.press(forDuration: 2.0)
        pause(1.5)
        capture(app, "9-hold-after")
    }
}
