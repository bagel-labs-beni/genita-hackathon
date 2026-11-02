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
        XCTAssertTrue(app.staticTexts["Your style\nis ready."].waitForExistence(timeout: 5))
        app.terminate()
        open("voice"); app.buttons["voice1"].tap(); capture("13-목소리-선택완료")
        app.buttons["Preview voice 2"].tap(); capture("13a-목소리-미리듣기")
        app.buttons["Preview voice 2"].tap(); app.buttons["voice0"].tap(); capture("13b-목소리-첫번째선택"); app.terminate()
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
            ("11-이미지-선택완료", "image", "image"), ("12-목소리-선택전", "voice", "empty"),
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
                app.buttons["Preview voice 1"].tap(); capture("13a-목소리-미리듣기")
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
        XCTAssertTrue(app.staticTexts["Your style\nis ready."].waitForExistence(timeout: 5))
        app.buttons["primaryCTA"].tap()
        XCTAssertTrue(app.buttons["uploadImage"].exists)
        app.buttons["uploadImage"].tap()
        XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 5))
        app.buttons["Cancel"].tap()
        XCTAssertTrue(app.buttons["Cancel"].waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.buttons["primaryCTA"].isEnabled)
        app.buttons["primaryCTA"].tap()
        app.buttons["voice0"].tap(); app.buttons["primaryCTA"].tap()
        app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Quick start")).firstMatch.tap()
        app.buttons["primaryCTA"].tap()
        app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Think with me")).firstMatch.tap(); app.buttons["primaryCTA"].tap()
        app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Trusted partner")).firstMatch.tap(); app.buttons["primaryCTA"].tap()
        app.buttons["Grounded"].tap(); app.buttons["primaryCTA"].tap()
        app.buttons["primaryCTA"].tap()
        XCTAssertTrue(app.buttons["openMenu"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Your camera is off"].exists || app.otherElements["Your camera is off"].exists)
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
        let app = XCUIApplication(); app.launchArguments = ["--uitesting"]; app.launch()
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
}
