import CoreGraphics
import Foundation
import Observation

// F5-U-CAM · CAM-H: the boxes the server finds on a camera frame (`observe.boxes`, 0–1 of that frame) drawn over the
// live preview. Each box pops in (240 ms, 60 ms apart), the label sits above the box (below when there is no room),
// everything fades after 4 s, and a tapped ingredient chip lights its box (and brings the boxes back for 4 s).

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

    /// CameraStage space: the menu button (ConversationView: 47 pt at (47.5, 86.5 + top)), padded 6 pt.
    static func menuRect(top: CGFloat) -> CGRect { CGRect(x: 24 - 6, y: 63 + top - 6, width: 47 + 12, height: 47 + 12) }
    /// The self-view PiP (96 × 128 at y 184 + top; right edge 20 pt, or left while the sheet is half up), padded 6 pt.
    static func pipRect(view: CGSize, top: CGFloat, sheetHalf: Bool) -> CGRect {
        let midX = sheetHalf ? 68 : view.width - 68
        return CGRect(x: midX - 48 - 6, y: 184 + top - 64 - 6, width: 96 + 12, height: 128 + 12)
    }

    /// Where a label pill goes (absolute origin), keeping clear of `obstacles` (menu button, PiP). Tried in order:
    /// above the box at its left edge (where boxes put it), below it, inside its top, then each of those slid beside
    /// the obstacle it hits. Never above `topInset`, never off screen. Nothing fits: the box rule (above / below).
    static func labelOrigin(_ rect: CGRect, label: CGSize, view: CGSize, topInset: CGFloat, obstacles: [CGRect]) -> CGPoint {
        let ys = [rect.minY - label.height - 4, rect.maxY + 4, rect.minY + 4]
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
        reveal()
    }

    /// Chip tapped (or tapped again to let go). Only a chip that has a box lights one (every instance of it).
    func highlight(_ name: String?) {
        let key = name?.lowercased()
        highlighted = key.flatMap { k in boxes.contains { $0.key == k } ? k : nil }
        if highlighted != nil { reveal() }
    }

    func clear(stale: Bool = true) {
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

    /// Label offset from the box top. Never lets the label sit above `topInset` (status bar, menu button): a box that
    /// starts off the top edge gets its label pushed down instead of onto the clock.
    static func labelOffsetY(_ rect: CGRect, topInset: CGFloat) -> CGFloat {
        let y = labelAbove(rect, topInset: topInset) ? -32 : rect.height + 4
        return max(y, topInset - rect.minY)
    }

    /// A box that ends above the status/menu area has nothing to show (its label would float over the menu button).
    static func aboveView(_ rect: CGRect, topInset: CGFloat) -> Bool { rect.maxY <= topInset }

    /// FT-NOSEE: a box (with its label) under the card is not drawn, so the card stays readable.
    static func hidden(_ rect: CGRect, avoiding card: CGRect?) -> Bool {
        guard let card else { return false }
        return rect.insetBy(dx: -2, dy: -32).intersects(card)
    }
}
