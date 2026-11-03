import XCTest

/// Captures the handoff and permission screens for review. CI uploads these attachments.
final class HandoffScreensUITests: XCTestCase {
    private func open(_ arguments: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", "--handoff-demo"] + arguments
        app.launch()
        return app
    }
    private func capture(_ app: XCUIApplication, _ name: String) {
        Thread.sleep(forTimeInterval: 1)
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
    func testR1WaitingSheet() {
        let app = open(["--handoff-state", "r1"])
        XCTAssertTrue(app.staticTexts["Continue on your Mac."].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["You’re talking on your Mac right now."].exists)
        XCTAssertTrue(app.staticTexts["If you switch, your Mac will wait."].exists)
        XCTAssertTrue(app.buttons["openMenu"].isHittable, "The menu stays reachable behind the sheet")
        XCTAssertFalse(app.buttons["cameraToggle"].exists)
        capture(app, "R1-iphone")
        app.buttons["openMenu"].tap()
        XCTAssertTrue(app.buttons["settings"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["moveToMac"].exists, "There is nothing to move while the Mac has the conversation")
        capture(app, "R1-iphone-menu")
        app.buttons["Close menu"].tap()
        XCTAssertTrue(app.buttons["continueHere"].waitForExistence(timeout: 5))
        app.buttons["continueHere"].tap()
        XCTAssertTrue(app.buttons["cameraToggle"].waitForExistence(timeout: 2), "One tap brings the conversation back")
        XCTAssertFalse(app.staticTexts["Continue on your Mac."].exists)
        capture(app, "R1-after-continue-here")
    }
    func testR1EWaitingSheet() {
        let app = open(["--handoff-state", "r1e"])
        XCTAssertTrue(app.staticTexts["Mac not responding."].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["It may be asleep or offline."].exists)
        XCTAssertTrue(app.staticTexts["You can keep talking here."].exists)
        XCTAssertTrue(app.buttons["continueHere"].isHittable)
        capture(app, "R1E-iphone")
    }
    func testMoveToMacWithoutPairingOpensPairingAndNoLidarIsNoDeadEnd() {
        let app = open([])
        XCTAssertTrue(app.buttons["openMenu"].waitForExistence(timeout: 10))
        app.buttons["openMenu"].tap()
        XCTAssertTrue(app.buttons["moveToMac"].waitForExistence(timeout: 5))
        capture(app, "menu-move-to-mac")
        app.buttons["moveToMac"].tap()
        XCTAssertTrue(app.textFields["pairingCode"].waitForExistence(timeout: 5))
        capture(app, "pairing-sheet")
    }
    /// GENITA_PROXIMITY_HANDOFF (flag off, needs Chelsea's OK): the iPhone's half of a move made by bringing it close
    /// to the Mac — the call screen gliding up toward the Mac, the toast, R1 behind. No Bluetooth in CI: the review
    /// state plays the moment as if the server's `ownership {trigger: proximity}` had arrived.
    func testProximityMoment() {
        var app = open(["--proximity-moment", "glide"])
        let toast = app.descendants(matching: .any)["proximityToast"]
        XCTAssertTrue(toast.waitForExistence(timeout: 12))
        capture(app, "PROX-iphone-glide")
        app.terminate()
        app = open(["--proximity-moment", "done"])
        XCTAssertTrue(app.descendants(matching: .any)["proximityToast"].waitForExistence(timeout: 12))
        XCTAssertTrue(app.staticTexts["Continue on your Mac."].waitForExistence(timeout: 5), "R1: the conversation is on the Mac now")
        capture(app, "PROX-iphone-toast")
    }
    func testRegistrationScreens() {
        // P03: any iPhone (A12+) looks for the MAC-REG picture; Cancel goes back to the call.
        var app = open(["--handoff-state", "p03"])
        XCTAssertTrue(app.staticTexts["Point at the picture on your Mac"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["cancelRegistration"].isHittable)
        capture(app, "P03-registering")
        app.buttons["cancelRegistration"].tap()
        XCTAssertFalse(app.staticTexts["Point at the picture on your Mac"].waitForExistence(timeout: 1))
        app.terminate()
        // P04: the screen was learned, a 4-second toast over the call.
        app = open(["--handoff-state", "p04"])
        XCTAssertTrue(app.staticTexts["Mac screen learned. Touch its edge with this iPhone to move."].waitForExistence(timeout: 5))
        capture(app, "P04-registered")
    }
    func testPairingScreens() {
        // P01: six boxes, the number pad is up, the sixth digit starts pairing by itself (no Pair button).
        var app = open(["--handoff-state", "p01"])
        XCTAssertTrue(app.staticTexts["Pair with your Mac."].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Enter the six digits in Genita on your Mac. You only do this once."].exists)
        XCTAssertFalse(app.buttons["Pair"].exists, "Auto-advance after six digits: there is no Pair button")
        capture(app, "P01-pair")
        app.terminate()
        app = open(["--handoff-state", "p01-looking"])
        XCTAssertTrue(app.staticTexts["Looking for your Mac"].waitForExistence(timeout: 10))
        capture(app, "P01-looking")
        app.terminate()
        // P01-E: no Mac answered to that code.
        app = open(["--handoff-state", "p01e"])
        XCTAssertTrue(app.staticTexts["That code didn’t match. Check your Mac."].waitForExistence(timeout: 10))
        capture(app, "P01E-wrong-code")
        app.terminate()
        // P02: paired, one tap to set up touch to move, or Not now back to the call.
        app = open(["--handoff-state", "p02"])
        XCTAssertTrue(app.staticTexts["Paired with your Mac."].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["setUpTouchToMove"].isHittable)
        capture(app, "P02-paired")
        app.buttons["pairingNotNow"].tap()
        XCTAssertFalse(app.staticTexts["Paired with your Mac."].waitForExistence(timeout: 1))
    }
    func testMoveStatusLine() {
        // MV-1 and MV-E are the call's status line, not a system alert.
        var app = open(["--handoff-state", "mv1"])
        XCTAssertTrue(app.staticTexts["Moving to your Mac…"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.alerts.firstMatch.exists)
        capture(app, "MV1-moving")
        app.terminate()
        app = open(["--handoff-state", "mve"])
        XCTAssertTrue(app.staticTexts["Mac not responding. Still here."].waitForExistence(timeout: 10))
        XCTAssertFalse(app.alerts.firstMatch.exists, "A failed move is a status line, never a system alert")
        capture(app, "MVE-move-failed")
        XCTAssertTrue(app.buttons["cameraToggle"].isHittable, "The call stays usable")
        // the fixture pins the line; its 3 s clear is a unit test (PhoneHandoffMoveLineTests)
    }
    func testPermissionDeniedSheets() {
        var app = open(["--media-state", "camera-denied"])
        XCTAssertTrue(app.staticTexts["Allow camera access."].waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons["permissionDismiss"].label, "Keep camera off")
        capture(app, "E01-camera-denied")
        app.buttons["permissionDismiss"].tap()
        XCTAssertFalse(app.staticTexts["Allow camera access."].waitForExistence(timeout: 1))
        capture(app, "conversation-controls")
        app.terminate()
        app = open(["--media-state", "mic-denied"])
        XCTAssertTrue(app.staticTexts["Allow microphone."].waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons["permissionDismiss"].label, "Not now")
        capture(app, "E02-microphone-denied")
    }
}
