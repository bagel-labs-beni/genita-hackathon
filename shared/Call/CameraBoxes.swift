import CoreGraphics
import Foundation
import Observation

// F5-U-CAM · CAM-H: the boxes the server finds on a camera frame (`observe.boxes`, 0–1 of that frame) drawn over the
// live preview. Each box pops in (240 ms, 60 ms apart), the label sits above the box (below when there is no room),
// everything fades after 4 s, and a tapped ingredient chip lights its box (and brings the boxes back for 4 s).

struct LiveBox: Identifiable, Equatable {
    var id: String { label.lowercased() }
    var label: String
    var box: NormBox
    /// Order the box popped in within its batch (drives the 60 ms stagger).
    var order: Int
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
    @ObservationIgnored private var fadeTask: Task<Void, Never>?

    func apply(_ e: ServerEvent.ObserveBoxes) {
        guard e.w > 0, e.h > 0, !e.items.isEmpty else { return }
        if findId != e.findId { boxes = []; highlighted = nil }
        findId = e.findId
        frameSize = CGSize(width: e.w, height: e.h)
        let known = Set(boxes.map(\.id))
        var next: [LiveBox] = []
        var order = 0
        for item in e.items {
            let isNew = !known.contains(item.label.lowercased())
            next.append(LiveBox(label: item.label, box: item.box, order: isNew ? order : 0))
            if isNew { order += 1 }
        }
        boxes = next
        reveal()
    }

    /// Chip tapped (or tapped again to let go). Only a chip that has a box lights one.
    func highlight(_ name: String?) {
        let key = name?.lowercased()
        highlighted = key.flatMap { k in boxes.contains { $0.id == k } ? k : nil }
        if highlighted != nil { reveal() }
    }

    func clear(stale: Bool = true) {
        fadeTask?.cancel()
        if stale { epoch += 1 }
        boxes = []; highlighted = nil; visible = false; findId = nil
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
