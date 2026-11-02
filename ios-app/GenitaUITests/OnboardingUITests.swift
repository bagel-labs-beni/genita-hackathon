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
        func waitLabel(_ e: XCUIElement, _ label: String, timeout: TimeInterval = 5) -> Bool {
            let end = Date().addingTimeInterval(timeout)
            while Date() < end { if e.exists, e.label == label { return true }; Thread.sleep(forTimeInterval: 0.1) }
            return false
        }

        // F1-L7: /me says signed in, consented, named, no companion → I01
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 15), "StartRouter → I01")
        XCTAssertTrue(app.buttons["openChatGPT"].exists && app.buttons["openClaude"].exists)
        XCTAssertTrue(app.buttons["skipImport"].exists)
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
        // I04 → D47 "How I see you": the seven story cards came with the import
        let dots = element("storyDots")
        XCTAssertTrue(dots.waitForExistence(timeout: 15), "story cards after the import")
        XCTAssertEqual(dots.label, "Card 1 of 7")
        let opener = element("storyCard-opener")
        XCTAssertTrue(opener.exists)
        XCTAssertTrue(primary.isEnabled, "Continue setup is always there")
        capture("I04-story-1-opener")
        opener.tap()   // tap = next card
        XCTAssertTrue(waitLabel(dots, "Card 2 of 7"), "tap advances")
        element("storyCard-think").swipeUp()   // vertical swipe = next card
        XCTAssertTrue(waitLabel(dots, "Card 3 of 7"), "swipe up advances")
        element("storyCard-talk").swipeLeft()   // horizontal paging
        XCTAssertTrue(waitLabel(dots, "Card 4 of 7"), "swipe left pages")
        let taste = element("storyCard-taste")
        XCTAssertTrue(taste.descendants(matching: .any)["storyTags"].exists, "taste tags")
        Thread.sleep(forTimeInterval: 0.6)
        capture("I04-story-4-taste")

        // That's not me → pick + text → the card is rewritten, "Got it. I'll remember that."
        taste.buttons["storyNotMe"].tap()
        let send = app.buttons["storyCorrectionSend"]
        XCTAssertTrue(send.waitForExistence(timeout: 5), "correction sheet")
        XCTAssertFalse(send.isEnabled, "nothing picked or written yet")
        app.buttons["I don't like one of these"].tap()
        let said = element("storyCorrectionText")
        said.tap()
        said.typeText("No cilantro, ever")
        capture("I04-story-not-me-sheet")
        XCTAssertTrue(send.isEnabled)
        send.tap()
        XCTAssertTrue(send.waitForNonExistence(timeout: 15), "the sheet closes once it's saved")
        let ack = taste.descendants(matching: .any).matching(identifier: "storyAck").firstMatch
        XCTAssertTrue(ack.waitForExistence(timeout: 5), "ack line on the card")
        XCTAssertTrue(ack.label.contains("I'll remember that"))
        XCTAssertTrue(taste.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'cilantro'")).firstMatch.exists, "the card shows the correction")
        Thread.sleep(forTimeInterval: 0.6)
        capture("I04-story-corrected")
        element("storyCard-taste").swipeLeft()
        XCTAssertTrue(waitLabel(dots, "Card 5 of 7"))
        Thread.sleep(forTimeInterval: 0.5)
        capture("I04-story-5-help")
        element("storyCard-help").swipeLeft(); _ = waitLabel(dots, "Card 6 of 7")
        element("storyCard-lines").swipeLeft()
        XCTAssertTrue(waitLabel(dots, "Card 7 of 7"))
        XCTAssertTrue(element("storyCard-unknowns").descendants(matching: .any)["storyUnknowns"].exists)
        Thread.sleep(forTimeInterval: 0.5)
        capture("I04-story-7-unknowns")
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
}
