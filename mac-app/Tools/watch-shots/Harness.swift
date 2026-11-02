// Render harness for mac-app/Tools/watch-shots/render.sh (not part of the app target).
import SwiftUI
import AppKit
import CoreText

@main struct Harness {
    @MainActor static func main() {
        let res = URL(fileURLWithPath: CommandLine.arguments[1])
        let out = URL(fileURLWithPath: CommandLine.arguments[2])
        for f in (try? FileManager.default.contentsOfDirectory(at: res, includingPropertiesForKeys: nil)) ?? [] where ["ttf", "otf"].contains(f.pathExtension) {
            CTFontManagerRegisterFontsForURL(f as CFURL, .process, nil)
        }
        MacHandoff.shared.desktop = true
        for state in CommandLine.arguments.dropFirst(3) {
            setenv("GENITA_MAC_REVIEW", state, 1)
            let view = MacConversationView().frame(width: 390, height: 844).environment(\.colorScheme, .light)
            let r = ImageRenderer(content: view)
            r.scale = 2
            guard let img = r.cgImage else { print("no image", state); continue }
            let rep = NSBitmapImageRep(cgImage: img)
            try? rep.representation(using: .png, properties: [:])?.write(to: out.appendingPathComponent("mac-watch-\(state).png"))
            print("wrote", state)
        }
    }
}
