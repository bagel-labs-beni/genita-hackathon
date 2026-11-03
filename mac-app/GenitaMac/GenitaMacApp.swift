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
            // Figma MAC-1~4: the window bar has the traffic lights only, no title text — and no bar of its own:
            // build 4 drew a white title band with a hairline over the #FEFEFE window (Mac UI polish 11/3). Hiding the
            // toolbar background lets the window's own sheet colour run up under the traffic lights (Apple's
            // "Customizing window styles" sample does the same). The call window is a separate borderless window.
            MacStartView().preferredColorScheme(.light).toolbar(removing: .title)
                .toolbarBackgroundVisibility(.hidden, for: .windowToolbar)
                .genitaSplash() // launch splash B+ at window open (motion lane)
                #if DEBUG
                .task { await MacHandoff.shared.renderReviewScreens() }
                #endif
        }
            .windowResizability(.contentSize).defaultSize(width: 420, height: 320)
            .commands { MacAccountCommands() }
    }
}

/// Genita ▸ Sign Out (the home windows carry no sign-out link, as in Figma MAC-2/3/4).
struct MacAccountCommands: Commands {
    @ObservedObject private var call = MacCall.shared
    var body: some Commands {
        CommandGroup(after: .appInfo) {
            Button("Sign Out") { call.signOut() }.disabled(!call.isSignedIn)
        }
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
    /// A live state (sharing on): the same glass circle tinted (red), never a flat filled disc (CEO 11/3).
    var tint: Color? = nil
    var body: some View {
        ZStack {
            if let tint { tinted(tint) } else { clearGlass }
            if let url = Bundle.main.url(forResource: icon, withExtension: "png"), let data = try? Data(contentsOf: url), let bitmap = NSBitmapImageRep(data: data) {
                resourceImage(icon).resizable().frame(width: CGFloat(bitmap.pixelsWide) / 4, height: CGFloat(bitmap.pixelsHigh) / 4)
            }
            if slashed { Capsule().fill(.white).frame(width: 26, height: 1.5).rotationEffect(.degrees(45)) }
        }.frame(width: size, height: size).contentShape(Circle())
    }
    @ViewBuilder private var clearGlass: some View {
        if #available(macOS 26.0, *) { Circle().fill(.black.opacity(0.15)).glassEffect(.clear.interactive(), in: Circle()).environment(\.colorScheme, .dark).overlay(Circle().strokeBorder(LinearGradient(colors: [.white.opacity(0.65), .white.opacity(0.06), .white.opacity(0.32)], startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 0.7)) }
        else { Circle().fill(.ultraThinMaterial).environment(\.colorScheme, .dark).overlay(Circle().fill(.black.opacity(0.15))).overlay(Circle().strokeBorder(.white.opacity(0.4), lineWidth: 0.7)) }
    }
    @ViewBuilder private func tinted(_ tint: Color) -> some View {
        if #available(macOS 26.0, *) { Circle().fill(tint.opacity(0.35)).glassEffect(.regular.tint(tint.opacity(0.85)).interactive(), in: Circle()).environment(\.colorScheme, .dark).overlay(Circle().strokeBorder(LinearGradient(colors: [.white.opacity(0.55), .white.opacity(0.04), .white.opacity(0.25)], startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 0.7)) }
        else { Circle().fill(tint).overlay(Circle().strokeBorder(.white.opacity(0.35), lineWidth: 0.7)) }
    }
}
