import CoreGraphics

/// S09 call HUD grid (춘식이 HUD r01, option A "위 한 줄", build 8). One place for where the call's chrome sits, read by
/// ConversationView (layout) and CameraBoxes (label obstacles), so the two never disagree.
///
/// - Top row: the menu button (left) and the status pill (centre) share one centre line, safe area top + 30.
/// - Bottom baseline: screen height − safe area bottom − 12. The control rail and the self view end on it.
/// - One side margin, 16 pt. Glass buttons 44 pt, 12 pt apart.
///
/// Anchored on the safe area, not the 390 × 844 board, so SE / Pro Max keep the same relationships.
/// Option B / C (island pill, FaceTime row) would only change this file and the views that read it.
struct CallHUDGrid: Equatable {
    var size: CGSize
    var safeTop: CGFloat
    var safeBottom: CGFloat

    static let margin: CGFloat = 16
    static let button: CGFloat = 44
    static let gap: CGFloat = 12

    /// Centre line of the top row (menu button + status pill): 92 on an iPhone 16 Pro (safe top 62).
    var rowY: CGFloat { safeTop + 30 }
    /// Bottom edge of the control rail and the self view: 828 on an iPhone 16 Pro (874 − 34 − 12).
    var baseline: CGFloat { size.height - safeBottom - 12 }

    /// Camera box labels stay below this: the menu row band (safe top … safe top + 60) is the HUD's.
    var labelFloor: CGFloat { safeTop + 60 }

    var menuCenter: CGPoint { CGPoint(x: Self.margin + Self.button / 2, y: rowY) }

    // MARK: control rail (flip, camera, mic, more — top to bottom)

    /// `flip` (build 10, Chelsea): a fourth glass button one step above the camera, only while the camera is on and can
    /// flip (`showsFlip`). Same 44 pt, same 12 pt gap.
    enum RailButton: Int, CaseIterable { case flip = 3, camera = 2, mic = 1, more = 0 }
    /// The rail's flip button shows while the camera is on and can flip, and the Finds sheet is down (idle / dismissed).
    /// With any sheet up the rail rises: half reaches the top row on small screens, and peek pushed SE captions over the
    /// companion window (Codex P2). More keeps Flip camera there.
    static func showsFlip(cameraOn: Bool, canFlip: Bool, sheet: SheetState) -> Bool {
        cameraOn && canFlip && !sheetUp(sheet)
    }
    /// The rail's top button: flip when it shows, else camera.
    static func railTop(flip: Bool) -> RailButton { flip ? .flip : .camera }
    var railX: CGFloat { size.width - Self.margin - Self.button / 2 }
    /// While the Finds sheet is up the rail and the self view keep the board's line (806 on 390 × 844, + the screen's
    /// extra height), so the sheet's shift clears them on every screen (SE has no home bar: the HUD baseline sits
    /// 27 pt lower than the board's there, and the half sheet covered More — Codex P2).
    var sheetBaseline: CGFloat { size.height - 844 + 806 }
    /// Centre y of a rail button before the Finds sheet shift: more = baseline − 22, mic − 78, camera − 134, flip − 190.
    func railY(_ b: RailButton, sheetUp: Bool = false) -> CGFloat {
        (sheetUp ? sheetBaseline : baseline) - Self.button / 2 - CGFloat(b.rawValue) * (Self.button + Self.gap)
    }

    /// Live captions r01: the caption block's bottom edge, 16 pt above the rail's top button (camera: 626 on 390 × 844;
    /// flip, when it shows: 570). The caller adds the Finds sheet's rail shift, like the rail.
    func captionBottom(sheetUp: Bool = false, flip: Bool = false) -> CGFloat {
        railY(Self.railTop(flip: flip), sheetUp: sheetUp) - Self.button / 2 - 16
    }

    // MARK: status pill

    /// Where the status pill is right now.
    enum StatusLine: Equatable {
        /// nothing in the pill's place
        case none
        /// the call cue on the menu row (HUD r01 A)
        case row
        /// the line just under the row: anything too wide for the row (a cue with a button, a long Finds line, MV-E)
        case second
    }
    var pillCenter: CGPoint { CGPoint(x: size.width / 2, y: rowY) }
    /// The second line's centre: its top 8 under the row's tallest piece — the 44 pt menu button (safe top + 52 + 8;
    /// 춘식이's "8 under the row", measured from the button: from the pill it left 2 pt under the button, pixel QA #530).
    /// 32 tall. Max width = screen − 32.
    var secondLineY: CGFloat { rowY + Self.button / 2 + 8 + CallPillMetrics.height / 2 }
    /// Room for a centred pill on the menu row without touching the menu button or its mirror (8 pt clear).
    var rowPillWidth: CGFloat { size.width - 2 * (Self.margin + Self.button + 8) }
    func statusY(_ line: StatusLine) -> CGFloat { line == .second ? secondLineY : rowY }

