import XCTest

/// F10-U-SHEET · The result sheet in each r03 board state (design-r02/revisions/r03/board.html, frames 1–19,
/// plus 20 = IC-4 "can't see it"), from events recorded on a real genita-server run (Resources/finds-fixture.json).
/// A replay server only provides the live session (ios-app/Tools/call-replay on 127.0.0.1:8789).
final class FindsSheetUITests: XCTestCase {
    private let names = [
        1: "searching", 2: "rising", 3: "half", 4: "chip-box", 5: "missing", 6: "full-steps", 7: "ask", 8: "source",
        9: "peek", 10: "user-talks", 11: "new-find", 12: "next-card", 13: "link", 14: "link-failed", 15: "picture-failed",
        16: "offline", 17: "closed-undo", 18: "voiceover", 19: "how", 20: "IC4-unclear", 21: "reasons", 22: "budget",
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
        for state in 1...20 {
            let app = launch(state)
            let expectSheet = state != 17
            if expectSheet {
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

    /// D48 ③: 1–2 reason chips from the user's own taste lines under the card title.
    func testReasonChipsUnderTheTitle() throws {
        let app = launch(21)
        XCTAssertTrue(sheet(app).waitForExistence(timeout: 15))
        let chips = app.descendants(matching: .any)["findReasons"]
        XCTAssertTrue(chips.waitForExistence(timeout: 5), "reason chips on the recipe card")
        XCTAssertEqual(chips.label, "Why this: Your taste: quick weeknight food, You said: no cilantro")
        Thread.sleep(forTimeInterval: 1.2)
        capture(app, 21)
    }

    /// Knows-Me Map: "Your budget: under $100" (from the profile, blue) beside the style chip, two priced picks.
    func testBudgetReasonChip() throws {
        let app = launch(22)
        XCTAssertTrue(sheet(app).waitForExistence(timeout: 15))
        let chips = app.descendants(matching: .any)["findReasons"]
        XCTAssertTrue(chips.waitForExistence(timeout: 5), "reason chips on the card")
        XCTAssertEqual(chips.label, "Why this: Your style: clean, minimal clothes, Your budget: under $100")
        Thread.sleep(forTimeInterval: 1.2)
        capture(app, 22)
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
