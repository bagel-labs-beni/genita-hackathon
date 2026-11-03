import SwiftUI
import AppKit

/// Mac call ink, type and the call pill — standalone (no call model) so `Tools/watch-shots/check.sh` can render
/// and measure the pill (#211).
enum MacSheetInk {
    static let ink = Color(white: 17.0 / 255)
    static let sheet = Color(white: 254.0 / 255)
    static let onInk = Color(white: 253.0 / 255)
    static let mute = Color(white: 115.0 / 255)
    static let faint = Color(white: 158.0 / 255)
    static let line = Color(white: 232.0 / 255)
    static let handle = Color(white: 219.0 / 255)
    static let chip = Color(white: 242.0 / 255)
    static let chipBlue = Color(red: 222.0 / 255, green: 243.0 / 255, blue: 1)
    static let chipBlueText = Color(red: 0, green: 106.0 / 255, blue: 163.0 / 255)
    static let scan = Color(red: 0, green: 179.0 / 255, blue: 1)
    static let pill = Color(white: 17.0 / 255).opacity(0.84)
    static func sans(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .custom("PretendardVariable-" + (weight == .medium ? "Medium" : weight == .semibold ? "SemiBold" : "Regular"), fixedSize: size)
    }
    static func serif(_ size: CGFloat) -> Font { .custom("KMUTTF-SungkokSemiSerif", fixedSize: size) }
}

/// Ink in glass, the iPhone #414 GlassCTA structure: an ink fill over tinted Liquid Glass. In a key window the fill is
/// 55 % (same as the iPhone). In a non-key window (the call window is never key) tinted glass washes out to light
/// grey (build 171), so the fill goes to 88 % and the ink holds near #111 while the glass rim stays.
enum MacInkGlass {
    static func fillOpacity(_ state: ControlActiveState) -> Double { state == .inactive ? 0.88 : 0.55 }
}

/// Pills over the companion's face (call cue, sharing chip, hover label): ink in glass (MacInkGlass). Before macOS 26
/// the 84 % ink pill. Lives here so the cue checks, which compile this file alone, build.
struct MacDarkGlass<S: Shape>: ViewModifier {
    var shape: S
    @Environment(\.controlActiveState) private var activeState
    /// MA-04: the pills float over the animated face; live glass there re-samples every frame. The 84 % ink pill
    /// (Figma) is the same look as a still, without the per-frame cost.
    func body(content: Content) -> some View {
        content.background(MacSheetInk.pill, in: shape)
    }
}
extension View {
    func macDarkGlass<S: Shape>(in shape: S) -> some View { modifier(MacDarkGlass(shape: shape)) }
}

/// The call's status pill (S09), Mac copy of the iPhone's cue: "Listening", "{name} is talking"…
/// At full sheet it carries the card's spoken line (server `card.say`), as MAC-RS-b shows.
/// **Always one line (#211, Chelsea 11/3):** the whole line when it fits, else its first sentence
/// (`CueLine.summaries`), else whole words + "…" (`OneLineText`). VoiceOver reads the whole line.
struct MacCallCue: View {
    let text: String
    var wave = true
    /// One line of Pretendard 14 medium plus the pill's 8 + 8 padding (render check in Tools/watch-shots).
    static let oneLineHeight: CGFloat = 34
    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            if wave { MacTalkWave(color: MacSheetInk.onInk) }
            OneLineText(text: text, font: MacSheetInk.sans(14, .medium), color: MacSheetInk.onInk, alternates: CueLine.summaries(text))
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .macDarkGlass(in: RoundedRectangle(cornerRadius: 18))
        .accessibilityElement(children: .combine).accessibilityIdentifier("macCallCue")
    }
}

/// Four 2 × 12 bars (the board's talk wave).
struct MacTalkWave: View {
    var color: Color
    @State private var phase = false
    var body: some View {
        HStack(spacing: 2) {
            ForEach(0..<4, id: \.self) { i in
                Capsule().fill(color).frame(width: 2, height: 12).scaleEffect(y: phase ? [0.5, 1, 0.7, 0.9][i] : [1, 0.6, 1, 0.5][i])
            }
        }.frame(width: 14, height: 12)
        .onAppear {
            guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion, ProcessInfo.processInfo.environment["GENITA_MAC_REVIEW_OUT"] == nil else { return }
            withAnimation(.easeInOut(duration: 0.5).repeatForever(autoreverses: true)) { phase = true }
        }
        .accessibilityHidden(true)
    }
}

