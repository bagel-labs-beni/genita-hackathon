import SwiftUI
import AppKit
import CoreText

@main struct GenitaMacApp: App {
    init() {
        MacAppConfig.start() // GET /v1/app-config at launch + on activate
        if let root = Bundle.main.resourceURL, let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) {
            for case let url as URL in files where ["ttf", "otf"].contains(url.pathExtension.lowercased()) { CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil) }
        }
        MacUpdater.shared.start() // Sparkle: launch + daily check, silent download, "Restart to update"
    }
    var body: some Scene {
        WindowGroup("Genita", id: "companion") {
            MacStartView().preferredColorScheme(.light)
                #if DEBUG
                .task { await MacHandoff.shared.renderReviewScreens() }
                #endif
        }
            .windowResizability(.contentSize).defaultSize(width: 420, height: 320)
    }
}
func resourceImage(_ name: String) -> Image {
    guard let url = Bundle.main.url(forResource: name, withExtension: "png"), let image = NSImage(contentsOf: url) else { return Image(systemName: "questionmark") }
    return Image(nsImage: image)
}
struct MacGlassControl: View {
    var icon: String
    var size: CGFloat = 47
    var slashed = false
    var body: some View {
        ZStack {
            if #available(macOS 26.0, *) { Circle().fill(.black.opacity(0.15)).glassEffect(.clear, in: Circle()).environment(\.colorScheme, .dark).overlay(Circle().strokeBorder(LinearGradient(colors: [.white.opacity(0.65), .white.opacity(0.06), .white.opacity(0.32)], startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 0.7)) }
            else { Circle().fill(.ultraThinMaterial).environment(\.colorScheme, .dark).overlay(Circle().fill(.black.opacity(0.15))).overlay(Circle().strokeBorder(.white.opacity(0.4), lineWidth: 0.7)) }
            if let url = Bundle.main.url(forResource: icon, withExtension: "png"), let data = try? Data(contentsOf: url), let bitmap = NSBitmapImageRep(data: data) {
                resourceImage(icon).resizable().frame(width: CGFloat(bitmap.pixelsWide) / 4, height: CGFloat(bitmap.pixelsHigh) / 4)
            }
            if slashed { Capsule().fill(.white).frame(width: 26, height: 1.5).rotationEffect(.degrees(45)) }
        }.frame(width: size, height: size).contentShape(Circle())
    }
}
