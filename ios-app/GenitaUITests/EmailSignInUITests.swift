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

    /// #189: on a screen taller than the 844 pt board the sign-in photo's dark bottom must reach the screen's edge
    /// (no light band under the legal line). Reads the last rows of the screenshot itself.
    func testA02BottomStaysDarkOnTallScreens() throws {
        let app = launch("")
        XCTAssertTrue(app.buttons["continueWithEmail"].waitForExistence(timeout: 8))
        Thread.sleep(forTimeInterval: 0.6)
        let shot = app.screenshot()
        let a = XCTAttachment(screenshot: shot); a.name = "auth-A02-bottom"; a.lifetime = .keepAlways; add(a)
        let cg = try XCTUnwrap(shot.image.cgImage)
        let w = cg.width, h = cg.height
        var px = [UInt8](repeating: 0, count: w * h * 4)
        let ctx = try XCTUnwrap(CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        // the bottom 3 % of the screen, its left and right quarters (the home indicator sits in the middle);
        // memory rows: row 0 = top
        var brightest = 0
        let xs = Array(stride(from: 0, to: w / 4, by: max(1, w / 80))) + Array(stride(from: w * 3 / 4, to: w, by: max(1, w / 80)))
        for y in Int(Double(h) * 0.97)..<h {
            for x in xs {
                let i = (y * w + x) * 4
                brightest = max(brightest, (Int(px[i]) + Int(px[i + 1]) + Int(px[i + 2])) / 3)
            }
        }
        XCTAssertLessThan(brightest, 90, "A02 bottom edge is dark (brightest \(brightest)/255 on a \(w)×\(h) screen)")
    }

    func testAddressStep() {
        let app = launch("")
        let button = app.buttons["continueWithEmail"]
        XCTAssertTrue(button.waitForExistence(timeout: 8))
        // #218: Google is hidden by default; email sits right under Apple
        XCTAssertTrue(app.buttons["Continue with Apple"].exists)
        XCTAssertFalse(app.buttons["Continue with Google"].exists)
        XCTAssertLessThan(app.buttons["Continue with Apple"].frame.maxY, button.frame.minY, "email sits under Apple")
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
