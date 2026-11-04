#if os(macOS)
import AppKit
import CoreText
import SwiftUI
import Testing
@testable import GenitaKit

/// Renders INT-1~6 and INT-M0~M2 as 390×844 PNGs (the board's frame size) from
/// the same InterpretBoard states the server events produce. The face, status
/// bar and menu button stand in for the call screen, which owns them.
/// Writes only when GENITA_INTERPRET_SHOTS=<dir> is set.
@MainActor struct InterpretScreensTests {
    typealias T = InterpretBoardTests

    static let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    static func registerFonts() {
        for f in ["PretendardVariable.ttf", "KMU80TTFSungkokSemiSerif.ttf"] {
            CTFontManagerRegisterFontsForURL(repo.appendingPathComponent("ios-app/Genita/Resources/\(f)") as CFURL, .process, nil)
        }
    }

    static func screens() -> [(String, InterpretBoard, Bool)] {
        var s: [(String, InterpretBoard, Bool)] = []
        var b = InterpretBoard(companionName: "Jin")
        b.apply(T.pair(nil))
        s.append(("INT-1-listening", b, false))
        b.apply(T.pair("Korean"))
        b.apply(T.bubble(1, .them, .hearing, "혹시 이 근처에 약국 있어요?", lang: "Korean"))
        s.append(("INT-2-them-speaking", b, false))
        b.apply(T.bubble(1, .them, .speaking, "혹시 이 근처에 약국 있어요?", lang: "Korean", translation: "Is there a pharmacy near here?", to: "English", utterance: 1))
        s.append(("INT-3-jin-says-it", b, false))
        b.apply(T.bubble(1, .them, .done, "혹시 이 근처에 약국 있어요?", lang: "Korean", translation: "Is there a pharmacy near here?", to: "English", utterance: 1))
        b.holding = true
        b.apply(T.bubble(2, .me, .hearing, "Yes, two blocks down, next to the bakery.", lang: "English", via: .hold))
        s.append(("INT-4-hold-to-talk", b, false))
        b.holding = false
        b.apply(T.bubble(2, .me, .speaking, "Yes, two blocks down, next to the bakery.", lang: "English", via: .hold, translation: "네, 두 블록 내려가면 빵집 옆에 있어요.", to: "Korean", utterance: 2))
        s.append(("INT-5-my-reply-in-korean", b, false))
        b.apply(T.bubble(3, .unknown, .unknown, "…", reason: "language_unclear"))
        s.append(("INT-6-unclear", b, false))

        var m = InterpretBoard(companionName: "Jin")
        s.append(("INT-M0-pick-call-app", m, true))
        m.apply(T.pair("Korean", source: .call, app: "FaceTime"))
        m.apply(T.bubble(1, .them, .speaking, "다음 주 화요일 회의 괜찮으세요?", lang: "Korean", via: .call, translation: "Does next Tuesday’s meeting work for you?", to: "English", utterance: 1))
        s.append(("INT-M1-whisper", m, true))
        m.apply(T.bubble(1, .them, .done, "다음 주 화요일 회의 괜찮으세요?", lang: "Korean", via: .call, translation: "Does next Tuesday’s meeting work for you?", to: "English", utterance: 1))
        m.apply(T.bubble(2, .me, .speaking, "Tuesday works. Can we do 3 pm?", lang: "English", via: .hold, translation: "화요일 좋아요. 오후 3시 괜찮을까요?", to: "Korean", utterance: 2))
        s.append(("INT-M2-reply-spoken", m, true))
        return s
    }

    @ViewBuilder static func frame(_ name: String, _ board: InterpretBoard, mac: Bool, face: NSImage) -> some View {
        ZStack(alignment: .topLeading) {
            Image(nsImage: face).resizable().scaledToFill().frame(width: 390, height: 844).clipped()
            Text("9:41").font(.system(size: 17, weight: .semibold)).foregroundStyle(.white).position(x: 72, y: 29)
            RoundedRectangle(cornerRadius: 18).fill(.black).frame(width: 124, height: 36).position(x: 195, y: 29)
            glass.position(x: 47.5, y: 86.5)
            if mac { glass.position(x: 342.5, y: 86.5) }
            if name.hasPrefix("INT-M0") {
                InterpretInk.dim.frame(width: 390, height: 844)
                VStack { Spacer(); MacInterpretCallSheet(app: .constant(.faceTime)) {} }.frame(width: 390, height: 844)
            } else {
                InterpretOverlay(board: board, onClose: {}, onHold: { _ in }).frame(width: 390, height: 844)
            }
        }
        .frame(width: 390, height: 844)
        .background(InterpretInk.ink)
        .clipShape(RoundedRectangle(cornerRadius: 40, style: .continuous))
        .environment(\.colorScheme, .dark)
    }

    static var glass: some View {
        Circle().fill(InterpretInk.glass).overlay(Circle().strokeBorder(InterpretInk.glassLine, lineWidth: 1)).frame(width: 46, height: 46)
    }

    @Test func renderAllInterpretScreens() throws {
        guard let dir = ProcessInfo.processInfo.environment["GENITA_INTERPRET_SHOTS"] else { return }
        Self.registerFonts()
        let face = try #require(NSImage(contentsOf: Self.repo.appendingPathComponent("ios-app/Genita/Resources/companion.png")))
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        for (name, board, mac) in Self.screens() {
            let r = ImageRenderer(content: Self.frame(name, board, mac: mac, face: face))
            r.scale = 2
            let image = try #require(r.cgImage, "\(name) did not render")
            let png = try #require(NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]))
            try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("rendered-\(name).png"))
        }
    }
}
#endif
