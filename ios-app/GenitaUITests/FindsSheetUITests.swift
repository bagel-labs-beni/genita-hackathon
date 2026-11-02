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
            case 21:
                XCTAssertTrue(app.buttons["findStop"].exists, "PF-1a Stop")
                assertOneLine(app, "PF-1a searching at 390")
            case 22:
                assertDarkBand(app, "PF-1b full sheet")
                XCTAssertTrue(app.descendants(matching: .any)["productView"].exists, "PF-1b product view")
                XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'productLink-'")).count, 2, "two View buttons")
                XCTAssertTrue(app.buttons["findCTA"].exists, "Save to Finds")
            case 23:
                XCTAssertTrue(app.buttons["openFinds"].exists, "PF-1c Open Finds")
                XCTAssertFalse(app.buttons["findCTA"].exists)
            case 24:
                XCTAssertTrue(app.buttons["findRetry"].exists, "PF-1d Retry")
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

    /// Chelsea 11/3: the searching / failed lines stay on one line next to Stop at the largest default text size
    /// (the sheet's type is fixed-size, so XXXL must look exactly like the default).
    func testStatusLinesAtLargestTextSize() throws {
        for state in [21, 24] {
            let app = XCUIApplication()
            app.launchArguments = ["--uitesting", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryXXXL"]
            app.launchEnvironment = ["GENITA_REVIEW_STAGE": "conversation", "GENITA_SERVER_URL": "ws://127.0.0.1:8789/v1/session", "GENITA_FINDS_STATE": String(state)]
            app.launch()
            XCTAssertTrue(sheet(app).waitForExistence(timeout: 15))
            Thread.sleep(forTimeInterval: 1.2)
            assertOneLine(app, "state \(state) at XXXL")
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.name = String(format: "call-finds-%02d-%@-xxxl", state, names[state] ?? "")
            shot.lifetime = .keepAlways
            add(shot)
            app.terminate()
        }
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

    /// PF-1: View ↗ opens the shop page in the sheet browser; Save to Finds becomes Open Finds.
    func testProductViewAndSave() throws {
        let app = launch(22)
        XCTAssertTrue(sheet(app).waitForExistence(timeout: 15))
        Thread.sleep(forTimeInterval: 1.2)
        let link = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'productLink-'")).firstMatch
        XCTAssertTrue(link.waitForExistence(timeout: 5))
        link.tap()
        XCTAssertTrue(app.descendants(matching: .any)["findBrowser"].waitForExistence(timeout: 5), "View opens the in-sheet browser")
        app.buttons["Done"].firstMatch.tap()
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
