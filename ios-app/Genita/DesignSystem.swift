import SwiftUI
import UIKit

enum Palette { static let accent = Color("AccentColor") }
enum TypeStyle {
    static func title(_ size: CGFloat = 35) -> Font { .custom("KMUTTF-SungkokSemiSerif", size: size, relativeTo: .largeTitle) }
    /// Fixed size: Figma-placed text (call overlays, onboarding frames) whose layout is absolute.
    static func body(_ size: CGFloat = 16, _ weight: Font.Weight = .regular) -> Font { .custom(face(weight), fixedSize: size) }
    /// Dynamic Type: the same face and the exact `size` at the default text size (Large), growing with the
    /// user's setting like the text style of that size. For flowing text screens (consent, Finds list, sheets);
    /// each screen caps it where its layout would break (`TextScale`).
    static func text(_ size: CGFloat = 16, _ weight: Font.Weight = .regular) -> Font { .custom(face(weight), size: size, relativeTo: style(for: size)) }
    static func face(_ weight: Font.Weight) -> String {
        "PretendardVariable-" + (weight == .medium ? "Medium" : weight == .semibold ? "SemiBold" : weight == .bold ? "Bold" : "Regular")
    }
    /// The iOS text style whose default size is nearest, so each size scales on Apple's own curve.
    static func style(for size: CGFloat) -> Font.TextStyle {
        switch size {
        case ..<12.5: .caption
        case ..<13.5: .footnote
        case ..<15.5: .subheadline
        case ..<16.5: .callout
        case ..<18: .body
        case ..<21: .title3
        case ..<25: .title2
        case ..<31: .title
        default: .largeTitle
        }
    }
}

/// How far each flowing screen lets Dynamic Type go before its layout would break.
enum TextScale {
    /// Scrolling full screens (consent, Finds list): up to the first two accessibility sizes.
    static let screen: ClosedRange<DynamicTypeSize> = .xSmall ... .accessibility2
    /// Half sheets with fixed-height controls (email sign-in, camera guide): the largest standard size.
    static let sheet: ClosedRange<DynamicTypeSize> = .xSmall ... .xxxLarge
}
extension Image {
    init(resource name: String) {
        if let url = Bundle.main.url(forResource: name, withExtension: "png"), let image = UIImage(contentsOfFile: url.path) { self.init(uiImage: image) }
        else { self.init(systemName: "photo") }
    }
}
