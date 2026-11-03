import Foundation
import SwiftUI

/// Glyphs inside the round glass call buttons (S09 menu + rail on iPhone, the Mac call window). One rule for all of them
/// (icon sweep 11/4, Chelsea: "쪼그라진 아이콘"): the glyph's long side is 55 % of the circle, so the menu gear, camera,
/// mic and ⋮ read as one set at any button size (44 pt on the S09 HUD grid, 46–47 pt on the Mac).
/// The PNGs are drawn at 4× with no padding (menu 91×87, camera 96×57, mic 61×78, share 102×74); the ⋮ is drawn
/// as three dots instead of its padded PNG.
enum GlassGlyph {
    static let fraction: CGFloat = 0.55
    /// Black fill on the glass circle: Figma S09-L buttons are rgba(0,0,0,0.42), so the white glyph reads on a light scene
    /// too (0.15 went pale beige over the dog's fur, #530 QA, build 7).
    static let fill: Double = 0.42

    /// Frame for a 4× glyph bitmap of `pixels` in a circle of `diameter`: long side = 55 % of the circle
    /// (the mic, the one tall glyph, by its height; the others by their width).
    static func size(pixels: CGSize, diameter: CGFloat) -> CGSize {
        guard pixels.width > 0, pixels.height > 0 else { return .zero }
        let scale = fraction * diameter / max(pixels.width, pixels.height)
        return CGSize(width: (pixels.width * scale).rounded(toPlaces: 2), height: (pixels.height * scale).rounded(toPlaces: 2))
    }

    /// ⋮: three dots, 50 % of the circle tall, each dot 8.2 % of it (22 pt / 3.6 pt at 44 pt).
    static func dots(diameter: CGFloat) -> (dot: CGFloat, height: CGFloat) {
        (dot: (diameter * 0.082).rounded(toPlaces: 1), height: (diameter * 0.5).rounded(toPlaces: 1))
    }

    /// The ⋮ asset, drawn by `dots` rather than from its bitmap.
    static let moreIcon = "glass-more-icon"
}

private extension CGFloat {
    func rounded(toPlaces p: Int) -> CGFloat {
        let m = CGFloat(pow(10.0, Double(p)))
        return (self * m).rounded() / m
    }
}


/// The ⋮ of the glass More button: three dots sized by `GlassGlyph.dots`.
struct GlassDots: View {
    var diameter: CGFloat
    var color: Color = .white
    var body: some View {
        let d = GlassGlyph.dots(diameter: diameter)
        VStack(spacing: (d.height - 3 * d.dot) / 2) {
            ForEach(0..<3, id: \.self) { _ in Circle().fill(color).frame(width: d.dot, height: d.dot) }
        }.frame(width: d.dot, height: d.height)
    }
}
