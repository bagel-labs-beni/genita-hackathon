import SwiftUI

/// The filled call-to-action surface (Continue, Agree and continue, Walk me through it, Open Settings …).
/// iOS 26 / macOS 26: tinted Liquid Glass that answers the finger (Chelsea 11/3: no flat, stamped-on buttons;
/// API checked in Apple's "Applying Liquid Glass to custom views": `glassEffect(_:in:)`, `Glass.tint(_:)`,
/// `Glass.interactive(_:)`). The glass sits behind the content, so the fill on top is half see-through to keep the
/// rim light and sheen while white text stays readable. Earlier systems keep the flat fill the Figma draws.
struct GlassCTA: View {
    var color: Color
    var radius: CGFloat = 12
    #if os(macOS)
    /// Mac: a non-key window (the call window is never key) washes tinted glass out to light grey (build 171), so the
    /// fill holds the ink there (MacInkGlass: 55 % key, 88 % non-key).
    @Environment(\.controlActiveState) private var activeState
    private var fillOpacity: Double { MacInkGlass.fillOpacity(activeState) }
    #else
    private var fillOpacity: Double { 0.55 }
    #endif
    var body: some View {
        #if os(macOS)
        // Mac CTAs are the Figma's solid fill (lead 11/4, MA-02: glass only on call controls and the HUD)
        RoundedRectangle(cornerRadius: radius).fill(color)
        #else
        if #available(iOS 26.0, *) {
            RoundedRectangle(cornerRadius: radius).fill(color.opacity(fillOpacity))
                .glassEffect(.regular.tint(color).interactive(), in: RoundedRectangle(cornerRadius: radius))
                .animation(.easeOut(duration: 0.2), value: fillOpacity)
        } else {
            RoundedRectangle(cornerRadius: radius).fill(color)
        }
        #endif
    }
}
