import XCTest

/// F2–F4 on the server (L2): a signed-in account with no companion walks the whole onboarding against
/// ios-app/Tools/onboarding-stub (127.0.0.1:8790, PREP_API.md shapes) and lands in the call on the replay
/// server (8788). Screenshots `onb-*` go to the workflow artifact for the eye check against Figma.
final class OnboardingUITests: XCTestCase {
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
        primary.tap()
        XCTAssertTrue(element("V03").waitForExistence(timeout: 3), "V03 while the check runs")
        capture("V03")
        XCTAssertTrue(element("V02-T").waitForExistence(timeout: 15), "V02-T passed")
        XCTAssertTrue(element("typeChips").exists && element("rightsLine").exists)
        capture("V02-T")
        primary.tap()

        // V04 device voices
        XCTAssertTrue(app.buttons["voice0"].waitForExistence(timeout: 5))
        app.buttons["voice0"].tap()
        capture("V04")
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
        capture("NM01-0")
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

        // PREP-1: stages follow the server, Continue once the scene exists, then S07 "Connecting to Max…"
        XCTAssertTrue(element("PREP-1").waitForExistence(timeout: 10))
        capture("PREP1-start")
        // Continue lights up once the server says the scene is done (stub: 3 s after PREP-1's first poll)
        expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: app.buttons["prepContinue"])
        waitForExpectations(timeout: 15)
        capture("PREP1-scene-done")
        app.buttons["prepContinue"].tap()
        let pill = element("connectingPill")
        if pill.waitForExistence(timeout: 5) { capture("S07") }
        XCTAssertTrue(app.buttons["micToggle"].waitForExistence(timeout: 20), "S09 after S07")
        capture("S09-first-call")
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
}
