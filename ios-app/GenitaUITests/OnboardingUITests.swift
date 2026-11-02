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
        ]
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
        // Figma 142:2 shows Design, Food and Film & TV picked
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
        app.buttons["skipChip-Show me options"].tap()   // Figma 143:2
        capture("N2")
        app.buttons["primaryCTA"].tap()
        XCTAssertTrue(element("skipAvoid").waitForExistence(timeout: 5), "N3")
        // Figma 144:2: Minimal, Spicy, Noodles liked (one tap), Seafood avoided (two taps), a third tap clears
        for chip in ["Minimal", "Spicy", "Noodles", "Seafood", "Seafood", "Street", "Street", "Street"] { app.buttons["skipChip-" + chip].tap() }
        XCTAssertEqual(app.buttons["skipChip-Seafood"].value as? String, "Avoid")
        XCTAssertEqual(app.buttons["skipChip-Spicy"].value as? String, "Like")
        XCTAssertEqual(app.buttons["skipChip-Street"].value as? String ?? "", "", "three taps clear")
        capture("N3")
        app.buttons["primaryCTA"].tap()
        XCTAssertTrue(element("profileResult").waitForExistence(timeout: 15), "I04-S after N3")
        capture("I04-S")
    }
}
