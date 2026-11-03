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
        XCTAssertEqual(g.rowPillWidth, 402 - 136, "pill room on the row: clear of the menu button and its mirror by 8")
        XCTAssertEqual(g.secondLineY, 160, "the line under the row: the board's status line (PF-1)")
        // the chip and the prep line stack 6 pt under whatever is above them
        XCTAssertEqual(g.chipCenterY(status: .row, prepLine: false), 92 + 16 + 6 + 15)
        XCTAssertEqual(g.prepLineCenterY(status: .row), 92 + 16 + 6 + 18)
        XCTAssertEqual(g.chipCenterY(status: .row, prepLine: true), 92 + 16 + 6 + 36 + 6 + 15)
        XCTAssertEqual(g.prepLineCenterY(status: .none), 92, "no pill: the prep line takes the row")
        XCTAssertEqual(g.chipCenterY(status: .none, prepLine: true), 92 + 18 + 6 + 15)
        XCTAssertEqual(g.chipCenterY(status: .none, prepLine: false), 92 + 16 + 6 + 15, "alone: under the row, never on it (Codex P2: a wide chip covered the button)")
        XCTAssertGreaterThanOrEqual(g.chipCenterY(status: .none, prepLine: false) - 15, g.menuCenter.y + CallHUDGrid.button / 2, "clear of the menu button")
        XCTAssertEqual(g.prepLineCenterY(status: .second), 160 + 16 + 6 + 18, "under a Finds line, not on it (Codex P2)")
        XCTAssertEqual(g.chipCenterY(status: .second, prepLine: true), 160 + 16 + 6 + 36 + 6 + 15)
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

    /// Plain cues on the menu row; a Finds line or a cue with a button on the line under it (they don't fit the row).
    func testStatusLinePlacement() {
        XCTAssertEqual(ConversationView.statusLine(cue: .listening, findsLine: false, moveLine: false, shown: true), .row)
        XCTAssertEqual(ConversationView.statusLine(cue: .listening, findsLine: true, moveLine: false, shown: true), .second)
        XCTAssertEqual(ConversationView.statusLine(cue: .reconnecting, findsLine: true, moveLine: false, shown: true), .row, "the cue wins over Finds: no button, fits the row")
        XCTAssertEqual(ConversationView.statusLine(cue: .answerFailed, findsLine: false, moveLine: false, shown: true), .second, "Try again doesn't fit the row")
        XCTAssertEqual(ConversationView.statusLine(cue: .micBlocked, findsLine: false, moveLine: false, shown: true), .second)
        XCTAssertEqual(ConversationView.statusLine(cue: .none, findsLine: false, moveLine: false, shown: true), .none)
        XCTAssertEqual(ConversationView.statusLine(cue: .listening, findsLine: false, moveLine: false, shown: false), .none)
        XCTAssertEqual(ConversationView.statusLine(cue: .none, findsLine: false, moveLine: true, shown: true), .row, "MV-1 move line on the row")
        XCTAssertEqual(ConversationView.statusLine(cue: .none, findsLine: false, moveLine: true, moveFailed: true, shown: true), .second, "MV-E (\"Mac not responding. Still here.\") goes under the row on every size")
    }

    /// Codex P2: a 20-character name (NM01) made "{name} is thinking" run into the menu button. Too wide → the short word;
    /// every cue that stays on the row fits it on the smallest phone.
    func testRowCuesFitBetweenTheMenuButtonAndItsMirror() {
        let se = CallHUDGrid(size: CGSize(width: 375, height: 667), safeTop: 20, safeBottom: 0)
        XCTAssertEqual(CallCueView.nameLine("Jin", "thinking", short: "Thinking", rowWidth: se.rowPillWidth), "Jin is thinking")
        XCTAssertEqual(CallCueView.nameLine("WWWWWWWWWWWWWWWWWWWW", "thinking", short: "Thinking", rowWidth: se.rowPillWidth), "Thinking")
        XCTAssertEqual(CallCueView.nameLine("WWWWWWWWWWWWWWWWWWWW", "talking", short: "Talking", rowWidth: nil), "WWWWWWWWWWWWWWWWWWWW is talking", "no limit off the row")
        for text in ["Listening", "Thinking", "Talking", "Stopped. Go ahead.", "Reconnecting…", "Moving to your Mac…"] {
            XCTAssertLessThanOrEqual(CallCueView.pillWidth(text: text), se.rowPillWidth, text)
        }
    }
}
