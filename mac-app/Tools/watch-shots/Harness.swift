// Render harness for mac-app/Tools/watch-shots/render.sh (not part of the app target).
import SwiftUI
import AppKit
import CoreText

@main struct Harness {
    @MainActor static func main() {
        let res = URL(fileURLWithPath: CommandLine.arguments[1])
        let out = URL(fileURLWithPath: CommandLine.arguments[2])
        // review mode: no presence socket, no surface changes
        setenv("GENITA_MAC_REVIEW_OUT", out.path, 1)
        for f in (try? FileManager.default.contentsOfDirectory(at: res, includingPropertiesForKeys: nil)) ?? [] where ["ttf", "otf"].contains(f.pathExtension) {
            CTFontManagerRegisterFontsForURL(f as CFURL, .process, nil)
        }
        let call = CallController.shared
        call.companionName = "Mina"
        for state in CommandLine.arguments.dropFirst(3) {
            // #118/#121 states drive the shared call + Finds model from wire events; watch states use GENITA_MAC_REVIEW
            var override: String? = nil
            call.finds.reset()
            switch state {
            case "thinking":
                feed(call, #"{"type":"ready","protocol":1,"sessionId":"review","mode":"chat","audio":{"in":"pcm_s16le_24000_mono","out":"pcm_s16le_24000_mono","frameHeaderBytes":8},"lip":{"requested":"none","active":"none"},"voiceId":"v","bargeIn":{"minMs":400,"minWords":2}}"#)
                feed(call, #"{"type":"state","state":"thinking"}"#)
                override = ""
            // MF-1~3 (#121): first search, refine with its Why line, two results (full + half), failure, link opened
            case "mac-rs-a": MacResultFixture.load(.searching, into: call.finds, state: .searching); override = ""
            case "mac-rs-a-why": MacResultFixture.load(.refining, into: call.finds, state: .searching); override = ""
            case "mac-rs-b": MacResultFixture.load(.results, into: call.finds, state: .full); override = ""
            case "mac-rs-half": MacResultFixture.load(.results, into: call.finds, state: .half); override = ""
            case "mac-rs-failed": MacResultFixture.load(.failed, into: call.finds, state: .searching); override = ""
            case "mac-link": MacResultFixture.load(.results, into: call.finds, state: .half); override = "link"
            case "a02", "a02-j", "a02-m", "a02-m2", "a02-m2-error", "cs01", "mac-2", "mac-3", "mac-4": break
            case "mc-m": MacHandoff.shared.reviewCanMove = true; override = "menu"
            default: setenv("GENITA_MAC_REVIEW", state, 1)
            }
            let page: AnyView
            switch state {
            case "a02": page = AnyView(MacSignInView())
            case "a02-j": page = AnyView(MacJudgeCodeSheet())
            case "a02-m": page = AnyView(MacEmailSheet())
            case "a02-m2": page = AnyView(MacEmailSheet(step: .code, email: "you@example.com"))
            case "a02-m2-error": page = AnyView(MacEmailSheet(step: .code, email: "you@example.com", message: "That code didn’t work. Check it and try again."))
            case "cs01": page = AnyView(MacConsentView())
            // #78: MAC-2 / MAC-3 / MAC-4 home windows (Figma 87:2 / 88:2 / 89:2)
            case "mac-2": page = AnyView(MacHomeView(kind: .noCompanion, name: "Mina", handoff: MacHandoff.shared))
            case "mac-3": page = AnyView(MacHomeView(kind: .onPhone, name: "Mina", handoff: MacHandoff.shared))
            case "mac-4": MacHandoff.shared.reviewCanMove = true; page = AnyView(MacHomeView(kind: .here, name: "Mina", handoff: MacHandoff.shared))
            default: page = AnyView(MacConversationView(reviewOverride: override).frame(width: 390, height: 844))
            }
            let view = page.environment(\.colorScheme, .light)
            let r = ImageRenderer(content: view)
            r.scale = 2
            guard let img = r.cgImage else { print("no image", state); continue }
            let rep = NSBitmapImageRep(cgImage: img)
            try? rep.representation(using: .png, properties: [:])?.write(to: out.appendingPathComponent("mac-\(state).png"))
            print("wrote", state)
        }
    }

    @MainActor static func feed(_ call: CallController, _ json: String) {
        if let e = try? ServerEvent.decode(json) { call.handle(e) }
    }
}
