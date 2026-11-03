import XCTest
@testable import Genita

/// HUD r01 A (춘식이, build 8): the call's chrome on one safe-area grid.
final class CallHUDGridTests: XCTestCase {
    /// iPhone 16 Pro, the board's frame: every value from the spec table.
    func testSixteenProMatchesTheSpec() {
        let g = CallHUDGrid(size: CGSize(width: 402, height: 874), safeTop: 62, safeBottom: 34)
        XCTAssertEqual(g.rowY, 92)
        XCTAssertEqual(g.baseline, 828)
        XCTAssertEqual(g.menuCenter, CGPoint(x: 38, y: 92), "menu: left 16, 44 pt, on the top row")
        XCTAssertEqual(g.pillCenter, CGPoint(x: 201, y: 92), "pill: same centre line as the menu button")
        XCTAssertEqual(g.railX, 364, "rail: right 16")
        XCTAssertEqual([g.railY(.more), g.railY(.mic), g.railY(.camera)], [806, 750, 694], "44 pt, 12 apart, ending on 828")
        XCTAssertEqual(g.selfCenter(), CGPoint(x: 52, y: 780), "camera-off tile 72 × 96: left 16, bottom 828")
        XCTAssertEqual(g.chipCenterY(prepLine: false, cueShown: true), 92 + 16 + 6 + 15, "chip 6 pt under the pill")
        XCTAssertEqual(g.prepLineCenterY(cueShown: true), 92 + 16 + 6 + 18, "prep line 6 pt under the pill")
        XCTAssertEqual(g.chipCenterY(prepLine: true, cueShown: true), 92 + 16 + 6 + 36 + 6 + 15, "chip 6 pt under the prep line")
        XCTAssertEqual(g.chipCenterY(prepLine: true, cueShown: false), 92 + 18 + 6 + 15, "no cue: the prep line takes the row")
    }

    /// The rail and the self view end on one line, and both sides keep the same 16 pt margin, on every size.
    func testOneMarginOneBaselineOnEverySize() {
        let sizes: [(CGSize, CGFloat, CGFloat)] = [(CGSize(width: 375, height: 667), 20, 0), (CGSize(width: 390, height: 844), 47, 34), (CGSize(width: 440, height: 956), 62, 34)]
        for (size, top, bottom) in sizes {
            let g = CallHUDGrid(size: size, safeTop: top, safeBottom: bottom)
            XCTAssertEqual(g.railY(.more) + CallHUDGrid.button / 2, g.baseline)
            XCTAssertEqual(g.selfCenter().y + CallHUDGrid.selfOff.height / 2, g.baseline)
            XCTAssertEqual(g.menuCenter.x - CallHUDGrid.button / 2, CallHUDGrid.margin)
            XCTAssertEqual(size.width - (g.railX + CallHUDGrid.button / 2), CallHUDGrid.margin)
            XCTAssertEqual(g.selfCenter().x - CallHUDGrid.selfOff.width / 2, CallHUDGrid.margin)
            XCTAssertEqual(g.menuCenter.y, g.pillCenter.y)
            XCTAssertGreaterThan(g.rowY - CallHUDGrid.button / 2, top, "the top row stays inside the safe area")
            // the half-size tile keeps its left edge on the margin
            XCTAssertEqual(g.selfCenter(scale: 0.5).x - CallHUDGrid.selfOff.width * 0.25, CallHUDGrid.margin)
        }
    }

    /// The call cue steps aside once the Finds sheet is half up or more; peek keeps it. A Finds line (PF-1) and a
    /// problem the user must act on stay.
    func testCueHidesFromHalfButNotFindsLinesOrProblems() {
        XCTAssertFalse(ConversationView.cueHidden(sheet: .idle, findsLine: false, cue: .listening))
        XCTAssertFalse(ConversationView.cueHidden(sheet: .peek, findsLine: false, cue: .listening))
        XCTAssertTrue(ConversationView.cueHidden(sheet: .half, findsLine: false, cue: .listening))
        XCTAssertTrue(ConversationView.cueHidden(sheet: .full, findsLine: false, cue: .speaking))
        XCTAssertFalse(ConversationView.cueHidden(sheet: .half, findsLine: true, cue: .listening), "PF-1 Finds line stays")
        XCTAssertFalse(ConversationView.cueHidden(sheet: .full, findsLine: false, cue: .reconnecting), "a problem stays")
        XCTAssertFalse(ConversationView.cueHidden(sheet: .half, findsLine: false, cue: .micBlocked), "a problem stays")
    }
}
