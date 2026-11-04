import XCTest

/// SUM insight report (춘식이 r02 R1): the review fixture (no server). Screenshots `onb-insight-*` go to the workflow
/// artifact for the eye check against ./_qa-scripts/genita-splash/insight "R1".
final class InsightReportUITests: XCTestCase {
    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = "onb-insight-" + name; a.lifetime = .keepAlways; add(a)
    }

    func testR1ReportScrollsThroughEverySection() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        app.launchEnvironment = ["GENITA_REVIEW_STAGE": "summary", "GENITA_REVIEW_VARIANT": "insight", "GENITA_REVIEW_NAME": "Lou"]
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["insightType"].waitForExistence(timeout: 10), "YOU'RE The Playful Editor")
        XCTAssertTrue(app.buttons["insightStart"].exists, "Start talking to Lou")
        XCTAssertEqual(app.buttons["insightStart"].label, "Start talking to Lou")
        Thread.sleep(forTimeInterval: 1)
        shot(app, "1-top")
        XCTAssertGreaterThanOrEqual(app.buttons.matching(identifier: "insightNotQuite").count, 1)
        app.swipeUp(); Thread.sleep(forTimeInterval: 0.5); shot(app, "2-noticed")
        app.swipeUp(); Thread.sleep(forTimeInterval: 0.5); shot(app, "3-strengths")
        app.swipeUp(); Thread.sleep(forTimeInterval: 0.5); shot(app, "4-chain-card")
        app.swipeUp(); Thread.sleep(forTimeInterval: 0.5)
        let details = app.buttons["insightSetupDetails"]
        XCTAssertTrue(details.waitForExistence(timeout: 5))
        details.tap(); Thread.sleep(forTimeInterval: 0.5)
        app.swipeUp(); Thread.sleep(forTimeInterval: 0.5)
        XCTAssertTrue(app.staticTexts["Think with me"].exists, "the old SUM values are still reachable")
        shot(app, "5-setup-details")
    }

    func testNotQuiteRemovesTheTrait() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        app.launchEnvironment = ["GENITA_REVIEW_STAGE": "summary", "GENITA_REVIEW_VARIANT": "insight"]
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["insightType"].waitForExistence(timeout: 10))
        app.swipeUp()
        let before = app.descendants(matching: .any).matching(identifier: "insightClaim").count
        let notQuite = app.buttons.matching(identifier: "insightNotQuite").firstMatch
        XCTAssertTrue(notQuite.waitForExistence(timeout: 5))
        notQuite.tap()
        XCTAssertTrue(app.buttons["insightRemove"].waitForExistence(timeout: 5), "What's off? sheet")
        Thread.sleep(forTimeInterval: 0.6); shot(app, "6-not-quite-sheet")
        app.buttons["insightRemove"].tap()
        XCTAssertFalse(app.buttons["insightRemove"].waitForExistence(timeout: 2))
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "insightClaim").count, before - 1)
    }

    func testNoTraitsYet() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        app.launchEnvironment = ["GENITA_REVIEW_STAGE": "summary", "GENITA_REVIEW_VARIANT": "insight-empty"]
        app.launch()
        XCTAssertTrue(app.staticTexts["insightEmpty"].waitForExistence(timeout: 10), "Most of you, I’ll learn as we talk.")
        Thread.sleep(forTimeInterval: 0.6); shot(app, "7-empty")
    }
}

final class InsightReportBackUITests: XCTestCase {
    /// 춘식이 11/4: the chevron goes back to the last question with the answers kept.
    func testBackChevronReturnsToTheLastQuestion() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting"]
        app.launchEnvironment = ["GENITA_REVIEW_STAGE": "summary", "GENITA_REVIEW_VARIANT": "insight"]
        app.launch()
        XCTAssertTrue(app.buttons["insightBack"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons["insightBack"].label, "Back to questions")
        app.buttons["insightBack"].tap()
        XCTAssertFalse(app.descendants(matching: .any)["insightType"].waitForExistence(timeout: 2), "left SUM")
    }
}

/// Chelsea 11/4: the R1 header — no orb, the type name on one line at full width (long and short), no blank band.
final class InsightHeaderUITests: XCTestCase {
    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = "onb-insight-header-" + name; a.lifetime = .keepAlways; add(a)
    }
    func testShortAndLongTypeNames() throws {
        // short / long (one line, shrunk) / long2 (past the 26 pt floor: two balanced lines) / scene and polished (the
        // header face: scene → V02 polished → orb; "short" has neither, so it shows the orb)
        for (variant, name) in [("insight", "short"), ("insight-long", "long"), ("insight-long2", "long2"), ("insight-scene", "scene"), ("insight-polished", "polished")] {
            let app = XCUIApplication()
            app.launchArguments = ["--uitesting"]
            app.launchEnvironment = ["GENITA_REVIEW_STAGE": "summary", "GENITA_REVIEW_VARIANT": variant, "GENITA_REVIEW_NAME": "Lou"]
            app.launch()
            XCTAssertTrue(app.descendants(matching: .any)["insightType"].waitForExistence(timeout: 10))
            Thread.sleep(forTimeInterval: 0.2)   // no delayed reveal: the name is there at once
            shot(app, name)
            app.terminate()
        }
    }
}
