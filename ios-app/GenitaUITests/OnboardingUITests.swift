import XCTest

/// F2–F4 on the server (L2): a signed-in account with no companion walks the whole onboarding against
/// ios-app/Tools/onboarding-stub (127.0.0.1:8790, PREP_API.md shapes) and lands in the call on the replay
/// server (8788). Screenshots `onb-*` go to the workflow artifact for the eye check against Figma.
final class OnboardingUITests: XCTestCase {
    /// the stub is shared by the tests of one run: start each from "no companion, voice service up"
    override func setUp() {
        super.setUp()
        stubPost("/__reset")
    }
    private func stubPost(_ path: String, json: String = "{}") {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:8790" + path)!)
        req.httpMethod = "POST"; req.setValue("application/json", forHTTPHeaderField: "content-type"); req.httpBody = Data(json.utf8)
        let done = expectation(description: path)
        URLSession.shared.dataTask(with: req) { _, _, _ in done.fulfill() }.resume()
        wait(for: [done], timeout: 10)
    }

    func testOnboardingAgainstTheServer() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", "--stub-signin", "--fixture-image"]
        app.launchEnvironment = [
            "GENITA_API_URL": "http://127.0.0.1:8790",
            "GENITA_SERVER_URL": "ws://127.0.0.1:8788/v1/session",
            "GENITA_FIXTURE_SCRIPT": "none",
            "GENITA_REVIEW_STILL": "1",
        ]
        // PREP-1e: the stub's face step fails at 7 of 13 images until Try again
        stubPost("/__prep", json: #"{"failAt":7}"#)
        app.launch()

        func capture(_ name: String) {
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.name = "onb-" + name
            shot.lifetime = .keepAlways
            add(shot)
        }
        func element(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }
        let primary = app.buttons["primaryCTA"]

        // F1-L7: /me says signed in, consented, named, no companion → I01
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 15), "StartRouter → I01")
        XCTAssertTrue(app.buttons["openChatGPT"].exists && app.buttons["openClaude"].exists)
        XCTAssertTrue(app.buttons["skipImport"].exists)
        // D44/D55: the copy says "the AI assistant you use"; only the two Open buttons name ChatGPT / Claude
        let named = NSPredicate(format: "(label CONTAINS[c] 'chatgpt' OR label CONTAINS[c] 'claude') AND NOT (label BEGINSWITH 'Open ')")
        XCTAssertFalse(app.staticTexts.matching(named).firstMatch.exists, "I01 copy names no assistant (D44)")
        let skipLabel = app.buttons["skipImport"].label.lowercased()
        XCTAssertFalse(skipLabel.contains("chatgpt") || skipLabel.contains("claude"), "I01 skip link names no assistant (D44)")
        capture("I01")
        primary.tap()

        // I02 → I03 → I04 (six rows from the server)
        let input = element("responseInput")
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["pasteReply"].exists, "I02 one-tap paste")
        input.tap()
        input.typeText("Communication style: warm and direct. Response preferences: two options, one recommended.")
        capture("I02")
        // the primary button comes back once the keyboard is down (tap the title, as on the device)
        app.buttons["Dismiss keyboard"].tap()
        XCTAssertTrue(primary.waitForExistence(timeout: 5))
        primary.tap()
        capture("I03")
        let profile = element("profileResult")
        XCTAssertTrue(profile.waitForExistence(timeout: 15), "I04 after the import")
        XCTAssertTrue((profile.value as? String ?? "").contains("How Genita can help"), "I04 shows the sixth row")
        capture("I04")
        primary.tap()

        // V01 (fixture photo) → V03 → V02-T
        XCTAssertTrue(app.buttons["uploadImage"].waitForExistence(timeout: 5))
        capture("V01")
        primary.tap()
        XCTAssertTrue(element("V03").waitForExistence(timeout: 3), "V03 while the check runs")
        capture("V03")
        XCTAssertTrue(element("V02-T").waitForExistence(timeout: 15), "V02-T passed")
        XCTAssertTrue(element("typeChips").exists && element("rightsLine").exists)
        capture("V02-T")
        primary.tap()

        // V04: the server's four voices (Figma "voice model" frames): nothing picked, Continue off
        XCTAssertTrue(app.buttons["voice0"].waitForExistence(timeout: 10))
        XCTAssertTrue(element("voiceHint").exists, "V04 hint line")
        XCTAssertTrue((app.buttons["voice0"].label).hasPrefix("Tara"), "first voice is the recommended human default")
        XCTAssertFalse(primary.isEnabled, "V04: nothing picked yet")
        capture("V04")
        // play Leah: the clip comes from the server, the card turns to "Playing · …" and Continue stays off
        app.buttons["play1"].tap()
        expectation(for: NSPredicate(format: "label BEGINSWITH 'Leah, Playing'"), evaluatedWith: app.buttons["voice1"])
        waitForExpectations(timeout: 10)
        XCTAssertFalse(primary.isEnabled, "V04-P: Continue waits for the clip")
        capture("V04-P")
        // when the 1.6 s clip ends the card stays picked
        expectation(for: NSPredicate(format: "label BEGINSWITH 'Leah, Selected'"), evaluatedWith: app.buttons["voice1"])
        waitForExpectations(timeout: 10)
        XCTAssertTrue(primary.isEnabled)
        capture("V04-S")
        primary.tap()

        // NM01: pre-filled from the server's suggestion, editable, empty keeps Continue off, 20 characters max
        let name = app.textFields["companionNameInput"]
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        let suggested = NSPredicate(format: "value == %@", "Jin")
        expectation(for: suggested, evaluatedWith: name)
        waitForExpectations(timeout: 10)
        capture("NM01")
        app.buttons["clearName"].tap()
        XCTAssertFalse(primary.isEnabled, "NM01-0: empty name, Continue off")
        XCTAssertTrue(app.buttons["useSuggestedName"].waitForExistence(timeout: 3), "NM01-0: Use Jin (154:2)")
        capture("NM01-0")
        app.buttons["useSuggestedName"].tap()
        expectation(for: suggested, evaluatedWith: name)
        waitForExpectations(timeout: 5)
        app.buttons["clearName"].tap()
        name.typeText("Maxwell the Wonderful Companion")
        XCTAssertEqual((name.value as? String)?.count, 20, "the 21st character can't be typed")
        app.buttons["clearName"].tap()
        name.typeText("Max")
        capture("NM01-E")
        primary.tap()

        // D01 → P (Right: 5) → SUM
        XCTAssertTrue(element("NM01").waitForNonExistence(timeout: 10))
        primary.tap()   // D01 Right (default)
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Think with me'")).firstMatch.tap(); primary.tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Trusted partner'")).firstMatch.tap(); primary.tap()
        primary.tap()   // challenge
        primary.tap()   // tempo
        app.buttons["Calm"].firstMatch.tap(); primary.tap()
        capture("SUM")
        primary.tap()

        // PREP-1 (Figma 182:51 → 182:3 → 182:142 → 182:96): stages follow the server's real Meta-only shape,
        // Start talking once the scene exists, Try again after the face step fails, then ready → S07 by itself
        XCTAssertTrue(element("PREP-1").waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["prepContinue"].isEnabled, "PREP-1a: Start talking off before the scene")
        capture("PREP1-start")
        // Start talking lights up once the server says the scene is done (stub: 3 s after PREP-1's first poll)
        expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: app.buttons["prepContinue"])
        waitForExpectations(timeout: 15)
        XCTAssertEqual(element("prepStage-mouth").value as? String, "pending", "the skipped Peter lips don't mark Mouth done")
        capture("PREP1-scene-done")
        // PREP-1e: the stub fails the face step at 7/13 (expressions done, mouth failed)
        XCTAssertTrue(app.buttons["prepRetry"].waitForExistence(timeout: 20), "PREP-1e Try again")
        XCTAssertTrue(app.buttons["prepContinuePhoto"].exists, "Continue with the photo")
        XCTAssertEqual(element("prepStage-mouth").value as? String, "failed")
        XCTAssertEqual(element("prepStage-expressions").value as? String, "done")
        capture("PREP1-failed")
        app.buttons["prepRetry"].tap()
        // retry carries on from 7/13 → ready about 6 s later: "Max is ready." without a button, then S07
        expectation(for: NSPredicate(format: "label == %@", "Max is ready."), evaluatedWith: element("PREP-1"))
        waitForExpectations(timeout: 20)
        XCTAssertFalse(app.buttons["prepContinue"].exists || app.buttons["prepRetry"].exists, "PREP-1c has no button")
        capture("PREP1-ready")
        let pill = element("connectingPill")
        if pill.waitForExistence(timeout: 5) { capture("S07") }
        XCTAssertTrue(app.buttons["micToggle"].waitForExistence(timeout: 20), "S09 after S07")
        capture("S09-first-call")
    }

    /// F12 / #86: a returning account whose face is still being made opens straight on the call (no onboarding,
    /// no PREP-1) with the photo face and the S09-PREP pill (228:543) following the server's prep.
    func testReturningWhileTheFaceIsStillBeingMade() throws {
        stubPost("/__companion", json: #"{"name":"Jin","faceMs":5000}"#)
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", "--stub-signin", "--fixture-image"]
        app.launchEnvironment = [
            "GENITA_API_URL": "http://127.0.0.1:8790",
            "GENITA_SERVER_URL": "ws://127.0.0.1:8788/v1/session",
            "GENITA_FIXTURE_SCRIPT": "none",
            "GENITA_REVIEW_STILL": "1",
        ]
        app.launch()
        XCTAssertTrue(app.buttons["micToggle"].waitForExistence(timeout: 25), "StartRouter → S07 → S09, no onboarding")
        XCTAssertFalse(app.buttons["copyPrompt"].exists, "no I01 for an account with a companion")
        let pill = app.descendants(matching: .any).matching(identifier: "callPrepPill").firstMatch
        XCTAssertTrue(pill.waitForExistence(timeout: 15), "S09-PREP while prep runs")
        XCTAssertTrue(pill.label.hasPrefix("Getting the"), pill.label)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "onb-S09-PREP"
        shot.lifetime = .keepAlways
        add(shot)
    }

    /// V04 with the voice service down or cold: the list is greyed, says "Voice preview is waking up", and the
    /// recommended default stays picked so the user can still continue (PUT saves it; the server default already is it).
    func testVoicePickerWhenTheVoiceServiceIsDown() throws {
        stubPost("/__voice", json: #"{"down":true}"#)
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", "--stub-signin", "--fixture-image"]
        app.launchEnvironment = [
            "GENITA_API_URL": "http://127.0.0.1:8790",
            "GENITA_SERVER_URL": "ws://127.0.0.1:8788/v1/session",
            "GENITA_FIXTURE_SCRIPT": "none",
            "GENITA_REVIEW_STILL": "1",
        ]
        app.launch()
        func element(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }
        let primary = app.buttons["primaryCTA"]
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 15))
        primary.tap()
        let input = element("responseInput")
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.tap()
        input.typeText("Communication style: warm and direct. Response preferences: two options, one recommended.")
        app.buttons["Dismiss keyboard"].tap()
        XCTAssertTrue(primary.waitForExistence(timeout: 5))
        primary.tap()
        XCTAssertTrue(element("profileResult").waitForExistence(timeout: 15))
        primary.tap()
        XCTAssertTrue(app.buttons["uploadImage"].waitForExistence(timeout: 5))
        primary.tap()
        XCTAssertTrue(element("V02-T").waitForExistence(timeout: 15))
        primary.tap()

        XCTAssertTrue(element("voiceWaking").waitForExistence(timeout: 15), "V04: Voice preview is waking up")
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "onb-V04-waking"; shot.lifetime = .keepAlways; add(shot)
        XCTAssertFalse(app.buttons["play0"].isEnabled, "greyed: no preview while the voice service is down")
        XCTAssertTrue(primary.isEnabled, "the default voice is picked, Continue works")
        primary.tap()
        XCTAssertTrue(app.textFields["companionNameInput"].waitForExistence(timeout: 10), "NM01 follows")
    }

    /// I01 "I don't use an AI assistant" → N1 → N2 → N3 → I04-S, for the eye check against Figma N1–N3.
    /// Named to run before testOnboardingAgainstTheServer: it creates no companion on the stub.
    func testImportSkipPath() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", "--stub-signin", "--fixture-image"]
        app.launchEnvironment = ["GENITA_API_URL": "http://127.0.0.1:8790", "GENITA_SERVER_URL": "ws://127.0.0.1:8788/v1/session", "GENITA_FIXTURE_SCRIPT": "none"]
        app.launch()
        func capture(_ name: String) {
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.name = "onb-" + name
            shot.lifetime = .keepAlways
            add(shot)
        }
        func element(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }
        let skip = app.buttons["skipImport"]
        XCTAssertTrue(skip.waitForExistence(timeout: 15), "StartRouter → I01")
        skip.tap()
        XCTAssertTrue(element("skipTopics").waitForExistence(timeout: 5), "N1")
        app.buttons["Design"].tap()
        capture("N1")
        app.buttons["primaryCTA"].tap()
        XCTAssertTrue(element("skipReplies").waitForExistence(timeout: 5), "N2")
        app.buttons["Show me options"].tap()
        capture("N2")
        app.buttons["primaryCTA"].tap()
        XCTAssertTrue(element("skipAvoid").waitForExistence(timeout: 5), "N3")
        capture("N3")
        app.buttons["primaryCTA"].tap()
        XCTAssertTrue(element("profileResult").waitForExistence(timeout: 15), "I04-S after N3")
        capture("I04-S")
    }
}
