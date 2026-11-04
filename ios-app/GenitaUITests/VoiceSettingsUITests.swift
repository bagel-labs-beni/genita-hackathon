import XCTest

/// Settings → Your companion → Voice (11/4, build 10): the V04 list as a sheet; Save goes through PUT /v1/companion/voice,
/// so the next call on iPhone or Mac speaks with it. Against the onboarding stub (127.0.0.1:8790; CI starts it).
final class VoiceSettingsUITests: XCTestCase {
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

    func testSettingsVoiceOpensTheV04ListAndSavesThePick() throws {
        stubCall("POST", "/__reset")
        guard stubCall("POST", "/__companion", json: #"{"name":"Lou","faceMs":1}"#) != nil else {
            throw XCTSkip("onboarding stub not running on 127.0.0.1:8790")
        }
        XCTAssertEqual(stubCall("GET", "/v1/companion", token: true)?["voiceId"] as? String, "72", "made with Tara, like every companion before 11/4")
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
        XCTAssertTrue(app.buttons["settingsCompanion"].waitForExistence(timeout: 5))
        app.buttons["settingsCompanion"].tap()
        let row = app.buttons["settingsVoice"]
        XCTAssertTrue(row.waitForExistence(timeout: 5), "Voice is a row you can open")
        row.tap()

        // the sheet: the same four V04 cards, the saved voice ticked
        XCTAssertTrue(app.buttons["voice0"].waitForExistence(timeout: 10))
        expectation(for: NSPredicate(format: "label BEGINSWITH 'Tara, Selected'"), evaluatedWith: app.buttons["voice0"])
        waitForExpectations(timeout: 10)
        XCTAssertTrue(app.buttons["voice3"].exists && app.buttons["play2"].exists)
        capture(app, "settings-voice-1-sheet")

        // play Leo: the clip comes from the server and the card shows Playing; the pick moves to Leo
        app.buttons["play2"].tap()
        expectation(for: NSPredicate(format: "label BEGINSWITH 'Leo, Playing'"), evaluatedWith: app.buttons["voice2"])
        waitForExpectations(timeout: 10)
        capture(app, "settings-voice-2-playing")

        app.buttons["voiceSave"].tap()
        XCTAssertTrue(row.waitForExistence(timeout: 10), "Save closes the sheet")
        expectation(for: NSPredicate(format: "label CONTAINS 'Leo'"), evaluatedWith: row)
        waitForExpectations(timeout: 10)
        XCTAssertEqual(stubCall("GET", "/v1/companion", token: true)?["voiceId"] as? String, "19", "saved on the account: the next call (iPhone or Mac) speaks with Leo")
        capture(app, "settings-voice-3-saved")
    }
}
