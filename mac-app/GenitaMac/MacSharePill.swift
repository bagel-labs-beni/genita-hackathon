import SwiftUI
import AppKit

/// The call window's Share screen control, r01 (Chelsea OK 11/4; spec ./_qa-scripts/genita-design/share-screen-spec.md).
/// One 34 pt glass capsule that always carries its words — the old clear circle washed out on light video and its
/// label only showed on hover. Idle "Share screen" · starting (permission sheet or the macOS picker open) a spinner
/// and "Choose a window" · sharing red tinted glass, a pulsing live dot and "Stop sharing".
struct MacSharePill: View {
    enum Phase: Equatable { case idle, starting, sharing }
    var phase: Phase
    var action: () -> Void
    /// review renders only: pin the hover look
    var reviewHover = false
    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let height: CGFloat = MacCallCue.oneLineHeight // 34
    static let red = Color(red: 231.0 / 255, green: 32.0 / 255, blue: 12.0 / 255)     // #E7200C
    static let redHover = Color(red: 201.0 / 255, green: 26.0 / 255, blue: 9.0 / 255)  // #C91A09
    static func label(_ phase: Phase) -> String {
        switch phase { case .idle: "Share screen"; case .starting: "Choose a window"; case .sharing: "Stop sharing" }
    }
    static func voiceOver(_ phase: Phase) -> String {
        switch phase { case .idle: "Share screen"; case .starting: "Choosing a window to share"; case .sharing: "Stop screen sharing" }
    }

    private var hover: Bool { hovering || reviewHover }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                glyph
                Text(Self.label(phase)).font(.custom("PretendardVariable-SemiBold", fixedSize: 14)).foregroundStyle(.white)
                    .lineLimit(1).fixedSize()
                    .id(phase).transition(.opacity.animation(.easeOut(duration: 0.15)))
            }
            .padding(.leading, 12).padding(.trailing, 14).frame(height: Self.height)
            .background { material }
            .overlay(Capsule().strokeBorder(LinearGradient(colors: phase == .sharing ? [.white.opacity(0.35)] : [.white.opacity(0.40), .white.opacity(0.06), .white.opacity(0.32)],
                                                           startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 0.7))
            .clipShape(Capsule())
            .shadow(color: .black.opacity(0.22), radius: 5, y: 2) // 0 2 10 black 22 %
            .contentShape(Capsule())
        }
        .buttonStyle(MacSharePillPress())
        .onHover { on in withAnimation(.easeOut(duration: 0.15)) { hovering = on } }
        .pointerStyle(.link)
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.3, dampingFraction: 0.9), value: phase)
        .accessibilityLabel(Self.voiceOver(phase))
        .accessibilityIdentifier("macShareScreen")
    }

    @ViewBuilder private var glyph: some View {
        switch phase {
        case .starting: MacShareSpinner().frame(width: 16, height: 16)
        // the dot sits inline (no 16 pt slot): 12 pt before it, 8 pt to the words (design review 11/4)
        case .sharing: MacShareLiveDot()
        case .idle: resourceImage("glass-share-icon").resizable().scaledToFit().frame(width: 16, height: 16)
        }
    }

    @ViewBuilder private var material: some View {
        if phase == .sharing {
            // the MacGlassControl.tinted structure: red ink in glass (CEO 11/3), never a flat filled disc
            let tint = hover ? Self.redHover : Self.red
            if #available(macOS 26.0, *) { Capsule().fill(tint.opacity(0.92)).glassEffect(.regular.tint(tint), in: Capsule()) }
            else { Capsule().fill(tint) }
        } else {
            // the call cue's own material (about 60 % black over video; an extra 0.55 fill made it near-opaque,
            // design review 11/4). White text over white video stays above 4.5:1. Hover darkens by 13 points.
            Capsule().fill(Color.black.opacity(hover ? 0.13 : 0)).macDarkGlass(in: Capsule())
        }
    }
}

/// Pressed: 0.96 for 120 ms.
private struct MacSharePillPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.scaleEffect(configuration.isPressed ? 0.96 : 1).animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

/// 13 pt, 1.6 pt stroke, white 30 % track, white head, one turn per 0.9 s (Reduce Motion: the track and a still head).
struct MacShareSpinner: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        TimelineView(.animation(paused: reduceMotion)) { context in
            let turn = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 0.9) / 0.9
            ZStack {
                Circle().stroke(.white.opacity(0.3), lineWidth: 1.6)
                Circle().trim(from: 0, to: 0.28).stroke(.white, style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
                    .rotationEffect(.degrees(reduceMotion ? 0 : turn * 360))
            }.frame(width: 13, height: 13)
        }
    }
}

/// 8 pt white dot, opacity 1 ↔ 0.45 over 1.6 s (Reduce Motion: solid).
struct MacShareLiveDot: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        TimelineView(.animation(paused: reduceMotion)) { context in
            let t = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.6) / 1.6
            let wave = (1 - cos(t * 2 * .pi)) / 2 // ease-in-out 0 → 1 → 0
            Circle().fill(.white).frame(width: 8, height: 8).opacity(reduceMotion ? 1 : 1 - 0.55 * wave)
        }
    }
}
