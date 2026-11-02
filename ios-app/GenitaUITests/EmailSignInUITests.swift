import XCTest

/// A02 "Continue with email" → A02-M address step → A02-M2 code step. The server is a closed local port, so every
/// request ends on the offline line and the sheet stays open (the server side is covered by genita-server tests).
/// Screenshots are named `auth-…` and exported by call-client.yml.
final class EmailSignInUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private func launch(_ variant: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        app.launchEnvironment = ["GENITA_REVIEW_STAGE": "signIn", "GENITA_REVIEW_VARIANT": variant, "GENITA_API_URL": "http://127.0.0.1:1"]
        app.launch()
        return app
    }

    private func capture(_ app: XCUIApplication, _ name: String) {
        Thread.sleep(forTimeInterval: 0.6)
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }

    func testAddressStep() {
        let app = launch("")
        let button = app.buttons["continueWithEmail"]
        XCTAssertTrue(button.waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["Continue with Apple"].exists && app.buttons["Continue with Google"].exists)
        XCTAssertLessThan(app.buttons["Continue with Google"].frame.maxY, button.frame.minY, "email sits under Apple / Google")
        capture(app, "auth-A02-email")

        button.tap()
        let field = app.textFields["emailField"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["emailSheetTitle"].label, "Continue with email")
        let send = app.buttons["emailContinue"]
        XCTAssertFalse(send.isEnabled, "nothing typed → Send code is off")
        capture(app, "auth-A02-M-email")
        field.tap(); field.typeText("judge@example")
        XCTAssertFalse(send.isEnabled, "not an address yet")
        field.typeText(".com")
        XCTAssertTrue(send.isEnabled)
        send.tap()
        let error = app.staticTexts["emailError"]
        XCTAssertTrue(error.waitForExistence(timeout: 15))
        XCTAssertEqual(error.label, "Couldn’t reach the server. Check your connection.")
        XCTAssertTrue(field.exists, "still on the address step")
        capture(app, "auth-A02-M-email-offline")
        app.buttons["emailCancel"].tap()
        XCTAssertTrue(button.waitForExistence(timeout: 5))
    }

    func testCodeStep() {
        let app = launch("emailCode")
        let field = app.textFields["emailCodeField"]
        XCTAssertTrue(field.waitForExistence(timeout: 8))
        XCTAssertEqual(app.staticTexts["emailSheetTitle"].label, "Check your email")
        XCTAssertTrue(app.staticTexts["Enter the 6-digit code we sent to you@example.com."].exists)
        let go = app.buttons["emailContinue"]
        XCTAssertFalse(go.isEnabled)
        capture(app, "auth-A02-M2-code")
        field.tap(); field.typeText("12345")
        XCTAssertFalse(go.isEnabled, "5 digits")
        field.typeText("6") // the 6th digit sends it
        let error = app.staticTexts["emailError"]
        XCTAssertTrue(error.waitForExistence(timeout: 15))
        XCTAssertEqual(field.value as? String ?? "", "6-digit code", "a failed code is cleared for the next try")
        capture(app, "auth-A02-M2-code-offline")
        app.buttons["emailChange"].tap()
        XCTAssertTrue(app.textFields["emailField"].waitForExistence(timeout: 5), "Use a different email → address step")
    }
}
