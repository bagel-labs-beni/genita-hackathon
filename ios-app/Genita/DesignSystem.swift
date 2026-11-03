import SwiftUI
import UIKit

enum Palette {
    static let accent = Color("AccentColor")
    /// D1 (Chelsea 04:53): secondary text on white is #737373 (4.8:1), not Figma's #B7B7B7 (2.0:1, unreadable at 12 pt).
    static let secondaryUI = UIColor(white: 115.0 / 255, alpha: 1)
    static let secondary = Color(uiColor: secondaryUI)
    /// Figma's #B7B7B7 secondary grey, as the design JSON carries it (0.7177 per channel).
    static func isFigmaSecondary(r: CGFloat, g: CGFloat, b: CGFloat) -> Bool {
        abs(r - 0.7177) < 0.01 && abs(g - 0.7177) < 0.01 && abs(b - 0.7177) < 0.01
    }
}
enum TypeStyle {
    static func title(_ size: CGFloat = 35) -> Font { .custom("KMUTTF-SungkokSemiSerif", size: size, relativeTo: .largeTitle) }
    static func body(_ size: CGFloat = 16, _ weight: Font.Weight = .regular) -> Font { .custom("PretendardVariable-" + (weight == .medium ? "Medium" : weight == .semibold ? "SemiBold" : weight == .bold ? "Bold" : "Regular"), fixedSize: size) }
}
extension Image {
    init(resource name: String) {
        if let url = Bundle.main.url(forResource: name, withExtension: "png"), let image = UIImage(contentsOfFile: url.path) { self.init(uiImage: image) }
        else { self.init(systemName: "photo") }
    }
}
