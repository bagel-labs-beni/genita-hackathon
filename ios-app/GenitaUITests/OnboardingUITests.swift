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
        XCTAssertEqual(element("prepStage-mouth").value as? String, "pending", "the skipped lip step doesn't mark Mouth done")
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
        // Figma 267:4 shows Design, Food and Film & TV picked
        for chip in ["Design", "Food", "Film & TV"] { app.buttons["skipChip-" + chip].tap() }
        XCTAssertTrue(app.buttons["skipChip-Building things"].exists && app.buttons["skipCustom"].exists, "N1 tiles + Add your own")
        capture("N1")
        // Add your own → an extra selected tile
        app.buttons["skipCustom"].tap()
        let field = app.alerts.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.typeText("Pottery")
        app.alerts.buttons["Add"].tap()
        XCTAssertTrue(app.buttons["skipChip-Pottery"].waitForExistence(timeout: 5), "custom topic becomes a tile")
        app.buttons["skipChip-Pottery"].tap()   // and off again, so the capture above stays the Figma state
        app.buttons["primaryCTA"].tap()
        XCTAssertTrue(element("skipReplies").waitForExistence(timeout: 5), "N2")
        app.buttons["skipChip-Start with the answer"].tap()   // Figma 267:57
        capture("N2")
        app.buttons["primaryCTA"].tap()
        XCTAssertTrue(element("skipAvoid").waitForExistence(timeout: 5), "N3")
        capture("N3-0")   // Figma 269:112: nothing picked, Continue still on
        XCTAssertTrue(app.buttons["primaryCTA"].isEnabled)
        // Figma 269:2: like = Minimal, Comfy, Spicy, Noodles, Jokes; no (two taps) = Colorful, Seafood, Unasked advice, Talk about looks
        for chip in ["Minimal", "Comfy", "Spicy", "Noodles", "Jokes"] { app.buttons["skipChip-" + chip].tap() }
        for chip in ["Colorful", "Seafood", "Unasked advice", "Talk about looks"] { app.buttons["skipChip-" + chip].tap(); app.buttons["skipChip-" + chip].tap() }
        for _ in 0..<3 { app.buttons["skipChip-Street"].tap() }   // three taps clear
        XCTAssertEqual(app.buttons["skipChip-Seafood"].value as? String, "Not for me")
        XCTAssertEqual(app.buttons["skipChip-Spicy"].value as? String, "Liked")
        XCTAssertEqual(app.buttons["skipChip-Street"].value as? String, "Not selected")
        capture("N3")
        app.buttons["primaryCTA"].tap()
        XCTAssertTrue(element("profileResult").waitForExistence(timeout: 15), "I04-S after N3")
        capture("I04-S")
    }

    private func launchToI01(_ app: XCUIApplication) {
        app.launchArguments = ["--uitesting", "--stub-signin", "--fixture-image"]
        app.launchEnvironment = ["GENITA_API_URL": "http://127.0.0.1:8790", "GENITA_SERVER_URL": "ws://127.0.0.1:8788/v1/session", "GENITA_FIXTURE_SCRIPT": "none"]
        app.launch()
    }

    /// I01 "Open ChatGPT": one tap copies the prompt ("Prompt copied"), opens the AI app, and coming back lands on I02
    /// with the system paste button ready. Named so it runs before the tests that create a companion on the stub.
    func testAOpenChatGPTCopiesThenReturnsToPaste() throws {
        let app = XCUIApplication()
        launchToI01(app)
        func element(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }
        XCTAssertTrue(app.buttons["openChatGPT"].waitForExistence(timeout: 15), "I01")
        app.buttons["openChatGPT"].tap()
        // One tap copies the prompt, shows "Prompt copied" and opens ChatGPT (on the simulator, with no ChatGPT app:
        // chatgpt.com in Safari). Safari can take the foreground before the toast is read (flaky on loaded CI
        // runners), so the toast is only looked for while Genita is still in front; the open and the copy are then
        // checked on their own: Safari comes to the front, and back on I02 the paste button pastes the prompt.
        let toast = element("promptCopiedToast")
        var sawToast = false
        let end = Date().addingTimeInterval(3)
        while Date() < end, app.state == .runningForeground {
            if toast.exists { sawToast = true; break }
            Thread.sleep(forTimeInterval: 0.05)
        }
        if sawToast { let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "onb-I01-prompt-copied"; shot.lifetime = .keepAlways; add(shot) }
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 15), "the AI app's site opened")
        XCTAssertTrue(app.wait(for: .runningBackground, timeout: 5))
        app.activate()
        XCTAssertTrue(app.buttons["pasteReply"].waitForExistence(timeout: 10), "back from the AI app → I02 with the paste button")
        XCTAssertTrue(element("responseInput").exists)
        XCTAssertFalse(element("copyPrompt").exists, "not on I01 any more")
        // the copy: the system paste button puts the I01 prompt into the reply box
        app.buttons["pasteReply"].tap()
        let pasted = NSPredicate(format: "value CONTAINS %@", "evidence-based personalization profile for Genita")
        expectation(for: pasted, evaluatedWith: element("responseInput")); waitForExpectations(timeout: 10)
        let back = XCTAttachment(screenshot: app.screenshot()); back.name = "onb-I02-paste-first"; back.lifetime = .keepAlways; add(back)
    }

    /// D01: people who skipped the import (N1–N3) start on Quick start (setUp resets the stub companion).
    func testZSkipperGetsQuickAtD01() throws {
        let app = XCUIApplication()
        launchToI01(app)
        func element(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }
        let primary = app.buttons["primaryCTA"]
        XCTAssertTrue(app.buttons["skipImport"].waitForExistence(timeout: 15)); app.buttons["skipImport"].tap()
        XCTAssertTrue(element("skipTopics").waitForExistence(timeout: 5)); primary.tap()
        XCTAssertTrue(element("skipReplies").waitForExistence(timeout: 5)); primary.tap()
        XCTAssertTrue(element("skipAvoid").waitForExistence(timeout: 5)); primary.tap()
        XCTAssertTrue(element("profileResult").waitForExistence(timeout: 15), "I04-S"); primary.tap()
        XCTAssertTrue(app.buttons["uploadImage"].waitForExistence(timeout: 5))
        if app.buttons["rightsAck"].exists { app.buttons["rightsAck"].tap() }   // V01 rights line (#197)
        primary.tap()
        XCTAssertTrue(element("V02-T").waitForExistence(timeout: 15)); primary.tap()
        XCTAssertTrue(app.buttons["play1"].waitForExistence(timeout: 10)); app.buttons["play1"].tap()
        expectation(for: NSPredicate(format: "label BEGINSWITH 'Leah, Selected'"), evaluatedWith: app.buttons["voice1"]); waitForExpectations(timeout: 15)
        primary.tap()
        let name = app.textFields["companionNameInput"]
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        expectation(for: NSPredicate(format: "value != %@ AND value != %@", "", "Name"), evaluatedWith: name); waitForExpectations(timeout: 10)
        primary.tap()
        let quick = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Quick start'")).firstMatch
        XCTAssertTrue(quick.waitForExistence(timeout: 10), "D01")
        XCTAssertTrue(quick.isSelected, "skippers start on Quick start")
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "onb-D01-quick-for-skippers"; shot.lifetime = .keepAlways; add(shot)
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
        XCTAssertTrue(element("voiceWakingSpinner").exists, "a spinner shows while it wakes")
        XCTAssertFalse(app.buttons["play0"].isEnabled, "greyed: no preview while the voice service is down")
        XCTAssertTrue(primary.isEnabled, "the default voice is picked, Continue works")
        // the voice service comes up: the app asks again every 4 s and swaps in the normal list by itself
        stubPost("/__voice", json: #"{"down":false}"#)
        XCTAssertTrue(element("voiceHint").waitForExistence(timeout: 20), "V04 back to the normal list")
        XCTAssertTrue(app.buttons["play0"].isEnabled)
        let up = XCTAttachment(screenshot: app.screenshot()); up.name = "onb-V04-recovered"; up.lifetime = .keepAlways; add(up)
        primary.tap()
        XCTAssertTrue(app.textFields["companionNameInput"].waitForExistence(timeout: 10), "NM01 follows")
    }
}
