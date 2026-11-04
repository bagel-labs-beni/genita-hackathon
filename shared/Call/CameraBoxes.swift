import CoreGraphics
import Foundation
import Observation

// F5-U-CAM · CAM-H: the boxes the server finds on a camera frame (`observe.boxes`, 0–1 of that frame) drawn over the
// live preview. Each box pops in (240 ms, 60 ms apart), the label sits above the box (below when there is no room),
// everything fades after 4 s, and a tapped ingredient chip lights its box (and brings the boxes back for 4 s).
// Demo S3 (iPhone): a batch from the server stays until the companion has said what she sees (`Hold`), not 4 s.

struct LiveBox: Identifiable, Equatable {
    /// One per label, except with SAM masks on (one item per match): "tomatoes", "tomatoes#1", "tomatoes#2".
    var id: String { instance == 0 ? key : "\(key)#\(instance)" }
    /// The label lowercased: what a chip lights (every instance of it).
    var key: String { label.lowercased() }
    var label: String
    var box: NormBox
    /// Order the box popped in within its batch (drives the 60 ms stagger).
    var order: Int
    /// Demo S3 · SAM pixel mask (server GENITA_SAM_MASKS=1); nil = draw the box as before.
    var mask: NormMask? = nil
    /// n-th match of this label in the batch (0 = the first)
    var instance: Int = 0
}

@MainActor @Observable final class CameraBoxes {
    /// What the server last found, by label. Kept after the fade so a chip tap can bring a box back.
    private(set) var boxes: [LiveBox] = []
    /// Size of the frame the boxes belong to (aspect-fill mapping needs its aspect).
    private(set) var frameSize = CGSize(width: 480, height: 854)
    private(set) var findId: String?
    /// Boxes are on screen; false after the 4 s fade.
    private(set) var visible = false
    /// Label of the lit box (chip tapped), lowercased.
    private(set) var highlighted: String?
    /// Bumped on every reveal so a new batch re-runs the pop animation.
    private(set) var generation = 0
    /// Bumped when the camera is flipped or turned off; boxes from before it are stale.
    private(set) var epoch = 0
    @ObservationIgnored var fadeAfter: Duration = .seconds(4)
    /// Demo S3: soft pixel masks instead of boxes, when the server sends them (server GENITA_SAM_MASKS=1).
    /// On by default since Chelsea's OK of option (c) (11/3); `GENITA_SAM_MASKS_UI=0` or the `genita.samMasks`
    /// default set to false goes back to boxes. Without masks on the wire the boxes draw as before either way.
    static var masksEnabled: Bool {
        if let env = ProcessInfo.processInfo.environment["GENITA_SAM_MASKS_UI"] { return env != "0" }
        return UserDefaults.standard.object(forKey: "genita.samMasks") as? Bool ?? true
    }
    /// Gray images of each box's mask and its outline, made once per batch (by LiveBox.id).
    @ObservationIgnored private var maskCache: [String: (fill: CGImage, edge: CGImage)] = [:]
    func maskImages(for item: LiveBox) -> (fill: CGImage, edge: CGImage)? {
        if let hit = maskCache[item.id] { return hit }
        guard let m = item.mask, let fill = m.bitmap().flatMap({ Self.grayImage($0, w: m.w, h: m.h) }),
              let edge = m.edgeBitmap().flatMap({ Self.grayImage($0, w: m.w, h: m.h) }) else { return nil }
        maskCache[item.id] = (fill, edge)
        return (fill, edge)
    }
    // MARK: mask labels (demo S3 option c)

