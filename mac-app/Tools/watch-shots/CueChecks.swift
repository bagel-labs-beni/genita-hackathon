// Screenshot assertions for the Mac call's one-line status texts (#211, Chelsea 11/3): renders the call pill and the
// MAC-RS searching line with SwiftUI ImageRenderer at their real widths, writes the PNGs and fails if any wraps.
// Run by mac-app/Tools/watch-shots/check.sh (Command Line Tools are enough).
import SwiftUI
import AppKit
import CoreText

@main struct CueChecks {
    @MainActor static func main() {
        let out = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "build-output/watch-screens")
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        for f in ["ios-app/Genita/Resources/PretendardVariable.ttf"] {
            CTFontManagerRegisterFontsForURL(URL(fileURLWithPath: f) as CFURL, .process, nil)
        }
        var failures = 0
        func check(_ name: String, width: CGFloat, maxHeight: CGFloat, _ view: some View) {
            let r = ImageRenderer(content: view.frame(maxWidth: width, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                .padding(4).background(Color.white).environment(\.colorScheme, .light))
            r.scale = 2
            r.proposedSize = ProposedViewSize(width: width + 8, height: nil)
            guard let img = r.cgImage else { print("FAIL \(name): no image"); failures += 1; return }
            try? NSBitmapImageRep(cgImage: img).representation(using: .png, properties: [:])?.write(to: out.appendingPathComponent("cue-\(name).png"))
            let h = CGFloat(img.height) / 2 - 8
            let ok = h <= maxHeight
            if !ok { failures += 1 }
            print("\(ok ? "ok  " : "FAIL") \(name): \(h) pt tall (one line ≤ \(maxHeight)) at \(width) pt")
        }
        let pill = MacCallCue.oneLineHeight + 2
        // full sheet: the pill sits left of the face thumbnail (250 pt) and carries the card's spoken line
        check("pill-full-say", width: 250, maxHeight: pill, MacCallCue(text: "I found two. Their simple cuts match your style."))
        check("pill-full-long-sentence", width: 250, maxHeight: pill, MacCallCue(text: "Two options with simple cuts and understated colors that match the style you prefer"))
        check("pill-thinking", width: 342, maxHeight: pill, MacCallCue(text: "Mina is thinking"))
        check("pill-answer-failed", width: 342, maxHeight: pill, MacCallCue(text: "Couldn’t get an answer."))
        // MAC-RS-a: title and detail next to Stop (390 − 2 × 38 padding − 14 wave − 12 gap − 12 gap − 44 Stop = 232 pt)
        let row: CGFloat = 232
        check("search-title-old-copy", width: row, maxHeight: 22, OneLineText(text: "Looking for 2 that match your style…", font: MacSheetInk.sans(16, .medium), color: MacSheetInk.ink))
        check("search-title", width: row, maxHeight: 22, OneLineText(text: "Finding 2 for your style…", font: MacSheetInk.sans(16, .medium), color: MacSheetInk.ink))
        check("search-detail", width: row, maxHeight: 20, OneLineText(text: "Light jacket · checking 3 shops", font: MacSheetInk.sans(14), color: MacSheetInk.mute, alternates: OneLineText.afterDot("Light jacket · checking 3 shops")))
        check("search-failed", width: row, maxHeight: 22, OneLineText(text: "Couldn’t find a good match", font: MacSheetInk.sans(16, .medium), color: MacSheetInk.ink))
        print(failures == 0 ? "cue checks ok" : "cue checks FAILED: \(failures)")
        exit(failures == 0 ? 0 : 1)
    }
}
