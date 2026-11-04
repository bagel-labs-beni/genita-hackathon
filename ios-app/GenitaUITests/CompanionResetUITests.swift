import XCTest

/// M02 "Make a new companion" (11/4): Settings row → confirm sheet → "Start over" → V01 "Bring an image", against the
/// onboarding stub (ios-app/Tools/onboarding-stub, 127.0.0.1:8790; CI starts it before the tests).
final class CompanionResetUITests: XCTestCase {
    private let stub = "http://127.0.0.1:8790"
    @discardableResult
    private func stubCall(_ method: String, _ path: String, json: String? = nil, token: Bool = false) -> [String: Any]? {
        var req = URLRequest(url: URL(string: stub + path)!)
        req.httpMethod = method
        if let json { req.setValue("application/json", forHTTPHeaderField: "content-type"); req.httpBody = Data(json.utf8) }
        if token { req.setValue("Bearer stub-token", forHTTPHeaderField: "authorization") }
        var out: [String: Any]?
        let done = expectation(description: path)
        URLSession.shared.dataTask(with: req) { data, _, _ in
            out = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10)
        return out
    }
    private func capture(_ app: XCUIApplication, _ name: String) {
        Thread.sleep(forTimeInterval: 1)
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }

    func testSettingsMakeNewCompanionConfirmsThenGoesToV01() throws {
        stubCall("POST", "/__reset")
        guard stubCall("POST", "/__companion", json: #"{"name":"Jin","faceMs":1}"#) != nil else {
            throw XCTSkip("onboarding stub not running on 127.0.0.1:8790")
        }
        XCTAssertEqual(stubCall("GET", "/me", token: true)?["hasCompanion"] as? Bool, true)
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", "--stub-signin"]
        app.launchEnvironment = [
            "GENITA_REVIEW_STAGE": "conversation", "GENITA_REVIEW_STILL": "1",
            "GENITA_API_URL": stub, "GENITA_SERVER_URL": "ws://127.0.0.1:9/v1/session",
        ]
        app.launch()
        XCTAssertTrue(app.buttons["openMenu"].waitForExistence(timeout: 15))
        app.buttons["openMenu"].tap()
        XCTAssertTrue(app.buttons["settings"].waitForExistence(timeout: 5))
        app.buttons["settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
        let row = app.buttons["makeNewCompanion"]
        XCTAssertTrue(row.waitForExistence(timeout: 5), "the row is under Your companion when signed in")
        capture(app, "reset-settings-row")
        row.tap()
        XCTAssertTrue(app.staticTexts["Start over with someone new?"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Jin, their face, voice and your chats together will be removed. What Genita knows about you stays."].exists)
        let startOver = app.buttons["Start over"]
        XCTAssertTrue(startOver.exists)
        // iOS 26 shows the confirmation dialog as a popover without its Cancel row (tap outside cancels), as for Delete account
        capture(app, "reset-confirm-sheet")
        startOver.tap()
        // V01 "Bring an image": the companion is gone on the server and on the phone
        XCTAssertTrue(app.buttons["uploadImage"].waitForExistence(timeout: 15), "routes to V01")
        XCTAssertFalse(app.navigationBars["Settings"].exists)
        capture(app, "reset-after-V01")
        XCTAssertEqual(stubCall("GET", "/me", token: true)?["hasCompanion"] as? Bool, false)
        // (a restart staying at V01 is AppStateTests.testCompanionResetGoesToV01AndKeepsWhatGenitaKnows: --uitesting resets storage)
    }
    // Cancel is the system dialog's own dismissal (iOS 26: a popover without a Cancel row); nothing to test of ours there.
}