    /// CameraStage space: the menu button (CallHUDGrid: 44 pt at (38, safe top + 30)), padded 6 pt.
    static func menuRect(grid: CallHUDGrid) -> CGRect {
        let c = grid.menuCenter, r = CallHUDGrid.button / 2 + 6
        return CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r)
    }
    /// The status line pill, centred, 32 pt tall, on the grid's menu row or the line under it, `width` wide (measured;
    /// at least 240 so a changing line never uncovers a label), padded 4 pt.
    /// A box label under it read as one pill over another ("Green onion" behind "Listening", UI sweep 11/3).
    static func statusRect(grid: CallHUDGrid, line: CallHUDGrid.StatusLine = .row, width: CGFloat = 240) -> CGRect {
        let y = grid.statusY(line), h = CallPillMetrics.height
        let w = min(max(width, 240), grid.size.width - 2 * CallHUDGrid.margin), c = grid.size.width / 2
        return CGRect(x: c - w / 2 - 4, y: y - h / 2 - 4, width: w + 8, height: h + 8)
    }
    /// How far the right-hand control rail (camera, mic, more) moves up with the Finds sheet (ConversationView reads it too).
    static func railShift(_ s: SheetState) -> CGFloat {
        switch s {
        case .half, .rising, .full: -440
        case .peek, .searching: -122
        default: 0
        }
    }
    /// The control rail: three 44 pt glass buttons (CallHUDGrid: x = width − 38, ending on the baseline, + the sheet
    /// shift), padded 4 pt. A label under it can't be read ("Whole milk", UI sweep 11/3).
    static func railRect(grid: CallHUDGrid, sheet: SheetState) -> CGRect {
        let up = CallHUDGrid.sheetUp(sheet), half = CallHUDGrid.button / 2
        let top = grid.railY(.camera, sheetUp: up) - half + railShift(sheet), bottom = grid.railY(.more, sheetUp: up) + half + railShift(sheet)
        return CGRect(x: grid.railX - half - 4, y: top - 4, width: CallHUDGrid.button + 8, height: bottom - top + 8)
    }
    /// The self-view PiP (96 × 128 at y 184 + top; right edge 20 pt, or left while the sheet is half up), padded 6 pt.
    static func pipRect(view: CGSize, top: CGFloat, sheetHalf: Bool) -> CGRect {
        let midX = sheetHalf ? 68 : view.width - 68
        return CGRect(x: midX - 48 - 6, y: 184 + top - 64 - 6, width: 96 + 12, height: 128 + 12)
    }

    /// Where a label pill goes (absolute origin), keeping clear of `obstacles` (menu button, PiP). Tried in order:
    /// above the box at its left edge (where boxes put it), inside its top (6 pt), below it (6 pt), then each of those
    /// slid beside the obstacle it hits. Never above `topInset` (the HUD row band), never off screen. Nothing fits: the box rule.
    static func labelOrigin(_ rect: CGRect, label: CGSize, view: CGSize, topInset: CGFloat, obstacles: [CGRect]) -> CGPoint {
        let ys = [rect.minY - label.height - 4, rect.minY + 6, rect.maxY + 6]
        var xs = [max(0, rect.minX)]
        for o in obstacles { xs += [o.maxX + 4, o.minX - label.width - 4] }
        for y in ys {
            for x in xs {
                let r = CGRect(x: x, y: y, width: label.width, height: label.height)
                guard r.minY >= topInset, r.minX >= 0, r.maxX <= view.width, r.maxY <= view.height else { continue }
                // beside the box, not floating far from it
                guard r.maxX >= rect.minX - 8, r.minX <= rect.maxX + 8 else { continue }
                if !obstacles.contains(where: { $0.intersects(r) }) { return r.origin }
            }
        }
        return CGPoint(x: max(0, rect.minX), y: rect.minY + labelOffsetY(rect, topInset: topInset))
    }

    /// Every label's origin, placed one after another: a placed pill (padded 4 pt) becomes an obstacle for the next,
    /// so two pills never sit on each other ("Green onion" over "Whole milk", UI sweep 11/3 after the status fix).
    static func labelOrigins(_ drawn: [(id: String, rect: CGRect, label: CGSize)], view: CGSize, topInset: CGFloat, obstacles: [CGRect]) -> [String: CGPoint] {
        var placed = obstacles
        var out: [String: CGPoint] = [:]
        for d in drawn {
            let o = labelOrigin(d.rect, label: d.label, view: view, topInset: topInset, obstacles: placed)
            out[d.id] = o
            placed.append(CGRect(origin: o, size: d.label).insetBy(dx: -4, dy: -4))
        }
        return out
    }

    /// One label pill per label: on its largest match among those actually drawn (a hidden one can't own it).
    /// `drawn` = the boxes on screen with their view rects. Returns the ids that carry a label.
    static func labelOwners(_ drawn: [(item: LiveBox, rect: CGRect)]) -> Set<String> {
        var best: [String: (id: String, area: CGFloat)] = [:]
        for d in drawn {
            let area = d.rect.width * d.rect.height
            if let b = best[d.item.key], b.area >= area { continue }
            best[d.item.key] = (d.item.id, area)
        }
        return Set(best.values.map(\.id))
    }
    static func grayImage(_ bytes: [UInt8], w: Int, h: Int) -> CGImage? {
        guard bytes.count == w * h, let provider = CGDataProvider(data: Data(bytes) as CFData) else { return nil }
        return CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: w, space: CGColorSpaceCreateDeviceGray(),
                       bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue), provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
    }
    @ObservationIgnored private var fadeTask: Task<Void, Never>?

    func apply(_ e: ServerEvent.ObserveBoxes) {
        guard e.w > 0, e.h > 0, !e.items.isEmpty else { return }
        if findId != e.findId { boxes = []; highlighted = nil }
        findId = e.findId
        frameSize = CGSize(width: e.w, height: e.h)
        let known = Set(boxes.map(\.id))
        var next: [LiveBox] = []
        var order = 0
        var seen: [String: Int] = [:]
        for item in e.items {
            let key = item.label.lowercased()
            let instance = seen[key, default: 0]; seen[key] = instance + 1
            var live = LiveBox(label: item.label, box: item.box, order: 0, mask: item.mask, instance: instance)
            let isNew = !known.contains(live.id)
            live.order = isNew ? order : 0
            next.append(live)
            if isNew { order += 1 }
        }
        boxes = next
        maskCache = [:]
        if Self.holdEnabled { holdBatch() } else { reveal() }
    }

    /// Chip tapped (or tapped again to let go). Only a chip that has a box lights one (every instance of it).
    func highlight(_ name: String?) {
        let key = name?.lowercased()
        highlighted = key.flatMap { k in boxes.contains { $0.key == k } ? k : nil }
        // a chip tapped while the batch is held keeps the hold (it ends after the companion's sentence, not 4 s later)
        if highlighted != nil { if holding { visible = true } else { reveal() } }
    }

    func clear(stale: Bool = true) {
        endHold()
        fadeTask?.cancel()
        if stale { epoch += 1 }
        boxes = []; highlighted = nil; visible = false; findId = nil; maskCache = [:]
    }

    private func reveal() {
        visible = true
        generation += 1
        fadeTask?.cancel()
        fadeTask = Task { [weak self] in
            try? await Task.sleep(for: self?.fadeAfter ?? .seconds(4))
            guard let self, !Task.isCancelled else { return }
            self.visible = false
        }
    }

    // MARK: demo S3 hold — the masks stay until the companion has said what she sees

    /// How long a batch from the server stays up, in seconds after it landed. On build 9 the masks faded after 4 s and the
    /// companion's "I can see tomato, bell pepper…" came 2–7 s later (s3-b9: boxes 3.6–6.9 s, reply 8.3–11.8 s after
    /// the question). Now: nobody speaks → `cap`. Her next reply starts playing → until it has played (+ `afterSpeech`),
    /// at most `sentence` after it started (the ingredient sentence comes first). Never shorter than `minimum`.
    struct Hold: Equatable {
        var minimum: Double = 4
        var cap: Double = 12
        var sentence: Double = 6
        var afterSpeech: Double = 0.6

        /// `speechStart` / `speechEnd`: seconds after the batch landed (negative = before a later batch of the same find).
        func fadeAt(speechStart: Double?, speechEnd: Double?) -> Double {
            guard let start = speechStart, start < cap else { return cap }
            var end = start + sentence
            if let e = speechEnd { end = min(end, e + afterSpeech) }
            return max(minimum, end)
        }
    }

    /// On by default on iPhone; `GENITA_MASK_HOLD=0` or the `genita.maskHold` default set to false = the 4 s fade as before.
    /// Off on the Mac: it draws no boxes, so its result sheet must never wait for them.
    static var holdEnabled: Bool {
        #if os(iOS)
        if let env = ProcessInfo.processInfo.environment["GENITA_MASK_HOLD"] { return env != "0" }
        return UserDefaults.standard.object(forKey: "genita.maskHold") as? Bool ?? true
        #else
        return false
        #endif
    }

    @ObservationIgnored var hold = Hold()
    /// A batch is up and waiting for the companion's sentence (the Finds sheet stays at peek meanwhile, FindsModel).
    private(set) var holding = false
    /// The hold ended (faded, or the boxes were cleared): FindsModel raises a card that waited at peek.
    @ObservationIgnored var onHoldEnded: (() -> Void)?
    /// A new hold began for this find: FindsModel folds a card that only just rose by itself (card before masks).
    @ObservationIgnored var onHoldStarted: ((String) -> Void)?
    /// `find.started.utteranceId` per find: the turn's own reply ("Ooh, let me see."). Her answer about what she sees is
    /// the server's follow-up reply with a new utteranceId (PROTOCOL.md 11/2), so the ack never counts, however late it plays.
    @ObservationIgnored var ackUtterance: [String: Int] = [:]
    @ObservationIgnored var now: () -> ContinuousClock.Instant = { ContinuousClock.now }
    @ObservationIgnored private var holdFind: String?
    @ObservationIgnored private var landedAt: ContinuousClock.Instant?
    @ObservationIgnored private var speechStart: ContinuousClock.Instant?
    @ObservationIgnored private var speechEnd: ContinuousClock.Instant?
    @ObservationIgnored private var speechUtterance: Int?
    @ObservationIgnored private var playingUtterance: Int?
    /// What was already playing when the hold began ("Let me see."): not the answer about the ingredients.
    @ObservationIgnored private var fillerUtterance: Int?

    /// The companion's voice started playing utterance `id` (CallController, once per utterance).
    func companionStarted(_ id: Int) {
        playingUtterance = id
        guard holding, speechStart == nil, id != fillerUtterance, id != holdFind.flatMap({ ackUtterance[$0] }) else { return }
        speechStart = now(); speechUtterance = id
        scheduleHoldFade()
    }

    /// Utterance `id` finished playing; nil = all playback stopped (cancelled, flushed, call over).
    func companionStopped(_ id: Int?) {
        if id == nil || id == playingUtterance { playingUtterance = nil }
        if id == nil || id == fillerUtterance { fillerUtterance = nil }
        guard holding, let answer = speechUtterance, speechEnd == nil, id == nil || id == answer else { return }
        speechEnd = now()
        scheduleHoldFade()
    }

    private func holdBatch() {
        // another find's batch starts its own hold (the old one's sentence is not this one's)
        if holding, holdFind != findId { endHold() }
        if !holding {
            holding = true
            holdFind = findId
            speechStart = nil; speechEnd = nil; speechUtterance = nil
            fillerUtterance = playingUtterance
            if let findId { onHoldStarted?(findId) }
        }
        landedAt = now()
        visible = true
        generation += 1
        scheduleHoldFade()
    }

    private func scheduleHoldFade() {
        guard holding, let landedAt else { return }
        let at = hold.fadeAt(speechStart: speechStart.map { Self.seconds($0 - landedAt) }, speechEnd: speechEnd.map { Self.seconds($0 - landedAt) })
        let wait = landedAt + .milliseconds(Int(at * 1000)) - now()
        fadeTask?.cancel()
        fadeTask = Task { [weak self] in
            if wait > .zero { try? await Task.sleep(for: wait) }
            guard let self, !Task.isCancelled else { return }
            self.visible = false
            self.endHold()
        }
    }

    private func endHold() {
        guard holding else { return }
        holding = false
        holdFind = nil; landedAt = nil; speechStart = nil; speechEnd = nil; speechUtterance = nil; fillerUtterance = nil
        onHoldEnded?()
    }

    static func seconds(_ d: Duration) -> Double {
        Double(d.components.seconds) + Double(d.components.attoseconds) / 1e18
    }

    /// How far the camera stage moves up so the held boxes clear the Finds sheet (searching / peek, 148 pt): the
    /// boxes' lowest edge goes 12 pt above the sheet, never lifting the highest box (with its 32 pt label) above
    /// `floor`, and never more than the sheet hides at the bottom (the stage's bottom edge stays under the sheet).
    static func stageLift(boxes: [CGRect], sheetTop: CGFloat, viewHeight: CGFloat, floor: CGFloat) -> CGFloat {
        guard let first = boxes.first, sheetTop < viewHeight else { return 0 }
        let union = boxes.dropFirst().reduce(first) { $0.union($1) }
        let need = union.maxY + 12 - sheetTop
        let room = union.minY - 32 - floor
        let hidden = viewHeight - sheetTop - 40
        return max(0, min(need, room, hidden))
    }

    // MARK: geometry

    /// The preview is aspect-fill: the frame is scaled to cover the view and centred, the overflow is cropped.
    /// Normalised box → rect in the view's coordinates (what the user actually sees).
    /// `mirrored`: the front camera's preview is a mirror image of the frame the boxes were found on.
    static func rect(_ b: NormBox, frame: CGSize, in view: CGSize, mirrored: Bool = false) -> CGRect {
        guard frame.width > 0, frame.height > 0 else { return .zero }
        let b = mirrored ? NormBox(x1: 1 - b.x2, y1: b.y1, x2: 1 - b.x1, y2: b.y2) : b
        let scale = max(view.width / frame.width, view.height / frame.height)
        let w = frame.width * scale, h = frame.height * scale
        let ox = (view.width - w) / 2, oy = (view.height - h) / 2
        return CGRect(x: ox + b.x1 * w, y: oy + b.y1 * h, width: (b.x2 - b.x1) * w, height: (b.y2 - b.y1) * h)
    }

    /// Label height 28 + 4 gap above the box; below it when the box is too near the top of the view.
    static func labelAbove(_ rect: CGRect, topInset: CGFloat) -> Bool { rect.minY - 32 >= topInset }

    /// Label offset from the box top. Never lets the label sit above `topInset` (HUD r01 A: the menu row band, safe top
    /// + 60, where the status pill and menu button are): no room above → inside the box's top (6 pt); the box itself
    /// reaches into the band → under the box (6 pt). The pill never moves for a label.
    static func labelOffsetY(_ rect: CGRect, topInset: CGFloat) -> CGFloat {
        if labelAbove(rect, topInset: topInset) { return -32 }
        if rect.minY >= topInset { return 6 }
        return max(rect.height + 6, topInset - rect.minY)
    }

    /// A box that ends above the status/menu area has nothing to show (its label would float over the menu button).
    static func aboveView(_ rect: CGRect, topInset: CGFloat) -> Bool { rect.maxY <= topInset }

    /// FT-NOSEE: a box (with its label) under the card is not drawn, so the card stays readable.
    static func hidden(_ rect: CGRect, avoiding card: CGRect?) -> Bool {
        guard let card else { return false }
        return rect.insetBy(dx: -2, dy: -32).intersects(card)
    }
}
