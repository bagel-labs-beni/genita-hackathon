import XCTest
import UIKit
@testable import Genita

/// Icon sweep 11/4 (Chelsea: "쪼그라진 아이콘"): every glass-button glyph's long side is 55 % of its circle.
final class GlassGlyphTests: XCTestCase {
    func testTheCallGlyphsAtTheHUDSize() {
        XCTAssertEqual(GlassGlyph.size(pixels: CGSize(width: 91, height: 87), diameter: 44).width, 24.2, accuracy: 0.01, "menu gear")
        XCTAssertEqual(GlassGlyph.size(pixels: CGSize(width: 96, height: 57), diameter: 44).width, 24.2, accuracy: 0.01, "camera")
        XCTAssertEqual(GlassGlyph.size(pixels: CGSize(width: 61, height: 78), diameter: 44).height, 24.2, accuracy: 0.01, "mic by its height")
        let dots = GlassGlyph.dots(diameter: 44)
        XCTAssertEqual(dots.height, 22, accuracy: 0.05)
        XCTAssertEqual(dots.dot, 3.6, accuracy: 0.05)
    }

    /// The bundled PNGs, at every size a glass button comes in (S09 44, Mac 46/47): never under 55 % (±0.1 pt),
    /// never past the circle's inner 60 %.
    func testEveryBundledGlyphIsFiftyFivePercent() throws {
        for icon in ["glass-menu-icon", "glass-camera-icon", "glass-mic-icon", "glass-share-icon"] {
            let url = try XCTUnwrap(Bundle.main.url(forResource: icon, withExtension: "png"), icon)
            let image = try XCTUnwrap(UIImage(contentsOfFile: url.path), icon)
            for d: CGFloat in [44, 46, 47] {
                let g = GlassGlyph.size(pixels: CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale), diameter: d)
                XCTAssertEqual(max(g.width, g.height), 0.55 * d, accuracy: 0.1, "\(icon) at \(d)")
            }
        }
    }

    /// Mic / camera off show the slash variant (design lane 11/4: the off rail looked the same as on); ⋮ and the gear have none.
    func testOffStateUsesTheSlashSymbols() {
        XCTAssertEqual(GlassGlyph.offSymbol(for: "glass-mic-icon"), "mic.slash")
        XCTAssertEqual(GlassGlyph.offSymbol(for: "glass-camera-icon"), "video.slash")
        XCTAssertNil(GlassGlyph.offSymbol(for: "glass-menu-icon"))
        XCTAssertNil(GlassGlyph.offSymbol(for: GlassGlyph.moreIcon))
        for name in ["mic.slash", "video.slash"] { XCTAssertNotNil(UIImage(systemName: name), name) }
    }
}
