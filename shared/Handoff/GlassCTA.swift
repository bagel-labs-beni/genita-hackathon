import SwiftUI

/// The filled call-to-action surface (Continue, Agree and continue, Walk me through it, Open Settings …).
/// iOS 26 / macOS 26: tinted Liquid Glass that answers the finger (Chelsea 11/3: no flat, stamped-on buttons;
/// API checked in Apple's "Applying Liquid Glass to custom views": `glassEffect(_:in:)`, `Glass.tint(_:)`,
/// `Glass.interactive(_:)`). The glass sits behind the content, so the fill on top is half see-through to keep the
/// rim light and sheen while white text stays readable. Earlier systems keep the flat fill the Figma draws.
struct GlassCTA: View {
    var color: Color
    var radius: CGFloat = 12
    var body: some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            RoundedRectangle(cornerRadius: radius).fill(color.opacity(0.55))
                .glassEffect(.regular.tint(color).interactive(), in: RoundedRectangle(cornerRadius: radius))
        } else {
            RoundedRectangle(cornerRadius: radius).fill(color)
        }
    }
}
