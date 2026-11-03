import SwiftUI
import UIKit

// F5-U-CAM · CAM-H (full-flow board r01 §6): the camera is the stage, the companion's face is a 96 × 128 window at the
// top right, and the boxes the server found sit on the live preview. A box pops in over 240 ms, 60 ms after the one
// before; its label is above it (below when there is no room); all fade after 4 s. A tapped ingredient chip lights its box.
// Colours: `.box` border --blue-on-ink 2 px, radius 12, fill rgba(84,193,255,.16); label = pill 28 pt, 12/16 medium.

struct CameraStage: View {
    let call: CallController
    let size: CGSize
    let topInset: CGFloat

    var body: some View {
        ZStack {
            CallInk.ink
            preview
            // r01 `.camtop`: 136 pt dim so the status bar and the menu button read on any scene
            VStack(spacing: 0) {
                LinearGradient(colors: [CallInk.dim, .clear], startPoint: .top, endPoint: .bottom).frame(height: 136 + topInset)
                Spacer(minLength: 0)
            }.allowsHitTesting(false)
            CameraBoxOverlay(boxes: call.finds.boxes, mirrored: mirrored, topInset: 96 + topInset, avoid: noSeeRect,
                             // demo S3 option (c): labels keep clear of the menu button, the status line and the self-view PiP
                             labelObstacles: [CameraBoxes.menuRect(top: topInset), CameraBoxes.statusRect(view: size, top: topInset), CameraBoxes.railRect(view: size, sheet: call.finds.state),
                                              CameraBoxes.pipRect(view: size, top: topInset, sheetHalf: call.finds.state == .half || call.finds.state == .rising)])
        }
        .frame(width: size.width, height: size.height).clipped()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Your camera")
        .accessibilityIdentifier("cameraStage")
    }

    /// FT-NOSEE card (24, 124): boxes under it are left out.
    private var noSeeRect: CGRect? {
        guard let check = call.finds.noSee, call.finds.state == .idle || call.finds.state == .dismissed else { return nil }
        return CGRect(x: 24, y: 124 + topInset, width: 220, height: check.cardHeight)
    }

    private var mirrored: Bool {
        #if DEBUG
        if call.camera.fixture != nil { return false }
        #endif
        return call.cameraFront
    }

    @ViewBuilder private var preview: some View {
        #if DEBUG
        if let still = call.camera.fixture {
            Image(decorative: still, scale: 1).resizable().scaledToFill().frame(width: size.width, height: size.height).clipped()
        } else { SelfCameraView(session: call.cameraSession).frame(width: size.width, height: size.height) }
        #else
        SelfCameraView(session: call.cameraSession).frame(width: size.width, height: size.height)
        #endif
    }
}

struct CameraBoxOverlay: View {
    let boxes: CameraBoxes
    let mirrored: Bool
    let topInset: CGFloat
    var avoid: CGRect? = nil
    var labelObstacles: [CGRect] = []

    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .topLeading) {
                // r03 `.a[data-sel] img { filter: brightness(.6) }`: the scene steps back behind the lit box
                Color.black.opacity(boxes.highlighted != nil ? 0.4 : 0).allowsHitTesting(false)
                // `topInset` here is 96 + safe top; the avoid rect is in the same screen space
                let drawn = boxes.boxes.map { (item: $0, rect: CameraBoxes.rect($0.box, frame: boxes.frameSize, in: g.size, mirrored: mirrored)) }
                    .filter { !CameraBoxes.hidden($0.rect, avoiding: avoid) && !CameraBoxes.aboveView($0.rect, topInset: topInset) }
                let labeled = CameraBoxes.labelOwners(drawn)
                let origins = CameraBoxes.labelOrigins(drawn.filter { labeled.contains($0.item.id) }.map { (id: $0.item.id, rect: $0.rect, label: Self.labelSize($0.item.label)) },
                                                       view: g.size, topInset: topInset, obstacles: labelObstacles)
                ForEach(drawn, id: \.item.id) { d in
                    let mask = CameraBoxes.masksEnabled ? boxes.maskImages(for: d.item) : nil
                    PopBox(item: d.item, rect: d.rect, size: g.size, topInset: topInset, lit: boxes.highlighted == d.item.key,
                           dimmed: boxes.highlighted != nil && boxes.highlighted != d.item.key,
                           showsLabel: labeled.contains(d.item.id),
                           mask: mask, mirrored: mirrored,
                           // boxes and masks alike: the pill moves off the menu button, the status line and the PiP
                           // (labelOrigin tries the box rule's spot first, so a label in free space doesn't move)
                           labelAt: origins[d.item.id])
                }
            }
            .opacity(boxes.visible ? 1 : 0)
            .animation(.fade, value: boxes.visible)
            .animation(.fade, value: boxes.highlighted)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .accessibilityIdentifier("cameraBoxes")
    }

    /// The pill's size: 12 pt medium text + 8 pt sides, 28 pt tall.
    static func labelSize(_ text: String) -> CGSize {
        let font = UIFont(name: "PretendardVariable-Medium", size: 12) ?? .systemFont(ofSize: 12, weight: .medium)
        return CGSize(width: ceil((text as NSString).size(withAttributes: [.font: font]).width) + 16, height: 28)
    }
}

