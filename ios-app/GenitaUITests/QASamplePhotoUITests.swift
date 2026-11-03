import XCTest

/// V01 "Use a test photo" (device QA, 11/4): hidden for a normal account, shown when the server's `/me` lists the
/// account (`qaSamplePhotos`), and a pick goes through the real upload (POST /v1/companion/image on the stub).
/// Runs against ios-app/Tools/onboarding-stub (127.0.0.1:8790), straight on V01 with a stub session.
final class QASamplePhotoUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        stub("POST", "/__reset")
    }
    @discardableResult
    private func stub(_ method: String, _ path: String, json: String = "{}") -> [String: Any] {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:8790" + path)!)
        req.httpMethod = method
        if method == "POST" { req.setValue("application/json", forHTTPHeaderField: "content-type"); req.httpBody = Data(json.utf8) }
        var out: [String: Any] = [:]
        let done = expectation(description: path)
        URLSession.shared.dataTask(with: req) { data, _, _ in
            if let data, let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { out = o }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10)
        return out
    }
    private func launchOnV01(_ app: XCUIApplication) {
        app.launchArguments = ["--uitesting", "--stub-signin"]
        app.launchEnvironment = ["GENITA_API_URL": "http://127.0.0.1:8790", "GENITA_SERVER_URL": "ws://127.0.0.1:8788/v1/session",
                                 "GENITA_FIXTURE_SCRIPT": "none", "GENITA_REVIEW_STAGE": "image", "GENITA_REVIEW_VARIANT": "empty"]
        app.launch()
    }

    func testTestPhotoIsHiddenForANormalAccount() {
        let app = XCUIApplication()
        launchOnV01(app)
        XCTAssertTrue(app.buttons["uploadImage"].waitForExistence(timeout: 15), "V01")
        Thread.sleep(forTimeInterval: 3) // /me has answered (no qaSamplePhotos)
        XCTAssertFalse(app.buttons["qaSamplePhotoEntry"].exists, "a normal account never sees the test photos")
    }

    func testQAAccountPicksATestPhotoAndItIsUploaded() {
        stub("POST", "/__qa", json: #"{"on":true}"#)
        let app = XCUIApplication()
        launchOnV01(app)
        func element(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }
        XCTAssertTrue(app.buttons["uploadImage"].waitForExistence(timeout: 15), "V01")
        let entry = app.buttons["qaSamplePhotoEntry"]
        XCTAssertTrue(entry.waitForExistence(timeout: 10), "/me qaSamplePhotos → Use a test photo")
        XCTAssertEqual(app.buttons["uploadImage"].label, "Upload Image")
        entry.tap()
        let dog = app.buttons["qaSamplePhoto-dog"]
        XCTAssertTrue(dog.waitForExistence(timeout: 5), "the sample sheet")
        for id in ["human", "clay", "anime", "drawing"] { XCTAssertTrue(app.buttons["qaSamplePhoto-\(id)"].exists, id) }
        let sheet = XCTAttachment(screenshot: app.screenshot()); sheet.name = "onb-V01-qa-test-photos"; sheet.lifetime = .keepAlways; add(sheet)
        dog.tap()
        XCTAssertTrue(app.buttons["Change image"].waitForExistence(timeout: 5), "the picked photo is on V01, as a library pick")
        app.buttons["rightsAck"].tap()
        let primary = app.buttons["primaryCTA"]
        XCTAssertTrue(primary.isEnabled)
        primary.tap()
        XCTAssertTrue(element("V02-T").waitForExistence(timeout: 20), "V03 → V02-T on the stub's check answer")
        let bytes = stub("GET", "/__last-image")["bytes"] as? Int ?? 0
        XCTAssertGreaterThan(bytes, 10_000, "the test photo went up through POST /v1/companion/image")
    }
}
