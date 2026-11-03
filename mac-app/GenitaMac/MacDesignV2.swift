import SwiftUI
import AppKit

/// To-be designs waiting for Chelsea's OK (11/3). Off by default: the shipped flow is unchanged until a flag
/// flips. Turn on with `defaults write ai.thebeni.genita.mac genita.mac.designV2 -bool YES` (or env
/// GENITA_MAC_DESIGN_V2=1); after the OK the default becomes true in one line.
/// Design: Figma rp1wR9pxV0IsgyjvOcwo92 page "Mac v2 (11/3)" (282:2), source
/// ./genita-hackathon/design-mac-v2/revisions/r01. Every Mac v2 value below comes from that contract.
enum MacDesignV2 {
    static var enabled: Bool {
        #if DEBUG
        if let review = reviewOverride { return review }
        #endif
        // Chelsea 11/3: Mac v2 approved — on by default; GENITA_MAC_DESIGN_V2=0 or the default key = NO turns it off
        if let v = ProcessInfo.processInfo.environment["GENITA_MAC_DESIGN_V2"] { return v != "0" }
        return UserDefaults.standard.object(forKey: "genita.mac.designV2") as? Bool ?? true
    }
    /// True only while the watch-shots harness renders review PNGs (ImageRenderer can't draw AppKit views).
    static var reviewRender: Bool {
        #if DEBUG
        return reviewOverride != nil
        #else
        return false
        #endif
    }
    #if DEBUG
    /// review renders only (watch-shots harness)
    nonisolated(unsafe) static var reviewOverride: Bool?
    #endif

    // Mac v2 system (contract.json): home window 420, 32 sides, serif 28 title → status row → body 15 → 50 pt buttons.
    static let blue = Color(red: 0, green: 162.0 / 255, blue: 1)
    static let outline = Color(white: 227.0 / 255)
    static let faint = Color(white: 158.0 / 255)
    static let terms = "https://bagel-labs-beni.github.io/genita-legal/terms/"
    static let privacy = "https://bagel-labs-beni.github.io/genita-legal/privacy/"
}

/// The one title style of every Mac v2 window and sheet: KMU Sungkok 28/34, a full sentence with a period.
struct MacV2Title: View {
    let text: String
    var body: some View {
        Text(text).font(MacSheetInk.serif(28)).tracking(-0.28).foregroundStyle(MacSheetInk.ink)
            .lineLimit(1).fixedSize(horizontal: true, vertical: false).frame(height: 34, alignment: .leading)
            .accessibilityAddTraits(.isHeader)
    }
}

/// The status row under every home title: an 8 pt dot (live blue / off grey) or the 16 pt waiting ring, then
/// one line of 14 pt mute text. Always one line (QA #211).
struct MacV2Status: View {
    enum Kind { case live, waiting, idle }
    let text: String
    var kind: Kind = .live
    var id: String? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var spin = false
    var body: some View {
        HStack(spacing: 8) {
            Group {
                switch kind {
                case .live, .idle:
                    Circle().fill(kind == .live ? MacDesignV2.blue : MacDesignV2.faint).frame(width: 8, height: 8)
                case .waiting:
                    ZStack {
                        Circle().stroke(MacDesignV2.outline, lineWidth: 1.6)
                        Circle().trim(from: 0, to: 0.25).stroke(MacSheetInk.ink, style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
                            .rotationEffect(.degrees(spin ? 270 : -90))
                    }.frame(width: 14.4, height: 14.4)
                    .onAppear {
                        guard !reduceMotion, !MacDesignV2.reviewRender else { return }
                        withAnimation(.linear(duration: 1).repeatForever(autoreverses: false)) { spin = true }
                    }
                }
            }.frame(width: 16, height: 16)
            Text(text).font(MacSheetInk.sans(14)).foregroundStyle(MacSheetInk.mute).lineLimit(1)
        }
        .frame(height: 20)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(id ?? "macStatus")
    }
}

/// Buttons of the Mac v2 set, Liquid Glass on macOS 26 (CEO 11/3: "Apple-style glass, not flat stamps"):
/// primary = ink-tinted glass, secondary = clear glass, both 50 tall and 12 round (the Figma radius, same as the
/// iPhone's GlassCTA #414) with hover and press states; text = 44 tall, 15 medium ink. Before macOS 26 they fall back
/// to ink fill / white + 1 pt outline.
struct MacV2Button: View {
    enum Style { case primary, secondary, text }
    let label: String
    var style: Style = .primary
    var icon: Image? = nil
    var loading = false
    var id: String
    let action: () -> Void
    @Environment(\.isEnabled) private var isEnabled
    /// Disabled primary drops the ink tint and shows mute text (white on a 28 % ink fill was unreadable, A02-M "Send code").
    private var labelColor: Color {
        switch style {
        case .primary: isEnabled ? MacSheetInk.onInk : MacSheetInk.mute
        case .secondary, .text: isEnabled ? MacSheetInk.ink : MacSheetInk.mute
        }
    }
    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if loading { ProgressView().controlSize(.small).tint(labelColor) }
                else {
                    if let icon { icon.resizable().scaledToFit().frame(width: 15, height: 18) }
                    Text(label)
                }
            }
            .font(MacSheetInk.sans(style == .text ? 15 : 16, .medium))
            .foregroundStyle(labelColor)
            .lineLimit(1)
            .frame(maxWidth: style == .text ? nil : .infinity).frame(height: style == .text ? 44 : 50)
            .padding(.horizontal, style == .text ? 12 : 20)
            .contentShape(RoundedRectangle(cornerRadius: 12))
        }.buttonStyle(MacGlassButtonStyle(kind: style == .primary ? .prominent : style == .secondary ? .regular : .plain))
            .accessibilityIdentifier(id)
    }
}