    /// The bottom of a line: the menu row ends with its 44 pt button (safe top + 52), not the 32 pt pill (춘식이:
    /// spacing is from the lowest piece of the line).
    func lineBottom(_ line: StatusLine) -> CGFloat {
        line == .second ? secondLineY + CallPillMetrics.height / 2 : rowY + Self.button / 2
    }
    /// S09-PREP line (36 tall): in the pill's place when there is no pill and it fits the row (`fitsRow`, as the pill's
    /// rule; else top on the second line), otherwise 6 pt under the pill's line.
    func prepLineCenterY(status: StatusLine, fitsRow: Bool = true) -> CGFloat {
        guard status == .none else { return lineBottom(status) + 6 + CallPillMetrics.prepHeight / 2 }
        return fitsRow ? rowY : secondLineY - CallPillMetrics.height / 2 + CallPillMetrics.prepHeight / 2
    }
    /// The "Getting to know you" / "Noted" chip (30 tall) sits 6 pt under the lowest line above it.
    /// Alone (no pill, no prep line) it follows the pill's rule: on the row when it fits between the menu button and
    /// its mirror (`fitsRow`), else on the second line (top 8 under the menu button), never across it.
    func chipCenterY(status: StatusLine, prepLine: Bool, fitsRow: Bool = false, prepFitsRow: Bool = true) -> CGFloat {
        if status == .none && !prepLine { return fitsRow ? rowY : secondLineY - CallPillMetrics.height / 2 + 15 }
        // 6 under the lowest piece above it — never above the menu row's bottom (the button)
        let above = max(lineBottom(.row), prepLine ? prepLineCenterY(status: status, fitsRow: prepFitsRow) + CallPillMetrics.prepHeight / 2 : lineBottom(status == .none ? .row : status))
        return above + 6 + 15
    }

    // MARK: self view (camera off)

    static let selfOff = CGSize(width: 72, height: 96)
    /// Centre of the camera-off tile, left edge on the margin, bottom on the baseline (scaled about its centre by the caller).
    func selfCenter(lift: CGFloat = 0, scale: CGFloat = 1, sheetUp: Bool = false) -> CGPoint {
        let s = Self.selfOff
        return CGPoint(x: Self.margin + s.width * scale / 2, y: (sheetUp ? sheetBaseline : baseline) - s.height / 2 + lift)
    }
    /// The sheet states that move the rail and the self view (CameraBoxes.railShift ≠ 0).
    static func sheetUp(_ s: SheetState) -> Bool { s != .idle && s != .dismissed }

    // MARK: Finds undo toast (r03 #17, "In Finds · Undo")

    /// The toast's height: the Undo button's 44 pt touch row.
    static let toastHeight: CGFloat = 44
    /// Centre line of the undo toast (centred across). `top` is ConversationView's board offset (safe top − 44).
    /// Camera off: y 210 + top, over the face (r03). Camera on: 8 pt under the companion window (96 × 128, its centre
    /// at 184 + top) and, while it is up, the FT-NOSEE card (124 + top, `noSeeHeight` tall), so the toast never
    /// covers "I don’t see kimchi" or the face (UI QA CW-01, build 10: it sat on the card's third row).
    static func toastCenterY(top: CGFloat, cameraOn: Bool, noSeeHeight: CGFloat?) -> CGFloat {
        guard cameraOn else { return 210 + top }
        let window = 184 + 64 + top
        let card = noSeeHeight.map { 124 + top + $0 } ?? -.greatestFiniteMagnitude
        return max(window, card) + 8 + toastHeight / 2
    }
}

/// The status pill's box (HUD r01 A). Position comes from `CallHUDGrid`; how the pill moves (width spring, text
/// interpolation, Noted swap) belongs to the motion lane and is not set here.
enum CallPillMetrics {
    static let height: CGFloat = 32
    static let radius: CGFloat = 16
    static let leading: CGFloat = 12
    static let trailing: CGFloat = 14
    static let trailingWithAction: CGFloat = 8
    static let vertical: CGFloat = 6
    static let iconSpacing: CGFloat = 7
    /// S09-PREP line keeps its 36 pt pill.
    static let prepHeight: CGFloat = 36
}
