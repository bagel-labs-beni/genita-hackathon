import SwiftUI
import UIKit

enum Palette { static let accent = Color("AccentColor") }
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
