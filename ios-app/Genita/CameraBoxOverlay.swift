import SwiftUI

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
            CameraBoxOverlay(boxes: call.finds.boxes, mirrored: mirrored, topInset: 96 + topInset)
        }
        .frame(width: size.width, height: size.height).clipped()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Your camera")
        .accessibilityIdentifier("cameraStage")
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

    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .topLeading) {
                // r03 `.a[data-sel] img { filter: brightness(.6) }`: the scene steps back behind the lit box
                Color.black.opacity(boxes.highlighted != nil ? 0.4 : 0).allowsHitTesting(false)
                ForEach(boxes.boxes) { item in
                    let rect = CameraBoxes.rect(item.box, frame: boxes.frameSize, in: g.size, mirrored: mirrored)
                    PopBox(item: item, rect: rect, size: g.size, topInset: topInset, lit: boxes.highlighted == item.id,
                           dimmed: boxes.highlighted != nil && boxes.highlighted != item.id)
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
}

private struct PopBox: View {
    let item: LiveBox
    let rect: CGRect
    let size: CGSize
    let topInset: CGFloat
    let lit: Bool
    let dimmed: Bool
    @State private var shown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let above = CameraBoxes.labelAbove(rect, topInset: topInset)
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 12).fill(CallInk.blueOnInk.opacity(lit ? 0.3 : 0.16))
            RoundedRectangle(cornerRadius: 12).strokeBorder(CallInk.blueOnInk, lineWidth: 2)
            Text(item.label).font(TypeStyle.body(12, .medium)).foregroundStyle(CallInk.onInk).lineLimit(1).fixedSize()
                .padding(.horizontal, 8).frame(height: 28)
                .background(CallInk.pill, in: RoundedRectangle(cornerRadius: 12))
                .offset(x: -2, y: above ? -32 : rect.height + 4)
                .accessibilityIdentifier("boxLabel-\(item.label)")
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
