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

    var menuCenter: CGPoint { CGPoint(x: Self.margin + Self.button / 2, y: rowY) }

    // MARK: control rail (camera, mic, more — top to bottom)

    enum RailButton: Int, CaseIterable { case camera = 2, mic = 1, more = 0 }
    var railX: CGFloat { size.width - Self.margin - Self.button / 2 }
    /// Centre y of a rail button before the Finds sheet shift: more = baseline − 22, mic − 78, camera − 134.
    func railY(_ b: RailButton) -> CGFloat { baseline - Self.button / 2 - CGFloat(b.rawValue) * (Self.button + Self.gap) }

    // MARK: status pill

    var pillCenter: CGPoint { CGPoint(x: size.width / 2, y: rowY) }
    /// The "Getting to know you" / "Noted" chip (30 tall) sits 6 pt under the lowest line above it: the status pill, or
    /// the S09-PREP line when that is showing.
    func chipCenterY(prepLine: Bool, cueShown: Bool) -> CGFloat {
        let above = prepLine ? prepLineCenterY(cueShown: cueShown) + CallPillMetrics.prepHeight / 2 : rowY + CallPillMetrics.height / 2
        return above + 6 + 15
    }
    /// S09-PREP line: in the pill's slot when there is no cue, otherwise 6 pt under it.
    func prepLineCenterY(cueShown: Bool) -> CGFloat {
        cueShown ? rowY + CallPillMetrics.height / 2 + 6 + CallPillMetrics.prepHeight / 2 : rowY
    }

    // MARK: self view (camera off)

    static let selfOff = CGSize(width: 72, height: 96)
    /// Centre of the camera-off tile, left edge on the margin, bottom on the baseline (scaled about its centre by the caller).
    func selfCenter(lift: CGFloat = 0, scale: CGFloat = 1) -> CGPoint {
        let s = Self.selfOff
        return CGPoint(x: Self.margin + s.width * scale / 2, y: baseline - s.height / 2 + lift)
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
