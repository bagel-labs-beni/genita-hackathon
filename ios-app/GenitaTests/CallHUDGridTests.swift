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
        XCTAssertEqual(g.secondLineY, 138, "second line: top 8 under the menu button (62 + 52 + 8), 32 tall")
        XCTAssertEqual(g.secondLineY - CallPillMetrics.height / 2 - (g.menuCenter.y + CallHUDGrid.button / 2), 8, "8 pt clear of the button")
        // the chip and the prep line stack 6 pt under whatever is above them
        // the row ends with the 44 pt button (+52): 6 under that, not under the 32 pt pill (춘식이)
        XCTAssertEqual(g.chipCenterY(status: .row, prepLine: false), 92 + 22 + 6 + 15)
        XCTAssertEqual(g.prepLineCenterY(status: .row), 92 + 22 + 6 + 18)
        XCTAssertEqual(g.chipCenterY(status: .row, prepLine: true), 92 + 22 + 6 + 36 + 6 + 15)
        XCTAssertEqual(g.prepLineCenterY(status: .none), 92, "no pill: the prep line takes the row")
        XCTAssertEqual(g.prepLineCenterY(status: .none, fitsRow: false), 62 + 60 + 18, "too wide for the row (Codex P2, 320 pt): top on the second line")
        XCTAssertEqual(g.chipCenterY(status: .none, prepLine: true, prepFitsRow: false), 62 + 60 + 36 + 6 + 15)
        XCTAssertEqual(g.chipCenterY(status: .none, prepLine: true), 92 + 22 + 6 + 15, "prep on the row: chip under the row's button")
        XCTAssertEqual(g.chipCenterY(status: .none, prepLine: false, fitsRow: true), 92, "alone and short: on the row, like the pill")
        XCTAssertEqual(g.chipCenterY(status: .none, prepLine: false), 62 + 60 + 15, "alone and wide: top on the second line (+60)")
        XCTAssertGreaterThan(g.chipCenterY(status: .none, prepLine: false) - 15, g.menuCenter.y + CallHUDGrid.button / 2, "clear of the menu button (Codex P2)")
        XCTAssertEqual(g.prepLineCenterY(status: .second), 138 + 16 + 6 + 18, "under the second line, not on it (Codex P2)")
        XCTAssertEqual(g.chipCenterY(status: .second, prepLine: true), 138 + 16 + 6 + 36 + 6 + 15)
        XCTAssertEqual(g.chipCenterY(status: .second, prepLine: false), 138 + 16 + 6 + 15, "chip 6 under the second line too")
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

    /// Build 10 (Chelsea): the flip button sits one 44 + 12 step above the camera, clear of the companion window
    /// (y 184 + top, 128 tall) and of the top row; captions and the label obstacle rail move up with it.
    func testFlipSitsAboveCameraAndClearsTheWindow() {
        let sizes: [(CGSize, CGFloat, CGFloat)] = [(CGSize(width: 375, height: 667), 20, 0), (CGSize(width: 390, height: 844), 47, 34), (CGSize(width: 440, height: 956), 62, 34)]
        for (size, top, bottom) in sizes {
            let g = CallHUDGrid(size: size, safeTop: top, safeBottom: bottom)
            XCTAssertEqual(g.railY(.camera) - g.railY(.flip), CallHUDGrid.button + CallHUDGrid.gap)
            XCTAssertEqual(g.captionBottom(flip: true), g.railY(.flip) - CallHUDGrid.button / 2 - 16)
            XCTAssertEqual(g.captionBottom(flip: false), g.captionBottom())
            for sheet in [SheetState.idle, .dismissed, .peek, .searching] where CallHUDGrid.showsFlip(cameraOn: true, canFlip: true, sheet: sheet) {
                let flipTop = g.railY(.flip, sheetUp: CallHUDGrid.sheetUp(sheet)) + CameraBoxes.railShift(sheet) - CallHUDGrid.button / 2
                XCTAssertGreaterThan(flipTop, 184 + top + 64, "below the companion window (\(size), \(sheet))")
                XCTAssertEqual(CameraBoxes.railRect(grid: g, sheet: sheet, flip: true).minY, flipTop - 4)
            }
        }
        XCTAssertFalse(CallHUDGrid.showsFlip(cameraOn: false, canFlip: true, sheet: .idle), "camera off: no flip")
        XCTAssertFalse(CallHUDGrid.showsFlip(cameraOn: true, canFlip: false, sheet: .idle))
        XCTAssertFalse(CallHUDGrid.showsFlip(cameraOn: true, canFlip: true, sheet: .half), "half sheet: More keeps Flip camera")
        XCTAssertTrue(CallHUDGrid.showsFlip(cameraOn: true, canFlip: true, sheet: .peek))
    }

    /// Codex P2: on SE (no home bar) the HUD baseline is 27 pt below the board's; with the sheet up the rail keeps the
    /// board's line, so More ends above the half sheet as before (old: 46 pt More centred at 783 + (H − 844) − 440).
    func testRailClearsTheHalfSheetOnSE() {
        let se = CallHUDGrid(size: CGSize(width: 375, height: 667), safeTop: 20, safeBottom: 0)
        let oldMoreBottom: CGFloat = 783 + (667 - 844) - 440 + 23
        XCTAssertLessThanOrEqual(se.railY(.more, sheetUp: true) - 440 + 22, oldMoreBottom, "no lower than the 46 pt More was")
        XCTAssertEqual(se.railY(.more), 667 - 12 - 22, "sheet down: the HUD baseline")
        XCTAssertTrue(CallHUDGrid.sheetUp(.half) && CallHUDGrid.sheetUp(.peek) && !CallHUDGrid.sheetUp(.idle) && !CallHUDGrid.sheetUp(.dismissed))
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

    /// Measured, not counted (춘식이): a pill no wider than the row's room stays on the row, wider ones take the second line.
    func testStatusLinePlacement() {
        XCTAssertEqual(ConversationView.statusLine(width: 140, rowWidth: 266), .row)
        XCTAssertEqual(ConversationView.statusLine(width: 266, rowWidth: 266), .row, "exactly the room: row")
        XCTAssertEqual(ConversationView.statusLine(width: 267, rowWidth: 266), .second)
        XCTAssertEqual(ConversationView.statusLine(width: nil, rowWidth: 266), .none)
        let se = CallHUDGrid(size: CGSize(width: 375, height: 667), safeTop: 20, safeBottom: 0)
        let pro = CallHUDGrid(size: CGSize(width: 402, height: 874), safeTop: 62, safeBottom: 34)
        func line(_ cue: CallCue, _ g: CallHUDGrid, finds: String? = nil) -> CallHUDGrid.StatusLine {
            ConversationView.statusLine(width: CallCueView.width(cue: cue, name: "Jin", findsText: finds, rowWidth: g.rowPillWidth), rowWidth: g.rowPillWidth)
        }
        XCTAssertEqual(line(.listening, se), .row)
        XCTAssertEqual(line(.thinking, se), .row)
        XCTAssertEqual(line(.answerFailed, se), .second, "Couldn’t get an answer. + Try again: too wide for the row")
        XCTAssertEqual(line(.micBlocked, pro), .second, "Microphone is off for Genita. + Settings")
        XCTAssertEqual(line(.none, pro), .none)
        XCTAssertEqual(line(.listening, pro, finds: "Found two for you."), .row, "a short Finds line fits the row")
        XCTAssertEqual(line(.reconnecting, pro, finds: "Found two for you."), .row, "Reconnecting wins over Finds")
    }

    /// D54: mic off keeps the pill in its slot with one word, and it stays on the row.
    func testMicOffCueSaysStopped() {
        XCTAssertEqual(CallCueView.line(cue: .micOff, name: "Jin", findsText: nil, rowWidth: nil)?.text, "Stopped")
    }
    /// Codex P2: a 20-character name (NM01) made "{name} is thinking" run into the menu button. Too wide → the short word;
    /// every cue that stays on the row fits it on the smallest phone.
    func testRowCuesFitBetweenTheMenuButtonAndItsMirror() {
        let se = CallHUDGrid(size: CGSize(width: 375, height: 667), safeTop: 20, safeBottom: 0)
        XCTAssertEqual(CallCueView.nameLine("Jin", "thinking", short: "Thinking", rowWidth: se.rowPillWidth), "Jin is thinking")
        XCTAssertEqual(CallCueView.nameLine("WWWWWWWWWWWWWWWWWWWW", "thinking", short: "Thinking", rowWidth: se.rowPillWidth), "Thinking")
        XCTAssertEqual(CallCueView.nameLine("WWWWWWWWWWWWWWWWWWWW", "talking", short: "Talking", rowWidth: nil), "WWWWWWWWWWWWWWWWWWWW is talking", "no limit off the row")
        for text in ["Listening", "Thinking", "Talking", "Stopped", "Stopped. Go ahead.", "Reconnecting…", "Moving to your Mac…"] {
            XCTAssertLessThanOrEqual(CallCueView.pillWidth(text: text), se.rowPillWidth, text)
        }
    }
}