private struct PopBox: View {
    let item: LiveBox
    let rect: CGRect
    let size: CGSize
    let topInset: CGFloat
    let lit: Bool
    let dimmed: Bool
    /// one pill per ingredient (CameraBoxes.labelOwners); always true without repeated labels
    var showsLabel = true
    /// Demo S3 (flag, off by default): the SAM pixel mask drawn instead of the box — soft translucent fill + thin outline.
    var mask: (fill: CGImage, edge: CGImage)? = nil
    var mirrored = false
    /// absolute origin of the label pill (masks only); nil = the box rule
    var labelAt: CGPoint? = nil
    @State private var shown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack(alignment: .topLeading) {
            if let mask {
                // a light, neutral fill (red-on-red vanishes on tomatoes) and a blue outline, both from the mask grid
                Color.white.opacity(lit ? 0.45 : 0.25)
                    .mask(Image(decorative: mask.fill, scale: 1).resizable().interpolation(.high).luminanceToAlpha().blur(radius: 2))
                    .scaleEffect(x: mirrored ? -1 : 1, y: 1)
                CallInk.blueOnInk
                    .mask(Image(decorative: mask.edge, scale: 1).resizable().interpolation(.high).luminanceToAlpha().blur(radius: 0.6))
                    .scaleEffect(x: mirrored ? -1 : 1, y: 1)
            } else {
                RoundedRectangle(cornerRadius: 12).fill(CallInk.blueOnInk.opacity(lit ? 0.3 : 0.16))
                RoundedRectangle(cornerRadius: 12).strokeBorder(CallInk.blueOnInk, lineWidth: 2)
            }
            if showsLabel {
            Text(item.label).font(TypeStyle.body(12, .medium)).foregroundStyle(CallInk.onInk).lineLimit(1).fixedSize()
                .padding(.horizontal, 8).frame(height: 28)
                .background(CallInk.pill, in: RoundedRectangle(cornerRadius: 12))
                .offset(x: labelAt.map { $0.x - rect.minX } ?? max(-2, -rect.minX), y: labelAt.map { $0.y - rect.minY } ?? CameraBoxes.labelOffsetY(rect, topInset: topInset))
                .accessibilityIdentifier("boxLabel-\(item.label)")
            }
        }
        .frame(width: max(8, rect.width), height: max(8, rect.height), alignment: .topLeading)
        .scaleEffect(shown || reduceMotion ? 1 : 0.97)
        .opacity((shown || reduceMotion ? 1 : 0) * (dimmed ? 0 : 1))
        .offset(x: rect.minX, y: rect.minY)
        .task {
            if reduceMotion { shown = true; return }
            try? await Task.sleep(for: .milliseconds(60 * item.order))
            withAnimation(.easeOut(duration: 0.24)) { shown = true }
        }
    }
}
