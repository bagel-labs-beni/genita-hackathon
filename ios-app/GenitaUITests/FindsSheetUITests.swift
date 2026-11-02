import XCTest

/// F10-U-SHEET · The result sheet in each r03 board state (design-r02/revisions/r03/board.html, frames 1–19,
/// plus 20 = IC-4 "can't see it"), from events recorded on a real genita-server run (Resources/finds-fixture.json).
/// A replay server only provides the live session (ios-app/Tools/call-replay on 127.0.0.1:8789).
final class FindsSheetUITests: XCTestCase {
    private let names = [
        1: "searching", 2: "rising", 3: "half", 4: "chip-box", 5: "missing", 6: "full-steps", 7: "ask", 8: "source",
        9: "peek", 10: "user-talks", 11: "new-find", 12: "next-card", 13: "link", 14: "link-failed", 15: "picture-failed",
        16: "offline", 17: "closed-undo", 18: "voiceover", 19: "how", 20: "IC4-unclear",
        21: "pf1-searching", 22: "pf1-products", 23: "pf1-saved", 24: "pf1-failed",
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
        for state in 1...24 {
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
            case 21: XCTAssertTrue(app.buttons["findStop"].exists, "PF-1a Stop")
            case 22:
                XCTAssertTrue(app.descendants(matching: .any)["productView"].exists, "PF-1b product view")
                XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'productLink-'")).count, 2, "two View buttons")
                XCTAssertTrue(app.buttons["findCTA"].exists, "Save to Finds")
            case 23:
                XCTAssertTrue(app.buttons["openFinds"].exists, "PF-1c Open Finds")
                XCTAssertFalse(app.buttons["findCTA"].exists)
            case 24: XCTAssertTrue(app.buttons["findRetry"].exists, "PF-1d Retry")
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

    /// PF-1: View ↗ opens the shop page in the sheet browser; Save to Finds becomes Open Finds.
    func testProductViewAndSave() throws {
        let app = launch(22)
        XCTAssertTrue(sheet(app).waitForExistence(timeout: 15))
        Thread.sleep(forTimeInterval: 1.2)
        let link = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'productLink-'")).firstMatch
        XCTAssertTrue(link.waitForExistence(timeout: 5))
        link.tap()
        XCTAssertTrue(app.descendants(matching: .any)["findBrowser"].waitForExistence(timeout: 5), "View opens the in-sheet browser")
        app.buttons["browserDone"].tap()
        let save = app.buttons["findCTA"]
        XCTAssertTrue(save.waitForExistence(timeout: 5))
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