/// One button look for every Mac surface: Liquid Glass, 12 round (macOS 26), with hover lift and press squeeze.
struct MacGlassButtonStyle: ButtonStyle {
    enum Kind { case prominent, regular, plain }
    var kind: Kind
    var tint: Color = MacSheetInk.ink
    func makeBody(configuration: Configuration) -> some View {
        MacGlassButtonBody(label: configuration.label, kind: kind, tint: tint, pressed: configuration.isPressed)
    }
}

private struct MacGlassButtonBody<Label: View>: View {
    let label: Label
    let kind: MacGlassButtonStyle.Kind
    let tint: Color
    let pressed: Bool
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.controlActiveState) private var activeState
    @State private var hover = false
    var body: some View {
        surface
            .scaleEffect(pressed && isEnabled ? 0.98 : 1)
            .onHover { hover = $0 }
            .animation(.easeOut(duration: 0.12), value: pressed)
            .animation(.easeOut(duration: 0.15), value: hover)
    }
    @ViewBuilder private var surface: some View {
        switch kind {
        case .plain:
            label.opacity(pressed ? 0.6 : 1).background(Capsule().fill(MacSheetInk.ink.opacity(hover && isEnabled ? 0.05 : 0)))
        case .prominent, .regular:
            if #available(macOS 26.0, *) {
                // prominent = ink in glass, the iPhone GlassCTA (#414) structure; MacInkGlass holds the ink in non-key windows
                label.background { if kind == .prominent && isEnabled { shape.fill(tint.opacity(MacInkGlass.fillOpacity(activeState))) } }
                    .glassEffect(glass, in: shape)
                    .brightness(hover && isEnabled && kind == .prominent ? 0.08 : 0)
                    .animation(.easeOut(duration: 0.2), value: activeState)
            } else {
                label.background {
                    if kind == .prominent && isEnabled { shape.fill(tint).brightness(hover ? 0.08 : 0) }
                    else { shape.fill(Color.white).overlay(shape.strokeBorder(hover && isEnabled ? MacSheetInk.faint : MacDesignV2.outline, lineWidth: 1)) }
                }
            }
        }
    }
    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: 12, style: .continuous) }
    @available(macOS 26.0, *) private var glass: Glass {
        kind == .prominent && isEnabled ? .regular.tint(tint).interactive(isEnabled) : .regular.interactive(isEnabled)
    }
}

