import XCTest

/// F10-U-SHEET · The result sheet in each r03 board state (design-r02/revisions/r03/board.html, frames 1–19,
/// plus 20 = IC-4 "can't see it"), from events recorded on a real genita-server run (Resources/finds-fixture.json).
/// A replay server only provides the live session (ios-app/Tools/call-replay on 127.0.0.1:8789).
final class FindsSheetUITests: XCTestCase {
    private let names = [
        1: "searching", 2: "rising", 3: "half", 4: "chip-box", 5: "missing", 6: "full-steps", 7: "ask", 8: "source",
        9: "peek", 10: "user-talks", 11: "new-find", 12: "next-card", 13: "link", 14: "link-failed", 15: "picture-failed",
        16: "offline", 17: "closed-undo", 18: "voiceover", 19: "how", 20: "IC4-unclear",
        21: "pf1-searching", 22: "pf1-products", 23: "pf1-saved", 24: "pf1-failed", 25: "fridge-pill", 41: "reasons", 42: "budget",
    ]

    private func launch(_ state: Int) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        app.launchEnvironment = [
            "GENITA_REVIEW_STAGE": "conversation",
            "GENITA_SERVER_URL": "ws://127.0.0.1:8789/v1/session",
            "GENITA_FINDS_STATE": String(state),
        ]
        app.launch()
        return app
    }

    private func capture(_ app: XCUIApplication, _ state: Int) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = String(format: "call-finds-%02d-%@", state, names[state] ?? "")
        shot.lifetime = .keepAlways
        add(shot)
    }

    private func sheet(_ app: XCUIApplication) -> XCUIElement { app.descendants(matching: .any)["findsSheet"] }

    func testEveryBoardState() throws {
        for state in 1...25 {
            let app = launch(state)
            let expectSheet = state != 17 && state != 20
            if state == 20 {
                XCTAssertTrue(app.descendants(matching: .any)["findUnclear"].waitForExistence(timeout: 15), "IC-4 card")
            } else if expectSheet {
                XCTAssertTrue(sheet(app).waitForExistence(timeout: 15), "state \(state): sheet")
            } else {
                XCTAssertTrue(app.descendants(matching: .any)["findToast"].waitForExistence(timeout: 15), "17: In Finds · Undo")
            }
            Thread.sleep(forTimeInterval: state == 8 ? 3 : 1.2) // drawer 420 ms + pictures; the browser loads a page
            switch state {
            case 1: XCTAssertTrue(app.buttons["findStop"].exists, "searching has Stop")
            case 3, 4, 5, 6: XCTAssertTrue(app.descendants(matching: .any)["findCamera"].exists, "camera frame with boxes")
            case 9, 10: XCTAssertTrue(app.buttons["findPeek"].exists, "peek row")
            case 11: XCTAssertTrue(app.buttons["findNew"].exists, "new find banner")
            case 14: XCTAssertTrue(app.descendants(matching: .any)["linkFailed"].exists, "couldn't open")
            case 8: XCTAssertTrue(app.buttons["Done"].firstMatch.exists, "F10-8 Done")
                XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Open in Safari")).firstMatch.exists, "F10-8 Open in Safari")
            case 20:
                XCTAssertTrue(app.buttons["findLookAgain"].exists, "IC-4 Look again")
                XCTAssertFalse(sheet(app).exists && sheet(app).isHittable, "IC-4 has no sheet")
            case 21:
                XCTAssertTrue(app.buttons["findStop"].exists, "PF-1a Stop")
                assertPill(app, "On it…")
                assertOneLine(app, "PF-1a searching at 390")
            case 25:
                assertPill(app, "Egg, tofu, green onion +1")
                XCTAssertFalse(app.descendants(matching: .any)["callCue"].label.contains("I can see"), "the sentence is spoken, not shown")
            case 22:
                assertDarkBand(app, "PF-1b full sheet")
                assertWhiteStatusBar(app, "PF-1b full sheet")
                assertPill(app, "Found two for you.")
                assertHowClearsCTA(app, "findCTA")
                XCTAssertTrue(app.descendants(matching: .any)["productView"].exists, "PF-1b product view")
                XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'productLink-'")).count, 2, "two View buttons")
                XCTAssertTrue(app.buttons["findCTA"].exists, "Save to Finds")
            case 23:
                XCTAssertTrue(app.buttons["openFinds"].exists, "PF-1c Open Finds")
                assertPill(app, "Saved. They’re in Finds.")
                assertHowClearsCTA(app, "openFinds")
                XCTAssertFalse(app.buttons["findCTA"].exists)
            case 24:
                XCTAssertTrue(app.buttons["findRetry"].exists, "PF-1d Retry")
                assertPill(app, "Nothing I’d pick for you.")
                assertOneLine(app, "PF-1d failed at 390")
            case 16: XCTAssertTrue(app.descendants(matching: .any)["findOffline"].exists, "offline note")
            case 18:
                // VoiceOver order: the sheet's accessible elements top to bottom
                let order = sheet(app).descendants(matching: .any).allElementsBoundByIndex.prefix(40)
                    .filter { !$0.label.isEmpty && $0.isHittable }.map { "\($0.elementType.rawValue) \($0.label)" }
                let text = XCTAttachment(string: order.joined(separator: "\n"))
                text.name = "call-finds-18-voiceover-order"
                text.lifetime = .keepAlways
                add(text)
            default: break
            }
            capture(app, state)
            app.terminate()
        }
    }

    private func waitValue(_ el: XCUIElement, _ value: String, _ seconds: TimeInterval = 6) -> Bool {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end { if el.value as? String == value { return true }; Thread.sleep(forTimeInterval: 0.2) }
        return el.value as? String == value
    }

    /// b17 Appetize QA A (P1): full, scrolled down (state 7 = "ask", like after Walk me through → Steps), then the grab
    /// pulls it to half: the half card starts at its header (bookmark and close on screen, under the sheet's top edge).
    func testFullScrolledThenHalfStartsAtTheHeader() throws {
        for run in 1...3 {
            let app = launch(7)
            let s = sheet(app)
            XCTAssertTrue(s.waitForExistence(timeout: 15))
            XCTAssertTrue(waitValue(s, "full", 10), "run \(run): state 7 is full")
            Thread.sleep(forTimeInterval: 1.2)   // the scroll to "ask"
            let grab = s.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0)).withOffset(CGVector(dx: 0, dy: 20))
            grab.press(forDuration: 0.1, thenDragTo: grab.withOffset(CGVector(dx: 0, dy: 280)))
            XCTAssertTrue(waitValue(s, "half"), "run \(run): the grab pulls full down to half")
            Thread.sleep(forTimeInterval: 0.8)
            let top = app.windows.firstMatch.frame.height - 468   // the half sheet's top edge (SheetState.half)
            for id in ["findCloseCard", "findSave"] {
                let b = app.buttons[id]
                XCTAssertTrue(b.exists && b.isHittable, "run \(run): \(id) is on screen at half (the card is at its header)")
                XCTAssertGreaterThan(b.frame.minY, top, "run \(run): \(id) sits under the sheet's top edge")
            }
            let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "call-finds-b17-full-scrolled-to-half-\(run)"; shot.lifetime = .keepAlways; add(shot)
            app.terminate()
        }
    }

    /// b17 Appetize QA C (P2): at full with the card at its top, a downward drag on the card body (not the grab) resizes
    /// the sheet to half; scrolled down, the same drag scrolls the card instead.
    func testFullBodyDragDownAtTopGoesToHalf() throws {
        let app = launch(22)   // PF-1b two products at full, card at its top
        let s = sheet(app)
        XCTAssertTrue(s.waitForExistence(timeout: 15))
        XCTAssertTrue(waitValue(s, "full", 10))
        Thread.sleep(forTimeInterval: 1.2)
        let body = s.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0)).withOffset(CGVector(dx: 0, dy: 240))
        body.press(forDuration: 0.05, thenDragTo: body.withOffset(CGVector(dx: 0, dy: 260)))
        XCTAssertTrue(waitValue(s, "half"), "a body drag down at the card's top takes full to half")
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "call-finds-b17-full-body-drag-half"; shot.lifetime = .keepAlways; add(shot)
    }

    /// D48 ③: 1–2 reason chips from the user's own taste lines under the card title.
    func testReasonChipsUnderTheTitle() throws {
        let app = launch(41)
        XCTAssertTrue(sheet(app).waitForExistence(timeout: 15))
        let chips = app.descendants(matching: .any)["findReasons"]
        XCTAssertTrue(chips.waitForExistence(timeout: 5), "reason chips on the recipe card")
        XCTAssertEqual(chips.label, "Why this: Your taste: quick weeknight food, You said: no cilantro")
        Thread.sleep(forTimeInterval: 1.2)
        capture(app, 41)
    }

    /// Knows-Me Map: "Your budget: under $100" (from the profile, blue) beside the style chip, two priced picks.
    func testBudgetReasonChip() throws {
        let app = launch(42)
        XCTAssertTrue(sheet(app).waitForExistence(timeout: 15))
        let chips = app.descendants(matching: .any)["findReasons"]
        XCTAssertTrue(chips.waitForExistence(timeout: 5), "reason chips on the card")
        XCTAssertEqual(chips.label, "Why this: Your style: clean, minimal clothes, Your budget: under $100")
        Thread.sleep(forTimeInterval: 1.2)
        capture(app, 42)
    }

    /// Chelsea 11/3: the searching / failed lines stay on one line next to Stop at the largest default text size
    /// (the sheet's type is fixed-size, so XXXL must look exactly like the default).
    func testStatusLinesAtLargestTextSize() throws {
        for state in [21, 24, 25] {
            let app = XCUIApplication()
            app.launchArguments = ["--uitesting", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryXXXL"]
            app.launchEnvironment = ["GENITA_REVIEW_STAGE": "conversation", "GENITA_SERVER_URL": "ws://127.0.0.1:8789/v1/session", "GENITA_FINDS_STATE": String(state)]
            app.launch()
            XCTAssertTrue(sheet(app).waitForExistence(timeout: 15))
            Thread.sleep(forTimeInterval: 1.2)
            if state == 25 { assertPill(app, "Egg, tofu, green onion +1") } else { assertOneLine(app, "state \(state) at XXXL") }
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.name = String(format: "call-finds-%02d-%@-xxxl", state, names[state] ?? "")
            shot.lifetime = .keepAlways
            add(shot)
            app.terminate()
        }
    }

    /// #214: the PF-1 status pill is on screen with the Figma line, on one line.
    private func assertPill(_ app: XCUIApplication, _ text: String) {
        let pill = app.descendants(matching: .any)["callCue"]
        XCTAssertTrue(pill.waitForExistence(timeout: 5), "pill shows \(text)")
        XCTAssertTrue(pill.label.contains(text), "pill says \(text), got \(pill.label)")
        XCTAssertLessThan(pill.frame.height, 44, "pill is one line (\(pill.frame))")
        XCTAssertLessThanOrEqual(pill.frame.maxX, app.frame.width, "pill stays on screen (\(pill.frame))")
    }

    /// Figma PF-1b: over the dark band the clock and icons are white (light status bar).
    private func assertWhiteStatusBar(_ app: XCUIApplication, _ what: String) {
        let image = app.screenshot().image
        guard let cg = image.cgImage else { return XCTFail("\(what): no screenshot") }
        let s = image.scale
        // the clock at top-left: brightest pixel in x 24…100, y 10…36 pt
        let rect = CGRect(x: 24 * s, y: 10 * s, width: 76 * s, height: 26 * s).integral
        guard let crop = cg.cropping(to: rect) else { return XCTFail("\(what): crop") }
        let w = crop.width, h = crop.height
        var px = [UInt8](repeating: 0, count: w * h * 4)
        let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(crop, in: CGRect(x: 0, y: 0, width: w, height: h))
        var brightest = 0.0
        for i in stride(from: 0, to: px.count, by: 4) {
            brightest = max(brightest, (0.2126 * Double(px[i]) + 0.7152 * Double(px[i + 1]) + 0.0722 * Double(px[i + 2])) / 255)
        }
        XCTAssertGreaterThan(brightest, 0.8, "\(what): status bar text is white over the dark band (brightest \(brightest))")
    }

    /// #214: "How I found this" ends above the bottom button at rest (no line under the CTA).
    private func assertHowClearsCTA(_ app: XCUIApplication, _ cta: String) {
        let how = app.descendants(matching: .any)["findHow"]
        let button = app.buttons[cta]
        XCTAssertTrue(how.exists && button.exists, "how + \(cta)")
        XCTAssertLessThanOrEqual(how.frame.maxY, button.frame.minY, "How I found this \(how.frame) clears \(cta) \(button.frame)")
    }

    /// One text line of Pretendard 16 is ~22 pt tall; two lines would be ~44.
    private func assertOneLine(_ app: XCUIApplication, _ what: String) {
        let title = app.descendants(matching: .any)["findSearchTitle"]
        XCTAssertTrue(title.waitForExistence(timeout: 5), "\(what): title")
        XCTAssertLessThan(title.frame.height, 30, "\(what): title is one line (\(title.frame))")
        let detail = app.descendants(matching: .any)["findSearchDetail"]
        if detail.exists { XCTAssertLessThan(detail.frame.height, 26, "\(what): detail is one line (\(detail.frame))") }
        let stop = app.buttons["findStop"].exists ? app.buttons["findStop"] : app.buttons["findRetry"]
        XCTAssertLessThanOrEqual(title.frame.maxX, stop.frame.minX + 1, "\(what): title ends before Stop/Retry")
    }

    /// r03 / PF-1b: the band above a full sheet is ink (#111), not white.
    private func assertDarkBand(_ app: XCUIApplication, _ what: String) {
        let image = app.screenshot().image
        guard let cg = image.cgImage else { return XCTFail("\(what): no screenshot") }
        let scale = image.scale
        var px = [UInt8](repeating: 0, count: 4)
        let ctx = CGContext(data: &px, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        // left of the face window, under the status bar, above the sheet (sheet top ≈ 118 pt)
        let p = CGPoint(x: 60 * scale, y: 90 * scale)
        ctx.draw(cg, in: CGRect(x: -p.x, y: -(CGFloat(cg.height) - p.y - 1), width: CGFloat(cg.width), height: CGFloat(cg.height)))
        let lum = (0.2126 * Double(px[0]) + 0.7152 * Double(px[1]) + 0.0722 * Double(px[2])) / 255
        XCTAssertLessThan(lum, 0.2, "\(what): band above the sheet is dark (luminance \(lum))")
    }

    /// b16 (TF 391): tapping an Ask-about-this question does something you can see at once — the card folds to peek
    /// (face and caption in view) and the call pill says "Asking…".
    func testAskChipGivesFeedbackAtOnce() throws {
        let app = launch(7)
        XCTAssertTrue(sheet(app).waitForExistence(timeout: 15))
        Thread.sleep(forTimeInterval: 1.5)
        let chip = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'ask-'")).firstMatch
        XCTAssertTrue(chip.waitForExistence(timeout: 5), "an Ask about this question")
        chip.tap()
        let peek = NSPredicate(format: "value == %@", "peek")
        expectation(for: peek, evaluatedWith: sheet(app))
        waitForExpectations(timeout: 3)
        XCTAssertTrue(app.buttons["findPeek"].waitForExistence(timeout: 3), "the card waits at peek for the answer")
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "call-finds-ask-feedback"; shot.lifetime = .keepAlways; add(shot)
    }

    /// PF-1 / r02: Open in browser ↗ goes straight to the shop page (b16: the in-app Safari sheet, not the in-sheet
    /// browser); after it closes, Save to Finds becomes Open Finds.
    func testProductViewAndSave() throws {
        let app = launch(22)
        XCTAssertTrue(sheet(app).waitForExistence(timeout: 15))
        Thread.sleep(forTimeInterval: 1.2)
        let link = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'productLink-'")).firstMatch
        XCTAssertTrue(link.waitForExistence(timeout: 5))
        link.tap()
        XCTAssertFalse(app.descendants(matching: .any)["findBrowser"].waitForExistence(timeout: 2), "r02: not the in-sheet browser")
        // b16: the shop opens in the in-app Safari sheet; closing it brings the card back (an external Safari still works).
        // iOS 26's Safari sheet closes with an ✕ ("Close"), not "Done" (CI 41859808530: no "Done", the sheet stayed up
        // and the Save tap landed on the web page). The card's own close buttons are left out of the match.
        let shop = app.descendants(matching: .any)["shopSafari"]
        let close = app.buttons.matching(NSPredicate(format: "label IN %@ AND NOT (identifier BEGINSWITH 'find')", ["Done", "Close"])).firstMatch
        let save = app.buttons["findCTA"]
        if shop.waitForExistence(timeout: 8) || close.waitForExistence(timeout: 2) {
            if close.waitForExistence(timeout: 3) { close.tap() }
            _ = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: shop)], timeout: 3)
        } else {
            let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
            if safari.wait(for: .runningForeground, timeout: 4) { app.activate() }
        }
        XCTAssertTrue(sheet(app).waitForExistence(timeout: 10), "back on the call with the sheet")
        XCTAssertTrue(save.waitForExistence(timeout: 5))
        if shop.exists || !save.isHittable {
            // no close button found (or it did not close): drag the Safari sheet down by its top bar
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12))
                .press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)))
        }
        // the Safari sheet is fully gone (the card is under it while it slides away): only then is Save to Finds tapped
        let reachable = NSPredicate(format: "hittable == true")
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: reachable, object: save)], timeout: 10), .completed,
                       "the shop sheet closed and Save to Finds is reachable")
        save.tap()
        XCTAssertTrue(app.buttons["openFinds"].waitForExistence(timeout: 5), "saved: the CTA becomes Open Finds")
    }

    /// Fold and close rules: face tap folds (not interrupt), swipe down from peek closes with Undo, Undo restores.
    func testFoldCloseUndo() throws {
        let app = launch(3)
        XCTAssertTrue(sheet(app).waitForExistence(timeout: 15))
        Thread.sleep(forTimeInterval: 1)
        XCTAssertEqual(sheet(app).value as? String, "half")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.32)).tap()
        Thread.sleep(forTimeInterval: 0.8)
        XCTAssertEqual(sheet(app).value as? String, "peek", "face tap folds the sheet")
        app.buttons["findPeek"].tap()
        Thread.sleep(forTimeInterval: 0.8)
        XCTAssertEqual(sheet(app).value as? String, "half")
        app.buttons["findCloseCard"].firstMatch.tap()
        XCTAssertTrue(app.descendants(matching: .any)["findToast"].waitForExistence(timeout: 3))
        capture(app, 17)
        app.buttons["findUndo"].tap()
        Thread.sleep(forTimeInterval: 0.8)
        XCTAssertEqual(sheet(app).value as? String, "half", "Undo brings the card back")
    }
}
