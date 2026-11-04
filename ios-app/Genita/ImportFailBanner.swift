import SwiftUI

/// AU-15 (IM-02): the import failed after "Continue in the background". 춘식이 import-fail F1
/// (`./_qa-scripts/genita-splash/import-fail/index.html`): y 106, sides 16, white card r16, 1 pt #EDEDED,
/// shadow 0 8 24 10 %, padding 14/14/14/16; 24 pt #FBE3B4 circle with "!" #8A4B00; stays until "Paste again",
/// "Not now" or a swipe up.
struct ImportFailBanner: View {
    let onPaste: () -> Void
    let onDismiss: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Not over I01–I03 (the import's own screens show it), sign-in, consent, or the call.
    static func shows(on stage: Stage) -> Bool {
        ![.welcome, .signIn, .consent, .name, .prompt, .paste, .preparing, .connecting, .conversation].contains(stage)
    }

    private static let warnDot = Color(red: 251 / 255, green: 227 / 255, blue: 180 / 255)
    private static let warnText = Color(red: 138 / 255, green: 75 / 255, blue: 0)
    private static let blueText = Color(red: 0, green: 99 / 255, blue: 159 / 255)
    private static let mute = Color(red: 115 / 255, green: 115 / 255, blue: 115 / 255)

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                Circle().fill(Self.warnDot).frame(width: 24, height: 24)
                    .overlay(Text("!").font(TypeStyle.body(15, .bold)).foregroundStyle(Self.warnText)).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("I couldn’t read your AI reply.").font(TypeStyle.body(15, .semibold)).foregroundStyle(Color(white: 0.067))
                        .accessibilityAddTraits(.isHeader)
                    Text("Your answers still work. Paste it again when you’re ready.").font(TypeStyle.body(13)).foregroundStyle(Self.mute)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 18) {
                        Button(action: onPaste) { Text("Paste again").font(TypeStyle.body(15, .semibold)).foregroundStyle(Self.blueText).frame(minHeight: 44) }
                            .buttonStyle(.plain).accessibilityIdentifier("importFailPaste")
                        Button(action: onDismiss) { Text("Not now").font(TypeStyle.body(15, .medium)).foregroundStyle(Self.mute).frame(minHeight: 44) }
                            .buttonStyle(.plain).accessibilityIdentifier("importFailDismiss")
                    }
                    .padding(.top, 4)
                }
                Spacer(minLength: 0)
            }
            .padding(.top, 14).padding(.bottom, 4).padding(.leading, 16).padding(.trailing, 14)
            .background(Color.white, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color(red: 237 / 255, green: 237 / 255, blue: 237 / 255), lineWidth: 1))
            .shadow(color: .black.opacity(0.10), radius: 12, y: 8)
            .padding(.horizontal, 16)
            .gesture(DragGesture(minimumDistance: 12).onEnded { v in if v.translation.height < -20 { onDismiss() } })
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("importFailBanner")
            .onAppear { UIAccessibility.post(notification: .announcement, argument: "I couldn’t read your AI reply.") }
            Spacer(minLength: 0)
        }
        // y 106 on the 390 × 844 frame, measured from the screen's top edge
        .padding(.top, 106)
        .ignoresSafeArea(edges: .top)
    }
}