/// One legal sentence with inline Terms and Privacy Policy links (13 pt mute, links ink + underline).
struct MacV2Legal: View {
    var prefix = "By continuing, you agree to our "
    var body: some View {
        Text(attributed).font(MacSheetInk.sans(13)).foregroundStyle(MacSheetInk.mute).lineSpacing(2)
            .fixedSize(horizontal: false, vertical: true).frame(width: 356, alignment: .leading)
            .tint(MacSheetInk.ink).accessibilityIdentifier("macLegal")
    }
    private var attributed: AttributedString {
        var s = AttributedString(prefix)
        var terms = AttributedString("Terms"); terms.link = URL(string: MacDesignV2.terms)
        var privacy = AttributedString("Privacy Policy"); privacy.link = URL(string: MacDesignV2.privacy)
        terms.swiftUI.foregroundColor = MacSheetInk.ink; terms.swiftUI.underlineStyle = .single
        privacy.swiftUI.foregroundColor = MacSheetInk.ink; privacy.swiftUI.underlineStyle = .single
        s += terms; s += AttributedString(" and "); s += privacy; s += AttributedString(".")
        return s
    }
}

/// Six 50 × 56 boxes split 3 · 3 (P01's field). `focus` outlines the next box while typing.
struct MacV2CodeBoxes: View {
    let code: String
    var focus: Int? = nil
    var body: some View {
        let chars = Array(code.prefix(6))
        HStack(spacing: 8) {
            ForEach(0..<6, id: \.self) { i in
                if i == 3 { Capsule().fill(MacSheetInk.handle).frame(width: 10, height: 2).padding(.horizontal, 2) }
                Text(i < chars.count ? String(chars[i]) : "")
                    .font(MacSheetInk.sans(24, .medium)).foregroundStyle(MacSheetInk.ink).monospacedDigit()
                    // 6 × 49 + the 14 pt dash + 6 gaps × 8 = 356 = the 420 window minus 32 + 32 (50 overflowed by 6 pt, Mac QA 11/3)
                    .frame(width: 49, height: 56)
                    .background(focus == i ? Color.white : Color(white: 241.0 / 255), in: RoundedRectangle(cornerRadius: 12))
                    .overlay { if focus == i { RoundedRectangle(cornerRadius: 12).strokeBorder(MacSheetInk.ink, lineWidth: 1.5) } }
            }
        }
        .frame(maxWidth: .infinity)
    }
}

/// A typed six-digit code drawn as MacV2CodeBoxes: the real field sits invisibly on top for typing, paste and
/// one-time-code autofill. Calls `complete` on the sixth digit.
struct MacV2CodeField: View {
    @Binding var code: String
    var disabled = false
    var id: String
    var complete: () -> Void
    @FocusState private var focused: Bool
    var body: some View {
        ZStack {
            MacV2CodeBoxes(code: code, focus: (focused || MacDesignV2.reviewRender) && code.count < 6 ? code.count : nil)
            if !MacDesignV2.reviewRender {
                TextField("", text: $code).textContentType(.oneTimeCode).textFieldStyle(.plain)
                    .focused($focused).disabled(disabled)
                    .foregroundStyle(.clear).tint(.clear).opacity(0.02)
                    .frame(height: 56)
                    .onChange(of: code) { _, v in
                        let digits = String(v.filter(\.isNumber).prefix(6))
                        if digits != v { code = digits }
                        if digits.count == 6 { complete() }
                    }
                    .accessibilityLabel("Six-digit code").accessibilityIdentifier(id)
            }
        }
        .onAppear { focused = true }
        .contentShape(Rectangle()).onTapGesture { focused = true }
    }
}

/// MAC-P: the Mac side of P01 "Pair with your Mac". Same six boxes the iPhone types into, split 3 · 3, under
/// "Pair with your iPhone." with the waiting ring "Looking for your iPhone". References: Copilot Money's six
/// digit boxes, Buffer's 3 · 3 split, Apple TV / Netflix "enter this code on your phone".
struct MacPairingCode: View {
    let code: String
    var connected = false
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Enter these six digits in Genita on your iPhone.\nYou only do this once.")
                .font(MacSheetInk.sans(15)).foregroundStyle(MacSheetInk.ink).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
                .frame(width: 356, alignment: .leading)
            MacV2CodeBoxes(code: code)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Pairing code " + code.map(String.init).joined(separator: " "))
                .accessibilityIdentifier("macPairingCode")
        }
    }
}
