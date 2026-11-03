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

    /// D26 V02-F: a well-known person is refused with its own reason row and note (review fixture, no server).
    func testV02FRefusesAWellKnownPerson() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        app.launchEnvironment = ["GENITA_REVIEW_STAGE": "imageCheck", "GENITA_REVIEW_VARIANT": "fail-public_figure", "GENITA_REVIEW_STILL": "1"]
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["V02-F"].waitForExistence(timeout: 10), "V02-F")
        XCTAssertTrue(app.descendants(matching: .any)["Failed: This looks like a well-known person"].exists, "one red row with the server's reason")
        XCTAssertEqual(app.descendants(matching: .any)["failHint"].label, "Genita can't bring public figures to life.")
        Thread.sleep(forTimeInterval: 0.5)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "onb-V02-F-public-figure"; shot.lifetime = .keepAlways; add(shot)
    }

    /// V03 face scan (dyno Figma 526:15314): the scan held at 0 / 55 / 100 % over the review photo with its live SAM net.
    func testV03FaceScanStates() throws {
        for pct in [0, 55, 100] {
            let app = XCUIApplication()
            app.launchArguments = ["--uitesting"]
            app.launchEnvironment = ["GENITA_REVIEW_STAGE": "imageCheck", "GENITA_REVIEW_VARIANT": "scan-\(pct)", "GENITA_REVIEW_STILL": "1"]
            app.launch()
            XCTAssertTrue(app.descendants(matching: .any)["V03"].waitForExistence(timeout: 10), "V03 at \(pct) %")
            XCTAssertEqual(app.descendants(matching: .any)["imageCheckProgress"].label, "\(pct)%")
            Thread.sleep(forTimeInterval: 0.6)
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.name = "onb-V03-scan-\(pct)"; shot.lifetime = .keepAlways; add(shot)
            app.terminate()
        }
    }

    /// V03 face scan motion over a person / an animal / a character (CI records the simulator around each).
    func testV03MotionHuman() throws { try runV03Motion("human") }
    func testV03MotionAnimal() throws { try runV03Motion("animal") }
    func testV03MotionCharacter() throws { try runV03Motion("character") }
    private func runV03Motion(_ kind: String) throws {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        app.launchEnvironment = ["GENITA_REVIEW_STAGE": "imageCheck", "GENITA_REVIEW_VARIANT": "anim-\(kind)"]
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["V03"].waitForExistence(timeout: 10), "V03 scanning")
        // the answer comes at 2.6 s, then 0.4 s finish + 1 s hold + 0.3 s fade before V02-T
        XCTAssertTrue(app.descendants(matching: .any)["V02-T"].waitForExistence(timeout: 15), "V02-T after the scan")
        Thread.sleep(forTimeInterval: 0.8)
        app.terminate()
    }

    /// Photo polish (11/4): V02-T confirms the polished picture with "Use this image" and "Try again (2 left)", no "Use my original".
    func testV02TConfirmsThePolishedPhoto() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        app.launchEnvironment = ["GENITA_REVIEW_STAGE": "imageCheck", "GENITA_REVIEW_VARIANT": "polished", "GENITA_REVIEW_STILL": "1"]
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["V02-T"].waitForExistence(timeout: 10), "V02-T")
        XCTAssertTrue(app.descendants(matching: .any)["polishedImage"].exists, "the polished picture is shown")
        XCTAssertEqual(app.buttons["primaryCTA"].label, "Use this image")
        XCTAssertEqual(app.buttons["polishTryAgain"].label, "Try again (2 left)")
        XCTAssertFalse(app.buttons["Use my original"].exists)
        Thread.sleep(forTimeInterval: 0.5)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "onb-V02-T-polished"; shot.lifetime = .keepAlways; add(shot)
    }

    /// After two retries only "Use this image" is left (Chelsea 11/4: the last result or another photo).
    func testV02TAfterTheLastRetry() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        app.launchEnvironment = ["GENITA_REVIEW_STAGE": "imageCheck", "GENITA_REVIEW_VARIANT": "polished-last", "GENITA_REVIEW_STILL": "1"]
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["V02-T"].waitForExistence(timeout: 10), "V02-T")
        XCTAssertFalse(app.buttons["polishTryAgain"].exists)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "onb-V02-T-polished-last"; shot.lifetime = .keepAlways; add(shot)
    }

    /// A photo without any face: one plain line (Chelsea 11/4).
    func testV02FNoFace() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        app.launchEnvironment = ["GENITA_REVIEW_STAGE": "imageCheck", "GENITA_REVIEW_VARIANT": "fail-no_face", "GENITA_REVIEW_STILL": "1"]
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["V02-F"].waitForExistence(timeout: 10), "V02-F")
        XCTAssertTrue(app.descendants(matching: .any)["Failed: We couldn't find a clear face. Try another photo."].exists)
        XCTAssertEqual(app.buttons["primaryCTA"].label, "Choose another image")
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "onb-V02-F-no-face"; shot.lifetime = .keepAlways; add(shot)
    }

    func testOnboardingAgainstTheServer() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", "--stub-signin", "--fixture-image"]
        app.launchEnvironment = [
            "GENITA_API_URL": "http://127.0.0.1:8790",
            "GENITA_SERVER_URL": "ws://127.0.0.1:8788/v1/session",
            "GENITA_FIXTURE_SCRIPT": "none",
            "GENITA_REVIEW_STILL": "1",
            // C2 without the simulator's mic or a Speech permission prompt; C3 toast long enough for the capture
            "GENITA_FAKE_DICTATION": "I actually love cilantro. Raw onion is the one I skip.",
            "GENITA_HISY_TOAST_MS": "6000",
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
        /// HISY pages slide (0.28 s): let the old page leave before tapping a button both pages have.
        func tapSettled(_ id: String) { Thread.sleep(forTimeInterval: 0.5); app.buttons.matching(identifier: id).firstMatch.tap() }
        let primary = app.buttons["primaryCTA"]
        func waitLabel(_ e: XCUIElement, _ label: String, timeout: TimeInterval = 5) -> Bool {
            let end = Date().addingTimeInterval(timeout)
            while Date() < end { if e.exists, e.label == label { return true }; Thread.sleep(forTimeInterval: 0.1) }
            return false
        }

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
        // I03 → D47 HISY v2 (Figma HISY-0~7, C1~C3): the six cards came with the import
        let dots = element("hisyDots")
        XCTAssertTrue(element("hisyOpener").waitForExistence(timeout: 15), "HISY-0 after the import")
        XCTAssertTrue(app.staticTexts["Six short cards. If one is off, tell me."].exists, "HISY-0 counts the real cards")
        Thread.sleep(forTimeInterval: 0.4)
        capture("HISY-0")
        app.buttons["hisyShowMe"].tap()
        XCTAssertTrue(waitLabel(dots, "Card 1 of 6"), "HISY-1")
        XCTAssertTrue(app.staticTexts["You decide by comparing, not by guessing."].exists)
        Thread.sleep(forTimeInterval: 0.4)
        capture("HISY-1")
        tapSettled("hisyNext")
        XCTAssertTrue(waitLabel(dots, "Card 2 of 6"), "Next")
        Thread.sleep(forTimeInterval: 0.4)
        capture("HISY-2")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.32)).tap()   // left tap = back
        XCTAssertTrue(waitLabel(dots, "Card 1 of 6"), "left tap goes back")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.32)).tap()   // right tap = next
        XCTAssertTrue(waitLabel(dots, "Card 2 of 6"), "right tap goes on")
        tapSettled("hisyNext")
        XCTAssertTrue(waitLabel(dots, "Card 3 of 6"), "HISY-3")
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'hisyTag' AND label == 'Under $100'")).firstMatch.exists, "budget as a style tag")
        Thread.sleep(forTimeInterval: 0.4)
        capture("HISY-3")

        // C1 → C2 → C3: mark "Not for you: cilantro", hold the mic, Save → the same card, new texts in blue
        tapSettled("hisyNotMe")
        let save = app.buttons["hisyFixSave"]
        XCTAssertTrue(save.waitForExistence(timeout: 5), "C1")
        XCTAssertFalse(save.isEnabled, "nothing marked or typed yet")
        app.buttons["Not for you: cilantro"].tap()
        XCTAssertTrue(save.isEnabled)
        Thread.sleep(forTimeInterval: 0.3)
        capture("HISY-C1")
        element("hisyMic").press(forDuration: 0.6)
        XCTAssertTrue(element("hisyFixHint").label.contains("Listening"), "C2 while the mic is held")
        XCTAssertEqual(element("hisyFixText").value as? String, "I actually love cilantro. Raw onion is the one I skip.")
        capture("HISY-C2")
        save.tap()
        let toast = element("hisyToast")
        XCTAssertTrue(toast.waitForExistence(timeout: 15), "C3 toast")
        XCTAssertTrue(toast.label.contains("Got it. I’ll remember that."))
        let onion = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'hisyTag' AND label == 'Not for you: Raw onion'")).firstMatch
        XCTAssertTrue(onion.exists, "the new dislike")
        XCTAssertEqual(onion.value as? String, "changed", "blue border on what changed")
        XCTAssertFalse(save.exists, "the sheet closed")
        Thread.sleep(forTimeInterval: 0.4)
        capture("HISY-C3")

        for (n, name) in [(4, "HISY-4"), (5, "HISY-5"), (6, "HISY-6")] {
            tapSettled("hisyNext")
            XCTAssertTrue(waitLabel(dots, "Card \(n) of 6"), name)
            Thread.sleep(forTimeInterval: 0.4)
            capture(name)
        }
        XCTAssertFalse(element("hisyAlways").exists, "HISY-6: the And-always box is HISY-5's only")
        tapSettled("hisyNext")
        XCTAssertTrue(element("hisyFace").waitForExistence(timeout: 5), "HISY-7")
        Thread.sleep(forTimeInterval: 0.4)
        capture("HISY-7")
        tapSettled("hisyBackToCards")
        XCTAssertTrue(waitLabel(dots, "Card 6 of 6"), "Back to the cards")
        tapSettled("hisySkip")
        XCTAssertTrue(element("hisyFace").waitForExistence(timeout: 5), "Skip = HISY-7")
        tapSettled("hisyChoosePhoto")

        // V01 (fixture photo) → V03 → V02-T
        XCTAssertTrue(app.buttons["uploadImage"].waitForExistence(timeout: 5))
        capture("V01")
        // SUB-8 (#125) / D26: the rights line is on screen and "Use this image" stays off until it is on
        let rights = app.buttons["rightsAck"]
        XCTAssertTrue(rights.exists, "V01 shows the rights line")
        XCTAssertEqual(rights.value as? String, "Off")
        XCTAssertFalse(primary.isEnabled, "no check without the rights line")
        rights.tap()
        XCTAssertEqual(rights.value as? String, "On")
        XCTAssertTrue(primary.isEnabled)
        capture("V01-rights-on")
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
        // when the 4 s stub clip ends the card stays picked
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

    /// I01 "I don't use an AI assistant" → N1 → N2 → N3 → HISY-S0 → S1~S4 → HISY-7, for the eye check against Figma.
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
        /// HISY pages slide (0.28 s): let the old page leave before tapping a button both pages have.
        func tapSettled(_ id: String) { Thread.sleep(forTimeInterval: 0.5); app.buttons.matching(identifier: id).firstMatch.tap() }
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
        // N3 → S0 → S1~S4 (the story is written from the three answers: GET /v1/profile/story)
        XCTAssertTrue(element("hisyOpener").waitForExistence(timeout: 15), "S0 after N3")
        let ready = NSPredicate(format: "isEnabled == true")
        expectation(for: ready, evaluatedWith: app.buttons["hisyShowMe"])
        waitForExpectations(timeout: 20)
        XCTAssertTrue(app.staticTexts["Four short cards. I’ll learn the rest in our calls."].waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 0.4)
        capture("HISY-S0")
        app.buttons["hisyShowMe"].tap()
        let dots = element("hisyDots")
        for n in 1...4 {
            if n > 1 { tapSettled("hisyNext") }
            let end = Date().addingTimeInterval(5)
            while Date() < end && dots.label != "Card \(n) of 4" { Thread.sleep(forTimeInterval: 0.1) }
            XCTAssertEqual(dots.label, "Card \(n) of 4", "S\(n)")
            if n == 2 {
                // S2 (269:228): N1 tiles, then the N3 rows with likes and dashed "no"s
                let colorful = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'hisyTag' AND label == 'Not for you: Colorful'")).firstMatch
                XCTAssertTrue(colorful.exists, "S2: N3 'no' as a dashed tag")
                XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'hisyEvidence' AND label CONTAINS 'From your answers'")).firstMatch.exists, "S2: N3 rows' chip")
            }
            Thread.sleep(forTimeInterval: 0.4)
            capture("HISY-S\(n)")
        }
        tapSettled("hisyNext")
        XCTAssertTrue(element("hisyFace").waitForExistence(timeout: 5), "S4 → HISY-7")
    }

    private func launchToI01(_ app: XCUIApplication) {
        app.launchArguments = ["--uitesting", "--stub-signin", "--fixture-image", "--stub-external-apps"]
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
        // One tap copies the prompt, shows "Prompt copied" and opens ChatGPT. Under `--stub-external-apps` nothing
        // opens (the Safari hand-off was flaky on loaded CI runners) and the toast stays until the app leaves; the
        // test leaves (Home) and comes back itself, which takes the real scene-phase return to I02.
        let toast = element("promptCopiedToast")
        XCTAssertTrue(toast.waitForExistence(timeout: 15), "Prompt copied")
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "onb-I01-prompt-copied"; shot.lifetime = .keepAlways; add(shot)
        XCUIDevice.shared.press(.home)
        expectation(for: NSPredicate(format: "state != %d", XCUIApplication.State.runningForeground.rawValue), evaluatedWith: app)
        waitForExpectations(timeout: 30)   // left Genita (background or suspended)
        app.activate()
        XCTAssertTrue(app.buttons["pasteReply"].waitForExistence(timeout: 30), "back from the AI app → I02 with the paste button")
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
        // N3 → S0 (D47 v2 replaced I04-S) → Skip → HISY-7 → V01
        XCTAssertTrue(element("hisyOpener").waitForExistence(timeout: 15), "S0")
        expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: app.buttons["hisyShowMe"]); waitForExpectations(timeout: 20)
        app.buttons["hisyShowMe"].tap()
        Thread.sleep(forTimeInterval: 0.5)
        app.buttons.matching(identifier: "hisySkip").firstMatch.tap()
        Thread.sleep(forTimeInterval: 0.5)
        app.buttons.matching(identifier: "hisyChoosePhoto").firstMatch.tap()
        XCTAssertTrue(app.buttons["uploadImage"].waitForExistence(timeout: 5))
        if app.buttons["rightsAck"].exists { app.buttons["rightsAck"].tap() }   // V01 rights line (#197)
        primary.tap()
        XCTAssertTrue(element("V02-T").waitForExistence(timeout: 15)); primary.tap()
        XCTAssertTrue(app.buttons["play1"].waitForExistence(timeout: 10)); app.buttons["play1"].tap()
        expectation(for: NSPredicate(format: "label BEGINSWITH 'Leah, Selected'"), evaluatedWith: app.buttons["voice1"]); waitForExpectations(timeout: 15)
        // Continue waits for the clip (V04-P): tap it once it is on, not while the preview still plays
        expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: primary); waitForExpectations(timeout: 15)
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
        // I03 → HISY-0 → Skip → HISY-7 → V01 (D47 v2 replaced I04)
        XCTAssertTrue(element("hisyOpener").waitForExistence(timeout: 15))
        app.buttons["hisyShowMe"].tap()
        Thread.sleep(forTimeInterval: 0.5)
        app.buttons.matching(identifier: "hisySkip").firstMatch.tap()
        Thread.sleep(forTimeInterval: 0.5)
        app.buttons.matching(identifier: "hisyChoosePhoto").firstMatch.tap()
        XCTAssertTrue(app.buttons["uploadImage"].waitForExistence(timeout: 5))
        app.buttons["rightsAck"].tap() // SUB-8: "Use this image" stays off until the rights line is on
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
