import SwiftUI
import AppKit
import CoreText

@main struct GenitaMacApp: App {
    @NSApplicationDelegateAdaptor(MacAppDelegate.self) private var appDelegate
    init() {
        MacAppConfig.start() // GET /v1/app-config at launch + on activate
        if let root = Bundle.main.resourceURL, let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) {
            for case let url as URL in files where ["ttf", "otf"].contains(url.pathExtension.lowercased()) { CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil) }
        }
        MacUpdater.shared.start() // Sparkle: launch + daily check, silent download, "Restart to update"
    }
    var body: some Scene {
        // One window only (QA 171: launch showed two "Genita" windows — a restored one plus a new one from the
        // WindowGroup). `Window` is a single-instance scene: relaunch, reopen and restore all bring back the same one.
        Window("Genita", id: MacHomeWindow.id) {
            // Figma MAC-1~4: the window bar has the traffic lights only, no title text — and no bar of its own:
            // build 4 drew a white title band with a hairline over the #FEFEFE window (Mac UI polish 11/3). Hiding the
            // toolbar background lets the window's own sheet colour run up under the traffic lights (Apple's
            // "Customizing window styles" sample does the same). The call window is a separate borderless window.
            MacStartView().preferredColorScheme(.light).toolbar(removing: .title)
                .toolbarBackgroundVisibility(.hidden, for: .windowToolbar)
                // MAC-0 is MacLaunchSplash ("A · Eclipse", 11/4) inside MacStartView; the iPhone splash board only for v1
                .genitaSplash(!MacDesignV2.enabled)
                .modifier(MacHomeWindowOpener())
                #if DEBUG
                .task { await MacHandoff.shared.renderReviewScreens() }
                #endif
        }
            .windowResizability(.contentSize).defaultSize(width: 420, height: 320)
            .commands { MacAccountCommands(); MacCallCommands() }
    }
}

/// Closing the home window must not quit Genita (Codex P2 on #480): a single `Window` scene quits the app with its
/// window, which closed the presence socket, so the iPhone's Move to Mac failed with `peer_offline`. The app keeps
/// running with the window closed; the Dock icon and opening Genita again bring the home window back.
@MainActor final class MacAppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !MacHomeWindow.isVisible { MacHomeWindow.show() }
        return true
    }
}
/// The home window ("companion"): SwiftUI owns it, so it is reopened through `openWindow` (kept from the first time it
/// was shown; the action stays valid after the window closes).
@MainActor enum MacHomeWindow {
    static let id = "companion"
    static var open: OpenWindowAction?
    /// SwiftUI gives its windows the scene id as identifier ("companion" or "companion-AppWindow-1").
    static var window: NSWindow? { NSApp.windows.first { !($0 is NSPanel) && $0.identifier?.rawValue.hasPrefix(id) == true } }
    static var isVisible: Bool { window?.isVisible == true }
    static func show() {
        if let window { window.makeKeyAndOrderFront(nil) } else { open?(id: id) }
        NSApp.activate()
    }
}
private struct MacHomeWindowOpener: ViewModifier {
    @Environment(\.openWindow) private var openWindow
    func body(content: Content) -> some View { content.onAppear { MacHomeWindow.open = openWindow } }
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
/// Edit ▸ Paste Link (⇧⌘V): FD-01 step 6 on the Mac (AU-71). A link copied in the browser goes to the call as the
/// user's words and comes back as the link card (MAC-RS). Outside a live call it does nothing.
struct MacCallCommands: Commands {
    var body: some Commands {
        CommandGroup(after: .pasteboard) {
            Button("Paste Link into Call") {
                let board = NSPasteboard.general
                let pasted = board.string(forType: .URL) ?? board.string(forType: .string) ?? ""
                CallController.shared.sendLink(pasted)
            }
            .keyboardShortcut("v", modifiers: [.command, .shift])
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
    @Environment(\.controlActiveState) private var activeState
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
    /// Sharing on: ink-in-glass in red (#E7200C), the GlassCTA structure with the MacInkGlass non-key rule.
    @ViewBuilder private func tinted(_ tint: Color) -> some View {
        if #available(macOS 26.0, *) {
            Circle().fill(tint.opacity(MacInkGlass.fillOpacity(activeState))).glassEffect(.regular.tint(tint).interactive(), in: Circle())
                .animation(.easeOut(duration: 0.2), value: activeState)
        } else { Circle().fill(tint).overlay(Circle().strokeBorder(.white.opacity(0.35), lineWidth: 0.7)) }
    }
}
