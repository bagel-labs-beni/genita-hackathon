import XCTest
final class GenitaUITests: XCTestCase {
    func testLongPromptImport() {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        app.launchEnvironment = ["GENITA_REVIEW_STAGE": "prompt", "GENITA_REVIEW_VARIANT": "empty"]
        app.launch()
        let reader = app.textViews["promptReader"]
        XCTAssertTrue(reader.waitForExistence(timeout: 5))
        let fullPrompt = reader.value as! String
        XCTAssertTrue(fullPrompt.hasPrefix("Create an evidence-based personalization profile"))
        XCTAssertTrue(fullPrompt.hasSuffix("memory summaries, and suggested behaviors."))
        let cta = app.buttons["primaryCTA"]
        XCTAssertLessThan(reader.frame.maxY, cta.frame.minY)
        let ctaTop = cta.frame.minY
        func capture(_ name: String) {
            Thread.sleep(forTimeInterval: 0.5)
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.name = name; shot.lifetime = .keepAlways; add(shot)
        }
        capture("prompt-v2-top")
        for _ in 0..<20 { reader.swipeUp() }
        XCTAssertTrue(cta.isHittable, "Only the prompt body should scroll; the CTA must stay visible")
        XCTAssertEqual(cta.frame.minY, ctaTop, accuracy: 1)
        capture("prompt-v2-bottom")
        reader.tap()
        XCTAssertFalse(app.keyboards.firstMatch.exists, "The prompt is a read-only reader")
        app.buttons["copyPrompt"].tap()
        XCTAssertTrue(app.buttons["Prompt copied"].exists)
        cta.tap()
        let editor = app.textViews["responseInput"]
        editor.tap(); editor.press(forDuration: 1.2)
        let paste = app.menuItems["Paste"].exists ? app.menuItems["Paste"] : app.buttons["Paste"]
        XCTAssertTrue(paste.waitForExistence(timeout: 5)); paste.tap()
        XCTAssertEqual(editor.value as? String, fullPrompt, "Copy must include the entire prompt even after scrolling")
        editor.typeText(" QA_EDIT")
        let edited = editor.value as! String
        XCTAssertTrue(edited.contains("QA_EDIT"))
        app.buttons["Dismiss keyboard"].tap()
        cta.tap()
        let result = app.textViews["profileResult"]
        XCTAssertTrue(result.waitForExistence(timeout: 8))
        XCTAssertEqual(result.value as? String, edited)
        capture("prompt-v2-imported-result")
        app.terminate()
        app.launchArguments = []; app.launchEnvironment = [:]; app.launch()
        XCTAssertTrue(result.waitForExistence(timeout: 5))
        XCTAssertEqual(result.value as? String, edited, "Edited import must survive a relaunch")
        app.terminate()
    }
    func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<4 { if element.isHittable { return }; app.scrollViews.firstMatch.swipeUp() }
    }
    func testReviewCorrections() {
        let app = XCUIApplication()
        func open(_ stage: String) {
            app.launchArguments = ["--uitesting"]
            // Not the deployed server: with no session token it closes 4401 and the app routes to A02 sign-in (#155),
            // so the conversation stage would never show its rail. A closed local port just keeps reconnecting.
            app.launchEnvironment = ["GENITA_REVIEW_STAGE": stage, "GENITA_SERVER_URL": "ws://127.0.0.1:9/v1/session"]
            app.launch()
        }
        func capture(_ name: String) {
            Thread.sleep(forTimeInterval: 0.8)
            let a = XCTAttachment(screenshot: app.screenshot()); a.name = "ios-fix-" + name; a.lifetime = .keepAlways; add(a)
        }
        open("paste")
        let editor = app.textViews["responseInput"]; editor.tap(); editor.typeText(" ")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.toolbars.buttons["Done"].exists)
        XCTAssertFalse(app.buttons["primaryCTA"].exists)
        XCTAssertLessThanOrEqual(editor.frame.maxY, app.keyboards.firstMatch.frame.minY)
        capture("07a-답변-편집키보드")
        // Tap the blank right margin, outside both the editor and the title.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.33)).tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.buttons["primaryCTA"].waitForExistence(timeout: 5))
        app.buttons["primaryCTA"].tap()
        // I03 → HISY-0 (D47 v2 replaced I04's "Your style is ready.")
        XCTAssertTrue(app.descendants(matching: .any)["hisyOpener"].waitForExistence(timeout: 8))
        app.terminate()
        // V04 reads the server's voices; with no server in this test the curated four show greyed and the default stays picked
        // (the server states V04 / V04-P / V04-S / V04-waking are covered in OnboardingUITests against the stub)
        open("voice"); XCTAssertTrue(app.buttons["voice0"].waitForExistence(timeout: 10)); capture("13-목소리-선택완료"); app.terminate()
        open("connecting"); capture("30-연결중"); app.terminate()
        open("conversation"); capture("31-영상대화")
        XCTAssertFalse(app.buttons["Share screen"].exists)
        XCTAssertTrue(app.buttons["cameraToggle"].waitForExistence(timeout: 15), "camera toggle on the call rail")
        XCTAssertTrue(app.buttons["cameraToggle"].isEnabled)
        XCTAssertTrue(app.buttons["micToggle"].isEnabled)
        app.buttons["more"].tap(); XCTAssertTrue(app.descendants(matching: .any)["moreSheet"].waitForExistence(timeout: 5)); capture("31a-더보기")
        app.descendants(matching: .any)["closeMore"].tap()
        app.buttons["openMenu"].tap(); capture("32-대화메뉴")
        app.buttons["settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5)); capture("33-설정-상단")
        app.swipeUp(); capture("34-설정-하단"); app.terminate()
        // QA build 5: A03's way out to another account, N3 on the title's left edge (exported as preview-*)
        func shot(_ name: String) {
            Thread.sleep(forTimeInterval: 0.8)
            let a = XCTAttachment(screenshot: app.screenshot()); a.name = "preview-" + name; a.lifetime = .keepAlways; add(a)
        }
        open("name")
        XCTAssertTrue(app.buttons["nameSignOut"].waitForExistence(timeout: 10), "A03: Not you? Sign out")
        shot("qa5-a03-sign-out"); app.terminate()
        open("skipAvoid")
        let title = app.descendants(matching: .any)["skipAvoid"]
        let chip = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'skipChip-'")).firstMatch
        XCTAssertTrue(chip.waitForExistence(timeout: 10))
        if title.exists { XCTAssertEqual(chip.frame.minX, title.frame.minX, accuracy: 1.5, "N3 chips start at the title's left edge") }
        shot("qa5-n3-taste"); app.terminate()
        // I03 orb in motion (Chelsea 11/4): six shots ~0.5 s apart, exported as preview-*
        open("preparing")
        XCTAssertTrue(app.descendants(matching: .any)["primaryCTA"].waitForExistence(timeout: 10))
        let start = Date()
        for i in 0..<6 {
            let due = start.addingTimeInterval(0.5 * Double(i))
            if due > Date() { Thread.sleep(until: due) }
            let a = XCTAttachment(screenshot: app.screenshot())
            a.name = String(format: "preview-i03-orb-%d-%04dms", i, Int(Date().timeIntervalSince(start) * 1000)); a.lifetime = .keepAlways; add(a)
        }
        app.terminate()
    }
    func testCaptureReviewTransientScreens() {
        let app = XCUIApplication()
        func open(_ stage: String, _ variant: String = "") {
            app.launchArguments = ["--uitesting"]
            app.launchEnvironment = ["GENITA_REVIEW_STAGE":stage, "GENITA_REVIEW_VARIANT":variant]
            app.launch()
        }
        func capture(_ name: String) {
            Thread.sleep(forTimeInterval: 1)
            let a = XCTAttachment(screenshot: app.screenshot()); a.name = "ios-review-" + name; a.lifetime = .keepAlways; add(a)
        }
        open("signIn")
        app.buttons["Continue with Apple"].tap()
        XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: 5)); capture("02a-로그인-데모안내"); app.terminate()
        open("name", "empty")
        app.textFields["nameInput"].tap(); app.textFields["nameInput"].typeText(" "); app.textFields["nameInput"].typeText(XCUIKeyboardKey.delete.rawValue)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5)); capture("03-이름-입력전")
        app.textFields["nameInput"].typeText("Dyno"); capture("04-이름-입력완료"); app.terminate()
        open("paste")
        app.textViews["responseInput"].tap(); app.textViews["responseInput"].typeText(" ")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5)); capture("07a-답변-편집키보드"); app.terminate()
        open("image", "empty"); app.buttons["uploadImage"].tap()
        XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 5)); Thread.sleep(forTimeInterval: 3)
        capture("10a-시스템사진선택창"); app.buttons["Cancel"].tap(); app.terminate()
    }
    func testCaptureAllScreensForFigmaReview() {
        let app = XCUIApplication()
        let cases: [(String, String, String)] = [
            ("01-시작", "welcome", ""), ("02-로그인", "signIn", ""),
            ("03-이름-입력전", "name", "empty"), ("04-이름-입력완료", "name", ""),
            ("05-프롬프트", "prompt", ""), ("06-답변-입력전", "paste", "empty"),
            ("07-답변-입력완료", "paste", ""), ("08-AI스타일-처리중", "preparing", ""),
            ("09-AI스타일-결과", "preferences", ""), ("10-이미지-업로드전", "image", "empty"),
            ("11-이미지-선택완료", "image", "image"), ("11b-V03-스캔-0", "imageCheck", "scan-0"),
            ("11c-V03-스캔-55", "imageCheck", "scan-55"), ("11d-V03-스캔-100", "imageCheck", "scan-100"), ("12-목소리-선택전", "voice", "empty"),
            ("13-목소리-선택완료", "voice", ""), ("14-설정깊이-기본", "depth", "right"),
            ("15-설정깊이-빠른", "depth", "quick"), ("16-설정깊이-깊은", "depth", "deep"),
            ("17-도움-선택전", "help", "empty"), ("18-도움-선택완료", "help", ""),
            ("19-관계-선택전", "relationship", "empty"), ("20-관계-선택완료", "relationship", ""),
            ("21-피드백강도", "challenge", ""), ("22-대화속도", "tempo", ""),
            ("23-먼저말걸기", "initiative", "deep"), ("24-행동경계", "boundaries", "deep"),
            ("25-성격키워드-선택전", "presence", "empty"), ("26-성격키워드-선택완료", "presence", ""),
            ("27-요약-빠른", "summary", "quick"), ("28-요약-기본", "summary", "right"),
            ("29-요약-깊은", "summary", "deep"), ("30-연결중", "connecting", ""),
            ("31-영상대화", "conversation", "")
        ]
        func capture(_ name: String) {
            let attachment = XCTAttachment(screenshot: app.screenshot())
            attachment.name = "ios-review-" + name; attachment.lifetime = .keepAlways; add(attachment)
        }
        for (name, stage, variant) in cases {
            app.launchArguments = ["--uitesting"]
            app.launchEnvironment = ["GENITA_REVIEW_STAGE": stage, "GENITA_REVIEW_VARIANT": variant]
            app.launch()
            Thread.sleep(forTimeInterval: 0.5)
            XCTAssertTrue(app.wait(for: .runningForeground, timeout: 5))
            capture(name)
            if stage == "signIn" {
                app.buttons["Continue with Apple"].tap(); capture("02a-로그인-데모안내")
                app.alerts.buttons["Cancel"].tap()
                app.buttons["Terms"].tap(); capture("02b-이용약관-미연결안내"); app.alerts.buttons["OK"].tap()
                app.buttons["Privacy Policy"].tap(); capture("02c-개인정보-미연결안내"); app.alerts.buttons["OK"].tap()
            }
            if stage == "prompt" { app.buttons["copyPrompt"].tap(); capture("05a-프롬프트-복사완료") }
            if stage == "paste" && variant != "empty" {
                app.textViews["responseInput"].tap(); capture("07a-답변-편집키보드")
            }
            if stage == "image" && variant == "empty" {
                app.buttons["uploadImage"].tap()
                XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 5)); capture("10a-시스템사진선택창")
                app.buttons["Cancel"].tap()
            }
            if stage == "voice" && variant != "empty" {
                XCTAssertTrue(app.buttons["voice0"].waitForExistence(timeout: 10)); capture("13a-목소리-미리듣기")
            }
            if stage == "conversation" {
                app.buttons["openMenu"].tap(); capture("32-대화메뉴")
                app.buttons["settings"].tap()
                XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5)); capture("33-설정-상단")
                app.swipeUp(); capture("34-설정-하단")
            }
            app.terminate()
        }
    }
    func testOnboardingAndConversation() {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", "--fixture-image"]
        app.launch()
        app.buttons["getStarted"].tap()
        let loginTitle = app.staticTexts["Make this\none yours."]
        XCTAssertTrue(loginTitle.waitForExistence(timeout: 3))
        XCTAssertGreaterThanOrEqual(loginTitle.frame.minX, 25)
        XCTAssertLessThanOrEqual(app.buttons["Continue with Apple"].frame.maxX, app.frame.width - 25)
        let loginShot = XCTAttachment(screenshot: app.screenshot()); loginShot.name = "Sign in"; loginShot.lifetime = .keepAlways; add(loginShot)
        app.buttons["Continue with Apple"].tap()
        app.alerts.buttons["Continue in demo"].tap()
        XCTAssertFalse(app.buttons["primaryCTA"].isEnabled)
        app.textFields["nameInput"].tap(); app.textFields["nameInput"].typeText("Dyno")
        let nameShot = XCTAttachment(screenshot: app.screenshot()); nameShot.name = "Corrected name screen"; nameShot.lifetime = .keepAlways; add(nameShot)
        app.buttons["primaryCTA"].tap()
        app.buttons["copyPrompt"].tap()
        XCTAssertTrue(app.buttons["Prompt copied"].exists)
        app.buttons["primaryCTA"].tap()
        XCTAssertFalse(app.buttons["primaryCTA"].isEnabled)
        let editor = app.textViews["responseInput"]
        editor.tap(); editor.typeText("Communication style: warm and direct.\nInterests: design and cooking.")
        if app.keyboards.firstMatch.exists { app.buttons["Dismiss keyboard"].tap() }
        app.buttons["primaryCTA"].tap()
        // I03 → HISY-0 (no server: no cards) → HISY-7 → V01
        XCTAssertTrue(app.descendants(matching: .any)["hisyOpener"].waitForExistence(timeout: 8))
        app.buttons["hisyShowMe"].tap()
        XCTAssertTrue(app.buttons["hisyChoosePhoto"].waitForExistence(timeout: 5))
        app.buttons["hisyChoosePhoto"].tap()
        XCTAssertTrue(app.buttons["uploadImage"].waitForExistence(timeout: 5))
        app.buttons["uploadImage"].tap()
        XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 5))
        app.buttons["Cancel"].tap()
        XCTAssertTrue(app.buttons["Cancel"].waitForNonExistence(timeout: 5))
        XCTAssertFalse(app.buttons["primaryCTA"].isEnabled, "V01: off until the rights line is on (SUB-8)")
        app.buttons["rightsAck"].tap()
        XCTAssertTrue(app.buttons["primaryCTA"].isEnabled)
        app.buttons["primaryCTA"].tap()
        XCTAssertTrue(app.buttons["voice0"].waitForExistence(timeout: 10))
        expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: app.buttons["primaryCTA"]); waitForExpectations(timeout: 15)   // no server: the default voice is picked
        app.buttons["primaryCTA"].tap()
        app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Quick start")).firstMatch.tap()
        app.buttons["primaryCTA"].tap()
        app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Think with me")).firstMatch.tap(); app.buttons["primaryCTA"].tap()
        app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Trusted partner")).firstMatch.tap(); app.buttons["primaryCTA"].tap()
        app.buttons["Grounded"].tap(); app.buttons["primaryCTA"].tap()
        app.buttons["primaryCTA"].tap()
        XCTAssertTrue(app.buttons["openMenu"].waitForExistence(timeout: 5))
        // b17: camera off = no self-view tile (Chelsea 11/5); the rail's camera button says it is off
        XCTAssertFalse(app.otherElements["Your camera is off"].exists, "no grey camera-off tile")
        XCTAssertEqual(app.buttons["cameraToggle"].label, "Turn camera on")
        XCTAssertFalse(app.buttons["Share screen"].exists)
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "iPhone conversation"; shot.lifetime = .keepAlways; add(shot)
        app.buttons["openMenu"].tap(); app.buttons["settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 3))
        app.buttons["Done"].tap()
        app.terminate(); app.launchArguments = []; app.launch()
        XCTAssertTrue(app.buttons["openMenu"].waitForExistence(timeout: 5))
    }
    func testDeepSetupSlidersAndBoundaries() {
        let app = XCUIApplication(); app.launchArguments = ["--uitesting", "--fixture-personality"]; app.launch()
        reveal(app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Deep setup")).firstMatch, in: app); app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Deep setup")).firstMatch.tap()
        app.buttons["primaryCTA"].tap()
        app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Be there")).firstMatch.tap(); app.buttons["primaryCTA"].tap()
        app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Close companion")).firstMatch.tap(); app.buttons["primaryCTA"].tap()
        reveal(app.sliders.firstMatch, in: app); app.sliders.firstMatch.adjust(toNormalizedSliderPosition: 1); XCTAssertTrue(app.staticTexts["Be direct. Challenge my assumptions."].exists); app.buttons["primaryCTA"].tap()
        reveal(app.sliders.firstMatch, in: app); app.sliders.firstMatch.adjust(toNormalizedSliderPosition: 0); XCTAssertTrue(app.staticTexts["Take your time. Let’s think this through."].exists); app.buttons["primaryCTA"].tap()
        reveal(app.sliders.firstMatch, in: app); app.sliders.firstMatch.adjust(toNormalizedSliderPosition: 0); app.buttons["primaryCTA"].tap()
        app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Message anyone for me")).firstMatch.tap(); app.buttons["primaryCTA"].tap()
        app.buttons["Calm"].firstMatch.tap(); app.buttons["Witty"].tap(); app.buttons["primaryCTA"].tap()
        XCTAssertTrue(app.staticTexts["Message anyone for me"].exists)
        app.buttons["back"].tap()
        XCTAssertTrue(app.buttons["Witty"].exists)
    }
    func testBackAndCopyPreserveDraft() {
        // this test walks the demo sign-in through the Google button, which A02 hides by default (#218)
        let app = XCUIApplication(); app.launchArguments = ["--uitesting"]; app.launchEnvironment = ["GENITA_HIDE_GOOGLE": "0"]; app.launch()
        app.buttons["getStarted"].tap(); app.buttons["Continue with Google"].tap(); app.alerts.buttons["Cancel"].tap()
        XCTAssertTrue(app.buttons["Continue with Apple"].exists)
        app.buttons["Continue with Google"].tap(); app.alerts.buttons["Continue in demo"].tap()
        app.textFields["nameInput"].tap(); app.textFields["nameInput"].typeText("Alex"); app.buttons["primaryCTA"].tap(); app.buttons["primaryCTA"].tap()
        app.textViews["responseInput"].tap(); app.textViews["responseInput"].typeText("A local draft")
        if app.keyboards.firstMatch.exists { app.buttons["Dismiss keyboard"].tap() }
        app.buttons["back"].tap(); app.buttons["primaryCTA"].tap()
        XCTAssertEqual(app.textViews["responseInput"].value as? String, "A local draft")
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "AI reply input"; shot.lifetime = .keepAlways; add(shot)
    }

    /// A02-J (D41): Judge access link → the stock iOS alert with a code field; an unreachable server shows a
    /// second stock alert, "Try Again" brings the code alert back with the code kept, Cancel returns to A02.
    func testJudgeAccessSheet() {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        app.launchEnvironment = ["GENITA_REVIEW_STAGE": "signIn", "GENITA_REVIEW_VARIANT": "", "GENITA_REVIEW_STILL": "1"]
        app.launch()
        let link = app.buttons["judgeAccessLink"]
        XCTAssertTrue(link.waitForExistence(timeout: 5))
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = "auth-A02-judge-link"; a.lifetime = .keepAlways; add(a)
        link.tap()
        let alert = app.alerts["Judge access"]
        XCTAssertTrue(alert.waitForExistence(timeout: 5), "A02-J is a system alert")
        XCTAssertTrue(alert.staticTexts["Enter the code from the submission form. No Apple\u{00A0}ID\u{00A0}needed."].exists)
        let field = alert.textFields.element(boundBy: 0)
        XCTAssertTrue(field.exists)
        field.tap(); field.typeText("not-a-real-code")
        let a2 = XCTAttachment(screenshot: app.screenshot()); a2.name = "auth-A02-J-alert"; a2.lifetime = .keepAlways; add(a2)
        // DEBUG builds: second field points the app at a server; port 1 = nothing listening → offline
        let server = alert.textFields.element(boundBy: 1)
        XCTAssertTrue(server.exists, "debug server field")
        server.tap(); server.typeText("http://127.0.0.1:1")
        alert.buttons["Continue"].tap()
        // offline ("Can’t Reach the Server"), or "Judge Access Unavailable" if the simulator blocks plain http
        let tryAgain = app.alerts.buttons["Try Again"]
        XCTAssertTrue(tryAgain.waitForExistence(timeout: 10), "failure is a second system alert")
        XCTAssertFalse(app.alerts["Judge access"].exists)
        let b = XCTAttachment(screenshot: app.screenshot()); b.name = "auth-A02-J-error"; b.lifetime = .keepAlways; add(b)
        tryAgain.tap()
        XCTAssertTrue(alert.waitForExistence(timeout: 5), "Try Again reopens the code alert")
        XCTAssertEqual(alert.textFields.element(boundBy: 0).value as? String, "not-a-real-code", "the code is kept")
        alert.buttons["Cancel"].tap()
        XCTAssertTrue(link.waitForExistence(timeout: 5))
        XCTAssertFalse(app.alerts.firstMatch.exists)
    }

    /// #217 · A02 Terms / Privacy Policy open the live pages in an in-app Safari sheet (and close again).
    func testA02LegalLinksOpenSafari() {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        app.launchEnvironment = ["GENITA_REVIEW_STAGE": "signIn", "GENITA_REVIEW_STILL": "1"]
        app.launch()
        let terms = app.buttons["Terms"], privacy = app.buttons["Privacy Policy"]
        XCTAssertTrue(terms.waitForExistence(timeout: 10) && privacy.exists)
        // the two hit areas never overlap (a tap at the bottom of Terms must not open Privacy Policy)
        XCTAssertLessThanOrEqual(terms.frame.maxY, privacy.frame.minY, "Terms \(terms.frame) / Privacy \(privacy.frame)")
        for (label, id) in [("Terms", "legal-terms"), ("Privacy Policy", "legal-privacy")] {
            let link = app.buttons[label]
            XCTAssertTrue(link.waitForExistence(timeout: 10), label)
            XCTAssertGreaterThanOrEqual(link.frame.height, 28, "\(label) hit area")
            link.tap()
            let safari = app.descendants(matching: .any)["legalSafari"]
            let done = app.buttons["Done"]
            XCTAssertTrue(safari.waitForExistence(timeout: 10) || done.waitForExistence(timeout: 5), "\(label) opens the Safari sheet (\(id))")
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.name = "call-A02-legal-" + id
            shot.lifetime = .keepAlways
            add(shot)
            if done.exists { done.tap() } else { app.swipeDown() }
            XCTAssertTrue(app.buttons[label].waitForExistence(timeout: 10), "back on A02 after closing \(label)")
        }
    }

    /// #218 · A02 hides Google by default and keeps Apple, in the lower slot (no hole between buttons and the legal line).
    func testA02HidesGoogleByDefault() {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        app.launchEnvironment = ["GENITA_REVIEW_STAGE": "signIn", "GENITA_REVIEW_STILL": "1"]
        app.launch()
        let apple = app.buttons["Continue with Apple"]
        XCTAssertTrue(apple.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Continue with Google"].exists)
        let legal = app.buttons["Terms"]
        if legal.exists { XCTAssertLessThan(legal.frame.minY - apple.frame.maxY, 120, "no awkward gap between Apple and the legal line") }
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "call-A02-no-google"
        shot.lifetime = .keepAlways
        add(shot)
    }

    /// #218 · the flag turns Google back on (reversible).
    func testA02ShowsGoogleWhenFlagOff() {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        app.launchEnvironment = ["GENITA_REVIEW_STAGE": "signIn", "GENITA_REVIEW_STILL": "1", "GENITA_HIDE_GOOGLE": "0"]
        app.launch()
        XCTAssertTrue(app.buttons["Continue with Apple"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Continue with Google"].exists)
    }

    /// #235 · A02-E: the failure card sits under the subtitle, fully inside the screen, and does not cover the headline.
    func testA02ESignInFailedCardDoesNotCoverTheTitle() {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        app.launchEnvironment = ["GENITA_REVIEW_STAGE": "signIn", "GENITA_REVIEW_STILL": "1", "GENITA_REVIEW_SIGNIN_FAILED": "1"]
        app.launch()
        let toast = app.descendants(matching: .any)["signInFailed"].firstMatch
        XCTAssertTrue(toast.waitForExistence(timeout: 10))
        // one element that reads the whole message (VoiceOver, and the query is unambiguous)
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "signInFailed").count, 1)
        XCTAssertTrue(toast.label.contains("Couldn’t reach Apple. Check your connection and try again."), toast.label)
        // headline + subtitle end near canvas y 265 (design) -> the card must start below 250 pt on any phone
        XCTAssertGreaterThanOrEqual(toast.frame.minY, 250, "the card starts under 'Built from your stories, rhythm and boundaries.'")
        XCTAssertLessThanOrEqual(toast.frame.width, 342.5)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "call-A02E-toast"
        shot.lifetime = .keepAlways
        add(shot)
    }
}
