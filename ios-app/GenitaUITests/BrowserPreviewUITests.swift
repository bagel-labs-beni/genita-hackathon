import XCTest

/// Appetize browser preview (`--browser-preview`, Debug builds only). Without the argument the app is the normal app:
/// no Preview tab, and the consent screen is reached the normal way. With it: the demo path through onboarding,
/// the call from the recorded session (no server, no mic, no camera), Finds, the fridge, interpretation and settings.
final class BrowserPreviewUITests: XCTestCase {
    private func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "preview-" + name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
    private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }
    private func jump(_ app: XCUIApplication, _ id: String) {
        XCTAssertTrue(app.buttons["previewTab"].waitForExistence(timeout: 10), "Preview tab before \(id)")
        app.buttons["previewTab"].tap()
        let entry = app.buttons["preview." + id]
        XCTAssertTrue(entry.waitForExistence(timeout: 5), "menu entry \(id)")
        entry.tap()
    }

    func testNormalLaunchHasNoPreviewMenu() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"] // a normal launch of this build: no --browser-preview
        app.launch()
        Thread.sleep(forTimeInterval: 2)
        XCTAssertFalse(app.buttons["previewTab"].exists, "no Preview tab without --browser-preview")
        XCTAssertFalse(any(app, "consentAgree").exists, "consent is not skipped or faked on a normal launch")
        shot(app, "normal-launch")
    }

    func testPreviewMenuJumpsBetweenFlows() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--browser-preview"] // exactly what Appetize passes; no --uitesting, no environment
        app.launch()

        // onboarding: the demo sign-in goes through consent
        XCTAssertTrue(app.buttons["previewTab"].waitForExistence(timeout: 15))
        shot(app, "00-welcome")
        jump(app, "signIn"); Thread.sleep(forTimeInterval: 1); shot(app, "01-sign-in")
        app.buttons["Continue with Apple"].tap()
        XCTAssertTrue(app.alerts.buttons["Continue in demo"].waitForExistence(timeout: 5), "no Apple login: local demo")
        app.alerts.buttons["Continue in demo"].tap()
        XCTAssertTrue(any(app, "consentAgree").waitForExistence(timeout: 5), "the demo path still shows consent")
        shot(app, "02-consent")
        app.buttons["consentAgree"].tap()
        XCTAssertTrue(app.buttons["primaryCTA"].waitForExistence(timeout: 5), "past consent: A03")
        shot(app, "03-name")

        // call: the face moves, the recorded session runs (mic is the fixture one, no prompt)
        jump(app, "call")
        XCTAssertTrue(app.buttons["micToggle"].waitForExistence(timeout: 20), "call screen")
        let cue = any(app, "callCue")
        let end = Date().addingTimeInterval(60)
        var talking = false
        while Date() < end, !talking { talking = cue.exists && cue.label.hasSuffix("is talking"); if !talking { Thread.sleep(forTimeInterval: 0.3) } }
        XCTAssertTrue(talking, "recorded reply plays: \(cue.exists ? cue.label : "no cue")")
        shot(app, "04-call-talking")

        // Finds and the fridge
        jump(app, "findsFridge")
        XCTAssertTrue(any(app, "findsSheet").waitForExistence(timeout: 30), "Finds sheet")
        Thread.sleep(forTimeInterval: 1.5); shot(app, "05-finds-fridge")
        jump(app, "findsProduct")
        XCTAssertTrue(any(app, "findsSheet").waitForExistence(timeout: 30), "product sheet")
        Thread.sleep(forTimeInterval: 1.5); shot(app, "06-finds-product")
        jump(app, "findsList")
        XCTAssertTrue(any(app, "findsList").waitForExistence(timeout: 30), "Finds list")
        Thread.sleep(forTimeInterval: 1); shot(app, "07-finds-list")
        jump(app, "fridge")
        XCTAssertTrue(any(app, "cameraStage").waitForExistence(timeout: 30), "fixture camera on, no permission prompt")
        Thread.sleep(forTimeInterval: 2); shot(app, "08-fridge-camera")

        // interpretation
        jump(app, "interpret")
        XCTAssertTrue(any(app, "interpretBar").waitForExistence(timeout: 30), "interpretation overlay")
        Thread.sleep(forTimeInterval: 3); shot(app, "09-interpret")

        // settings
        jump(app, "settings")
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 20), "Settings sheet")
        shot(app, "10-settings")
        // M02 r01 C: About you and How {name} shows up open as pages
        let aboutYou = app.buttons["settingsAboutYou"]
        XCTAssertTrue(aboutYou.waitForExistence(timeout: 5), "About you row")
        aboutYou.tap()
        XCTAssertTrue(app.navigationBars["About you"].waitForExistence(timeout: 5), "About you page")
        XCTAssertFalse(app.staticTexts["Not enough information yet."].exists, "unknowns are one Still learning block, not repeated lines")
        shot(app, "10b-about-you")
        app.navigationBars["About you"].buttons.firstMatch.tap()
        let showsUp = app.buttons["settingsShowsUp"]
        XCTAssertTrue(showsUp.waitForExistence(timeout: 5), "How … shows up row")
        showsUp.tap()
        Thread.sleep(forTimeInterval: 0.6); shot(app, "10c-shows-up")
    }
}
