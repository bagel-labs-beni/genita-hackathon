import XCTest

/// Pixel QA (11/4): the companion flow for a non-human face, one run per QA test photo (dog · clay · hand-drawn bear ·
/// anime): V01 pick → V03 scan → V02-T confirm → V04 voice → NM01 name → D01 → P → SUM → PREP-1 → S07 → S09 first
/// frame. Screens `onb-kind-<photo>-<screen>` go to the call-screens artifact for the eye check (line breaks,
/// alignment, how the photo sits in each frame). Against ios-app/Tools/onboarding-stub (8790), no photo library.
final class CompanionKindsUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        stub("POST", "/__reset")
        stub("POST", "/__qa", json: #"{"on":true}"#)
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

    func testKindDog() { walk("dog") }
    func testKindClay() { walk("clay") }
    func testKindDrawing() { walk("drawing") }
    func testKindAnime() { walk("anime") }

    private func walk(_ photo: String) {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", "--stub-signin"]
        app.launchEnvironment = ["GENITA_API_URL": "http://127.0.0.1:8790", "GENITA_SERVER_URL": "ws://127.0.0.1:8788/v1/session",
                                 "GENITA_FIXTURE_SCRIPT": "none", "GENITA_REVIEW_STAGE": "image", "GENITA_REVIEW_VARIANT": "empty",
                                 "GENITA_REVIEW_STILL": "1"]
        app.launch()
        func element(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }
        func capture(_ name: String) {
            Thread.sleep(forTimeInterval: 0.4)
            let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "onb-kind-\(photo)-\(name)"; shot.lifetime = .keepAlways; add(shot)
        }
        let primary = app.buttons["primaryCTA"]

        // V01: Use a test photo → the sample
        XCTAssertTrue(app.buttons["uploadImage"].waitForExistence(timeout: 15), "V01")
        let entry = app.buttons["qaSamplePhotoEntry"]
        XCTAssertTrue(entry.waitForExistence(timeout: 10), "Use a test photo")
        entry.tap()
        let pick = app.buttons["qaSamplePhoto-\(photo)"]
        XCTAssertTrue(pick.waitForExistence(timeout: 5), "sample sheet")
        pick.tap()
        XCTAssertTrue(app.buttons["Change image"].waitForExistence(timeout: 5), "picked")
        app.buttons["rightsAck"].tap()
        capture("V01-picked")
        primary.tap()

        // V03 scan → V02-T confirm
        if element("V03").waitForExistence(timeout: 3) { capture("V03") }
        XCTAssertTrue(element("V02-T").waitForExistence(timeout: 20), "V02-T")
        capture("V02-T")
        primary.tap()

        // V04: pick the first voice, wait until it is selected
        XCTAssertTrue(app.buttons["voice0"].waitForExistence(timeout: 10), "V04")
        capture("V04")
        app.buttons["voice0"].tap()
        expectation(for: NSPredicate(format: "label CONTAINS 'Selected'"), evaluatedWith: app.buttons["voice0"])
        waitForExpectations(timeout: 15)
        XCTAssertTrue(primary.isEnabled)
        primary.tap()

        // NM01: the suggested name
        let name = app.textFields["companionNameInput"]
        XCTAssertTrue(name.waitForExistence(timeout: 10), "NM01")
        expectation(for: NSPredicate(format: "value != nil AND value != ''"), evaluatedWith: name)
        waitForExpectations(timeout: 10)
        capture("NM01")
        primary.tap()

        // D01 → P (Right) → SUM
        XCTAssertTrue(element("NM01").waitForNonExistence(timeout: 10))
        capture("D01")
        primary.tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Think with me'")).firstMatch.tap(); primary.tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Trusted partner'")).firstMatch.tap(); primary.tap()
        primary.tap()   // challenge
        primary.tap()   // tempo
        app.buttons["Calm"].firstMatch.tap(); primary.tap()
        capture("SUM")
        primary.tap()

        // PREP-1 → (Try again after the stub's face failure) → ready → S07 → S09
        XCTAssertTrue(element("PREP-1").waitForExistence(timeout: 15), "PREP-1")
        capture("PREP1-start")
        expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: app.buttons["prepContinue"])
        waitForExpectations(timeout: 20)
        capture("PREP1-scene-done")
        if app.buttons["prepRetry"].waitForExistence(timeout: 20) { capture("PREP1-failed"); app.buttons["prepRetry"].tap() }
        expectation(for: NSPredicate(format: "label ENDSWITH 'is ready.'"), evaluatedWith: element("PREP-1"))
        waitForExpectations(timeout: 25)
        capture("PREP1-ready")
        if element("connectingPill").waitForExistence(timeout: 6) { capture("S07") }
        XCTAssertTrue(app.buttons["micToggle"].waitForExistence(timeout: 25), "S09")
        Thread.sleep(forTimeInterval: 1.5)
        capture("S09-first-frame")
    }
}
