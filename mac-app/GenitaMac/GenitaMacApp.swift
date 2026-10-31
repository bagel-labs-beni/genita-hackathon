import SwiftUI
import AppKit
import CoreText

@main struct GenitaMacApp: App {
    init() {
        if let root = Bundle.main.resourceURL, let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) {
            for case let url as URL in files where ["ttf", "otf"].contains(url.pathExtension.lowercased()) { CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil) }
        }
    }
    var body: some Scene {
        WindowGroup("Genita", id: "companion") { MacConversationView().frame(width: 390, height: 844).preferredColorScheme(.light) }
            .windowStyle(.plain).windowResizability(.contentSize).defaultSize(width: 390, height: 844)
    }
}
func resourceImage(_ name: String) -> Image {
    guard let url = Bundle.main.url(forResource: name, withExtension: "png"), let image = NSImage(contentsOf: url) else { return Image(systemName: "questionmark") }
    return Image(nsImage: image)
}
struct MacGlassControl: View {
    var icon: String
    var size: CGFloat = 47
    var body: some View {
        ZStack {
            if #available(macOS 26.0, *) { Circle().fill(.black.opacity(0.15)).glassEffect(.clear, in: Circle()).environment(\.colorScheme, .dark).overlay(Circle().strokeBorder(LinearGradient(colors: [.white.opacity(0.65), .white.opacity(0.06), .white.opacity(0.32)], startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 0.7)) }
            else { Circle().fill(.ultraThinMaterial).environment(\.colorScheme, .dark).overlay(Circle().fill(.black.opacity(0.15))).overlay(Circle().strokeBorder(.white.opacity(0.4), lineWidth: 0.7)) }
            if let url = Bundle.main.url(forResource: icon, withExtension: "png"), let data = try? Data(contentsOf: url), let bitmap = NSBitmapImageRep(data: data) {
                resourceImage(icon).resizable().frame(width: CGFloat(bitmap.pixelsWide) / 4, height: CGFloat(bitmap.pixelsHigh) / 4)
            }
        }.frame(width: size, height: size).contentShape(Circle())
    }
}
