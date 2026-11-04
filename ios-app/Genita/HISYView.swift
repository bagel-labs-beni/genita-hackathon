import AVFoundation
import CoreText
import Speech
import SwiftUI
import UIKit

// D47 "How I see you" v2 (lane 개인화, Chelsea OK 11/3 "퍼펙트"). Figma rp1wR9pxV0IsgyjvOcwo92:
// HISY-0~7 251:2 · 251:25 · 251:74 · 251:125 · 251:203 · 251:272 · 251:346 · 251:417, S0~S4 252:2 … 252:175,
// C1~C3 252:243 · 252:358 · 252:473. Renders: genita-hackathon/design-hisy/evidence/390-light/.
// Frame values are 390 × 844 design points: 31 pt sides, top row at y 52, eyebrow 106, headline 128,
// Next at 140 pt from the bottom, "That's not me" 88 pt from the bottom.

enum HISYInk {
    static let canvas = Color(red: 253 / 255, green: 253 / 255, blue: 253 / 255)
    static let ink = Color(red: 17 / 255, green: 17 / 255, blue: 17 / 255)
    static let mute = Color(red: 115 / 255, green: 115 / 255, blue: 115 / 255)
    static let line = Color(red: 227 / 255, green: 227 / 255, blue: 227 / 255)
    static let blue = Color(red: 0, green: 162 / 255, blue: 1)
    static let blueSoft = Color(red: 215 / 255, green: 241 / 255, blue: 1)
    static let blueText = Color(red: 0, green: 99 / 255, blue: 159 / 255)
    static let dotOff = Color(red: 234 / 255, green: 234 / 255, blue: 234 / 255)
    static let dislike = Color(red: 148 / 255, green: 148 / 255, blue: 148 / 255)
    static let off = Color(red: 189 / 255, green: 189 / 255, blue: 189 / 255)
    static let error = Color(red: 0.85, green: 0.2, blue: 0.2)
}

/// Figma line heights on top of the fonts' own (Noto Serif KR 35/39 → the app's serif, Pretendard 16/24 …).
enum HISYCopy {
    /// Join the last `words` words with no-break spaces so the last line never holds a lone short tail.
    static func keepTail(_ s: String, words: Int = 3) -> String {
        var parts = s.components(separatedBy: " ")
        guard parts.count > words else { return s }
        let tail = parts.suffix(words).joined(separator: "\u{00A0}")
        parts.removeLast(words)
        return (parts + [tail]).joined(separator: " ")
    }
}

enum HISYType {
    static func serif(_ size: CGFloat = 35) -> Font { TypeStyle.title(size) }
    static func serifSpacing(_ size: CGFloat, line: CGFloat) -> CGFloat {
        max(0, line - (UIFont(name: "KMUTTF-SungkokSemiSerif", size: size)?.lineHeight ?? size * 1.2))
    }
    static func spacing(_ size: CGFloat, line: CGFloat) -> CGFloat {
        max(0, line - (UIFont(name: "PretendardVariable-Regular", size: size)?.lineHeight ?? size * 1.2))
    }
}

private extension View {
    /// Pretendard text at a Figma size / line height.
    func hisyBody(_ size: CGFloat, _ weight: Font.Weight = .regular, line: CGFloat, color: Color = HISYInk.ink) -> some View {
        font(TypeStyle.body(size, weight)).lineSpacing(HISYType.spacing(size, line: line)).foregroundStyle(color)
    }
}

// MARK: - flow

struct HISYView: View {
    @Bindable var model: AppState
    @State private var fixing: StoryCard?
    @State private var toast: String?
    @State private var toastTask: Task<Void, Never>?
    @State private var forward = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// motion details card 8 (flag `motionDetails`): one set of dots above the sliding cards
    private var movingDots: Bool { MotionDetails.live(reduceMotion: reduceMotion) }

    private var cards: [StoryCard] { model.story ?? [] }
    private var skip: Bool { model.storySource == "skip" }
    private var facePage: Int { cards.count + 1 }
    private var page: Int { min(max(0, model.hisyPage), facePage) }

    var body: some View {
        GeometryReader { safe in
            GeometryReader { full in
                let top = safe.safeAreaInsets.top - 44
                let w = full.size.width, h = full.size.height
                ZStack(alignment: .topLeading) {
                    HISYInk.canvas
                    Group {
                        if page == 0 { opener(width: w, height: h, top: top) }
                        else if page == facePage { face(width: w, height: h, top: top) }
                        else { cardPage(cards[page - 1], index: page - 1, width: w, height: h, top: top) }
                    }
                    .id(page)
                    .transition(.asymmetric(insertion: .move(edge: forward ? .trailing : .leading).combined(with: .opacity),
                                            removal: .move(edge: forward ? .leading : .trailing).combined(with: .opacity)))
                    // motion details card 8: the dots stay while the cards slide, and their capsule moves on
                    if movingDots, page >= 1, page <= cards.count {
                        HISYDots(count: cards.count, current: page - 1, moving: true).position(x: w / 2, y: 52 + top + 22).allowsHitTesting(false)
                    }
                    if let fixing {
                        HISYFixSheet(model: model, card: fixing, width: w, onCancel: { close() }, onSaved: { saved(fixing.id) })
                            .transition(.identity)
                    }
                }
                .frame(width: w, height: h)
                .clipped()
            }.ignoresSafeArea(.container)
        }
        .background(HISYInk.canvas.ignoresSafeArea())
        .task(id: model.importing) { await model.loadStory() }
    }

    private func go(_ next: Int) {
        let p = min(max(0, next), facePage)
        guard p != page else { return }
        forward = p > page
        withAnimation(.easeInOut(duration: 0.28)) { model.hisyPage = p }
    }

    private func close() { withAnimation(.easeOut(duration: 0.22)) { fixing = nil } }

    /// C3: back on the same card, the new texts with the blue border, "Got it. I’ll remember that." for 1.6 s, under the nav row.
    private func saved(_ cardId: String) {
        guard fixing?.id == cardId else { return }
        close()
        toastTask?.cancel()
        withAnimation(.easeOut(duration: 0.2)) { toast = "Got it. I’ll remember that." }
        toastTask = Task {
            try? await Task.sleep(for: .milliseconds(HISYView.toastMs))
            guard !Task.isCancelled else { return }
            withAnimation(.easeIn(duration: 0.2)) { toast = nil }
        }
    }

    /// C3 toast time. Debug UI tests on slow simulators can lengthen it (GENITA_HISY_TOAST_MS).
    static var toastMs: Int {
        #if DEBUG
        if let ms = ProcessInfo.processInfo.environment["GENITA_HISY_TOAST_MS"].flatMap(Int.init) { return ms }
        #endif
        return 1600
    }

    // MARK: HISY-0 / S0

    private static let numbers = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"]

    @ViewBuilder private func opener(width w: CGFloat, height h: CGFloat, top: CGFloat) -> some View {
        let n = cards.count
        let count = n < Self.numbers.count ? Self.numbers[n] : "\(n)"
        let title = skip ? "From your three\nanswers, here’s\nmy first take." : "I read what\nyou shared.\nHere’s how\nI see you."
        let cardsLine = n == 0 ? "A few short cards." : "\(count) short card\(n == 1 ? "" : "s")."
        let sub = skip ? "\(cardsLine) I’ll learn the rest in our calls." : "\(cardsLine) If one is off, tell me."
        // title + subline stacked from y 106 (8 pt apart): a narrow screen that wraps the title pushes the subline down
        VStack(alignment: .leading, spacing: 8) {
            HISYTitle(text: title).accessibilityIdentifier("hisyOpener")
            Text(model.storyLoading && n == 0 ? "Putting it into words…" : sub).hisyBody(16, line: 24, color: HISYInk.mute)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(width: w - 62, alignment: .leading)
        .padding(.leading, 31).padding(.top, 106 + top)
        .frame(width: w, height: h, alignment: .topLeading)
        HISYGlobe(backing: true).position(x: w / 2, y: 339 + top + 321 / 2 + (h - 844) / 2)   // HISY-0 "I read what you shared" (SY-03)
        HISYPrimary(title: "Show me", busy: n == 0 && model.serverWired && !model.storyFailed, id: "hisyShowMe") { go(n == 0 ? facePage : 1) }
            .position(x: w / 2, y: h - 140 + 25)
        Text(skip ? "Made only from your three answers." : "Made only from the reply you pasted.\nThe reply itself isn’t kept.")
            .hisyBody(12, line: 16, color: HISYInk.mute).multilineTextAlignment(.center)
            .frame(width: w - 62).position(x: w / 2, y: h - 74 + (skip ? 8 : 16))
    }

    // MARK: HISY-7

    @ViewBuilder private func face(width w: CGFloat, height h: CGFloat, top: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HISYTitle(text: "Now give me\na face.").accessibilityIdentifier("hisyFace")
            Text("Choose a photo for how I’ll look on our calls.\nYou can change it later.").hisyBody(16, line: 24, color: HISYInk.mute)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(width: w - 62, alignment: .leading)
        .padding(.leading, 31).padding(.top, 106 + top)
        .frame(width: w, height: h, alignment: .topLeading)
        // TF 331 (scorecard PU-01 "V01 orb barely visible"): on this white page the live orb read as almost nothing,
        // so it sits on a soft blue backing here (the shader is untouched)
        HISYGlobe(backing: true).position(x: w / 2, y: 312 + top + 321 / 2 + (h - 844) / 2)
        HISYPrimary(title: "Choose a photo", id: "hisyChoosePhoto") { model.go(.image) }.position(x: w / 2, y: h - 140 + 25)
        HISYTextButton(title: "Back to the cards", id: "hisyBackToCards") { go(cards.isEmpty ? 0 : cards.count) }
            .frame(width: w - 62).position(x: w / 2, y: h - 88 + 22)
    }

    // MARK: HISY-1~6 / S1~S4

    @ViewBuilder private func cardPage(_ card: StoryCard, index: Int, width w: CGFloat, height h: CGFloat, top: CGFloat) -> some View {
        // top row: back · progress dots (or the C3 toast) · Skip
        Button { go(page - 1) } label: { Image(resource: "reference-back").resizable().frame(width: 8.8, height: 15.8).frame(width: 44, height: 44) }
            .buttonStyle(.plain).position(x: 16 + 22, y: 52 + top + 22).accessibilityLabel("Back").accessibilityIdentifier("hisyBack")
        ZStack {
            if !movingDots {
                HISYDots(count: cards.count, current: index)
            }
        }.position(x: w / 2, y: 52 + top + 22)
        // C3 toast under the nav row (top 98 + 8), never over the dots and Skip (design review 11/4, build 5 h13-3):
        // drops 8 pt and fades in 200 ms, holds 1.6 s, fades out 200 ms; 24 pt side margins at the least
        if let toast {
            HISYToast(text: toast).frame(maxWidth: w - 48).transition(.opacity.combined(with: .offset(y: -8)))
                .position(x: w / 2, y: 106 + top + 23).zIndex(10)   // over the card's eyebrow and headline
        }
        Button { go(facePage) } label: {
            Text("Skip").hisyBody(15, .medium, line: 22).padding(.horizontal, 12).frame(height: 44).contentShape(Rectangle())
        }.buttonStyle(.plain).position(x: w - 16 - 27, y: 52 + top + 22).accessibilityIdentifier("hisySkip")

        // body: eyebrow, headline, the card's own block; tap right = next, tap left = back
        let bodyTop = 106 + top
        let bodyBottom = h - 140 - 12
        ScrollView(.vertical, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                Text(card.eyebrow).hisyBody(12, .medium, line: 16, color: HISYInk.mute).accessibilityIdentifier("hisyEyebrow")
                HISYTitle(text: card.headline).padding(.top, 6).accessibilityIdentifier("hisyHeadline")
                HISYCardBody(card: card, changed: Set(model.storyChanged[card.id] ?? []), skip: skip)
                Color.clear.frame(height: 8)
            }
            .frame(width: w - 62, alignment: .leading)
            .padding(.horizontal, 31)
            .contentShape(Rectangle())
            .onTapGesture(coordinateSpace: .local) { p in go(p.x < w * 0.3 ? page - 1 : page + 1) }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(width: w, height: max(100, bodyBottom - bodyTop))
        .position(x: w / 2, y: bodyTop + max(100, bodyBottom - bodyTop) / 2)
        .accessibilityAction(named: "Next card") { go(page + 1) }

        HISYPrimary(title: "Next", id: "hisyNext") { go(page + 1) }.position(x: w / 2, y: h - 140 + 25)
        // the open-questions card lists what I don't know yet — nothing there to be "not me" about (TF 331)
        if card.id != "unknowns" {
            HISYTextButton(title: "That’s not me", id: "hisyNotMe") {
                // a fix sheet never opens under the last C3 toast (it floats above the card, Codex P3)
                toastTask?.cancel(); toast = nil
                withAnimation(.easeOut(duration: 0.25)) { fixing = card }
            }
            .frame(width: w - 62).position(x: w / 2, y: h - 88 + 22)
        }
    }
}

// MARK: - pieces

/// Noto Serif KR Regular 35/39, tracking -0.35 (Figma HISY / S / C1 headlines), drawn like Figma: every line box is
/// exactly 39 pt with the font's ascent centred in it (SwiftUI can't set a line height below the font's own 50 pt).
struct HISYTitle: View {
    let text: String
    var size: CGFloat = 35
    var line: CGFloat = 39
    /// Dynamic Type: the title grows with the text size like the old `.largeTitle`-relative serif (1 at the default size)
    @ScaledMetric(relativeTo: .largeTitle) private var scale: CGFloat = 1
    /// explicit: the SUM insight report (InsightReportView.swift) uses other sizes
    init(text: String, size: CGFloat = 35, line: CGFloat = 39) { self.text = text; self.size = size; self.line = line }
    var body: some View {
        HISYSerifText(text: text, size: size * scale, line: line * scale).padding(.vertical, -HISYSerifText.overflow)
            .motionBandLineReveal(pitch: line * scale, key: text)   // motion details card 8: one line after another
    }
}

struct HISYSerifText: UIViewRepresentable {
    let text: String
    var size: CGFloat = 35
    var line: CGFloat = 39
    var tracking: CGFloat = -0.35
    /// room above and below the 39 pt boxes for ascenders and descenders that reach past them
    static let overflow: CGFloat = 8

    static func font(_ size: CGFloat) -> UIFont {
        UIFont(name: "NotoSerifKR-Regular", size: size) ?? UIFont(name: "KMUTTF-SungkokSemiSerif", size: size) ?? .systemFont(ofSize: size)
    }

    func makeUIView(context: Context) -> SerifLabel {
        let v = SerifLabel(); v.isOpaque = false; v.backgroundColor = .clear; v.contentMode = .redraw
        v.isAccessibilityElement = true; v.accessibilityTraits = [.staticText, .header]
        return v
    }
    func updateUIView(_ v: SerifLabel, context: Context) {
        v.text = text; v.size = size; v.line = line; v.tracking = tracking; v.accessibilityLabel = text
        v.setNeedsDisplay()
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: SerifLabel, context: Context) -> CGSize? {
        let width = proposal.width ?? 328
        let lines = SerifLabel.lineRanges(text: text, size: size, tracking: tracking, width: width).count
        return CGSize(width: width, height: CGFloat(max(1, lines)) * line + 2 * Self.overflow)
    }
}

final class SerifLabel: UIView {
    var text = ""
    var size: CGFloat = 35
    var line: CGFloat = 39
    var tracking: CGFloat = -0.35

    static func attributed(_ text: String, size: CGFloat, tracking: CGFloat) -> NSAttributedString {
        NSAttributedString(string: text, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName(HISYSerifText.font(size).fontName as CFString, size, nil),
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): UIColor(red: 17 / 255, green: 17 / 255, blue: 17 / 255, alpha: 1).cgColor,
            .kern: tracking,
        ])
    }
    static func lineRanges(text: String, size: CGFloat, tracking: CGFloat, width: CGFloat) -> [CFRange] {
        let a = attributed(text, size: size, tracking: tracking)
        let typesetter = CTTypesetterCreateWithAttributedString(a)
        var out: [CFRange] = [], start = 0
        while start < a.length {
            let count = CTTypesetterSuggestLineBreak(typesetter, start, Double(width) + 0.5)
            guard count > 0 else { break }
            out.append(CFRange(location: start, length: count)); start += count
        }
        return out
    }
    override func draw(_ rect: CGRect) {
        guard let cg = UIGraphicsGetCurrentContext() else { return }
        let font = HISYSerifText.font(size)
        let a = Self.attributed(text, size: size, tracking: tracking)
        let typesetter = CTTypesetterCreateWithAttributedString(a)
        cg.saveGState(); cg.textMatrix = .identity
        cg.translateBy(x: 0, y: bounds.height); cg.scaleBy(x: 1, y: -1)
        // Figma: the font's ascent + descent centred in each line box
        var baseline = bounds.height - HISYSerifText.overflow - font.ascender - (line - font.lineHeight) / 2
        for r in Self.lineRanges(text: text, size: size, tracking: tracking, width: bounds.width) {
            let l = CTTypesetterCreateLine(typesetter, r)
            cg.textPosition = CGPoint(x: 0, y: baseline)
            CTLineDraw(l, cg)
            baseline -= line
        }
        cg.restoreGState()
    }
}

/// SY-03/SY-06 (춘식이 11/4): the pale orb on a white page (HISY-0, HISY-7, V04) sits on a soft #00A2FF radial,
/// 16 % → 7 % → 0, so its points read. The SoulOrb shader is untouched.
struct OrbBacking: View {
    var diameter: CGFloat
    var body: some View {
        let blue = Color(red: 0, green: 0xA2 / 255, blue: 1)
        Circle().fill(RadialGradient(stops: [
            .init(color: blue.opacity(0.16), location: 0), .init(color: blue.opacity(0.07), location: 0.55), .init(color: blue.opacity(0), location: 1),
        ], center: .center, startRadius: 0, endRadius: diameter / 2)).frame(width: diameter, height: diameter).accessibilityHidden(true)
    }
}

/// I03's globe in HISY's 346 × 321 slot: the orb itself is ~130 pt wide there (Figma 251:21 / 251:436), smaller
/// than on I03, so the I03 node is drawn at 0.59.
struct HISYGlobe: View {
    /// HISY-7 "Now give me a face." only: a soft #00A2FF radial behind the ~130 pt orb so its pale points read on #FDFDFD
    var backing = false
    var body: some View {
        if let orb = DesignLibrary.nodes("preparing").first(where: { $0.name.hasPrefix("soul-orb") }) {
            ZStack {
                if backing { OrbBacking(diameter: 220) }
                SoulOrbSlot(node: orb, resource: orb.name.contains("(2)") ? "reference-orb-wide" : "reference-orb-round")
                    .frame(width: orb.w, height: orb.h).scaleEffect(0.59)
            }.frame(width: 346, height: 321).accessibilityHidden(true)
        }
    }
}

/// Black 313 × 50 r12 CTA, Pretendard Medium 16 #FDFDFD.
struct HISYPrimary: View {
    let title: String
    var enabled = true
    var busy = false
    let id: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            ZStack {
                RoundedRectangle(cornerRadius: 12).fill(enabled ? HISYInk.ink : HISYInk.off)
                if busy { ProgressView().tint(HISYInk.canvas) }
                else { Text(title).hisyBody(16, .medium, line: 24, color: HISYInk.canvas) }
            }.frame(width: 313, height: 50)
        }.buttonStyle(.plain).disabled(!enabled || busy).accessibilityLabel(title).accessibilityIdentifier(id)
    }
}

/// "That's not me" / "Back to the cards" / "Cancel": Pretendard Medium 15, 44 pt tall.
struct HISYTextButton: View {
    let title: String
    let id: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title).hisyBody(15, .medium, line: 22).frame(maxWidth: .infinity).frame(height: 44).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityIdentifier(id)
    }
}

/// Progress: done #00A2FF 6 pt, now #00A2FF 18 × 6, next #EAEAEA, 6 pt apart.
/// `moving` (motion details card 8): the "now" capsule is one view that springs to the next card's slot.
struct HISYDots: View {
    let count: Int
    let current: Int
    var moving = false
    @Namespace private var dots
    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<max(count, 1), id: \.self) { i in
                if moving && i == current {
                    RoundedRectangle(cornerRadius: 3).fill(HISYInk.blue).frame(width: 18, height: 6)
                        .matchedGeometryEffect(id: "now", in: dots)
                } else {
                    RoundedRectangle(cornerRadius: 3).fill(i <= current ? HISYInk.blue : HISYInk.dotOff).frame(width: i == current ? 18 : 6, height: 6)
                }
            }
        }
        .animation(moving ? MotionOnboarding.dotSpring : nil, value: current)
        .accessibilityElement().accessibilityLabel("Card \(current + 1) of \(count)").accessibilityIdentifier("hisyDots")
    }
}

/// C3 toast: #111 r12, 22 pt blue check, Pretendard Medium 15 #FDFDFD.
struct HISYToast: View {
    let text: String
    var body: some View {
        HStack(spacing: 10) {
            ZStack {
                Circle().fill(HISYInk.blue).frame(width: 22, height: 22)
                Image("hisy-toast-check").resizable().renderingMode(.template).foregroundStyle(.white).frame(width: 14, height: 14)
            }
            Text(text).hisyBody(15, .medium, line: 22, color: HISYInk.canvas).lineLimit(1).fixedSize()
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(HISYInk.ink, in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .combine).accessibilityIdentifier("hisyToast")
    }
}

/// White r12 #E3E3E3 chip: 12 pt icon + Pretendard Medium 12 #737373.
struct HISYEvidenceChip: View {
    let evidence: String
    /// S2 (Figma 269:228): the N3 rows' chip reads "From your answers"
    var label: String? = nil
    var body: some View {
        HStack(spacing: 6) {
            Image(evidence == "observed" ? "hisy-often" : evidence == "memory" ? "hisy-memory" : "hisy-said")
                .resizable().renderingMode(.template).foregroundStyle(HISYInk.mute).frame(width: 12, height: 12).accessibilityHidden(true)
            Text(label ?? StoryCard.evidenceLabel(evidence)).hisyBody(12, .medium, line: 16, color: HISYInk.mute).lineLimit(1).fixedSize()
        }
        .padding(.horizontal, 10).padding(.vertical, 5)
        .background(.white, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(HISYInk.line, lineWidth: 1))
        .accessibilityElement(children: .combine).accessibilityIdentifier("hisyEvidence")
    }
}

/// Taste tag: like = #D7F1FF / #00639F; dislike = white, dashed #E3E3E3, ✕, #949494; just fixed = 1.5 pt #00A2FF.
struct HISYTag: View {
    let tag: StoryCard.Tag
    var changed = false
    var body: some View {
        HStack(spacing: 5) {
            if tag.dislike {
                Image("hisy-not").resizable().renderingMode(.template).foregroundStyle(HISYInk.dislike).frame(width: 12, height: 12).accessibilityHidden(true)
            }
            Text(tag.text).hisyBody(14, .medium, line: 18, color: tag.dislike ? HISYInk.dislike : HISYInk.blueText)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(tag.dislike ? Color.white : HISYInk.blueSoft, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(changed ? HISYInk.blue : tag.dislike ? HISYInk.line : HISYInk.blueSoft,
                                                                style: StrokeStyle(lineWidth: changed ? 1.5 : 1, dash: tag.dislike ? [4, 3] : [])))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(tag.dislike ? "Not for you: \(tag.text)" : tag.text)
        .accessibilityValue(changed ? "changed" : "")
        .accessibilityIdentifier("hisyTag")
    }
}

/// Wrapping rows (8 pt apart); a chip wider than the row wraps its text instead of running off.
struct HISYFlow: Layout {
    var spacing: CGFloat = 8
    private func sizes(_ subviews: Subviews, width: CGFloat) -> [CGSize] {
        subviews.map { s in
            let ideal = s.sizeThatFits(.unspecified)
            return ideal.width <= width ? ideal : s.sizeThatFits(ProposedViewSize(width: width, height: nil))
        }
    }
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 328
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0
        for size in sizes(subviews, width: width) {
            if x > 0 && x + size.width > width { x = 0; y += row + spacing; row = 0 }
            x += size.width + spacing; row = max(row, size.height)
        }
        return CGSize(width: width, height: y + row)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, row: CGFloat = 0
        for (s, size) in zip(subviews, sizes(subviews, width: bounds.width)) {
            if x > bounds.minX && x + size.width > bounds.maxX { x = bounds.minX; y += row + spacing; row = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing; row = max(row, size.height)
        }
    }
}

/// A just-fixed block (C3): 1.5 pt #00A2FF r12 around it.
private struct FixedMark: ViewModifier {
    let on: Bool
    func body(content: Content) -> some View {
        if on {
            content.padding(8)
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(HISYInk.blue, lineWidth: 1.5))
                .padding(-8).accessibilityValue("changed")
        } else { content }
    }
}

// MARK: - card bodies

struct HISYCardBody: View {
    let card: StoryCard
    let changed: Set<String>
    let skip: Bool

    var body: some View {
        switch card.id {
        case "think": items(dividers: true)
        case "talk": VStack(alignment: .leading, spacing: 0) { items(dividers: false); promise }
        case "taste": taste
        case "help": help
        case "lines": lines
        case "unknowns": unknowns
        default: items(dividers: false)
        }
    }

    /// think / talk: 16/24 observations, each with its evidence chip.
    @ViewBuilder private func items(dividers: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(card.items.enumerated()), id: \.offset) { i, item in
                if i > 0 && dividers { HISYInk.line.frame(height: 1).padding(.top, 20) }
                VStack(alignment: .leading, spacing: 10) {
                    Text(item.text).hisyBody(16, line: 24).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("hisyItem")
                    HISYEvidenceChip(evidence: item.evidence)
                }
                .modifier(FixedMark(on: changed.contains(item.text)))
                .padding(.top, i == 0 ? 24 : 20)
            }
        }
    }

    /// talk: "So I'll" blue box.
    @ViewBuilder private var promise: some View {
        if let p = card.promise, !p.isEmpty {
            let line = p.hasPrefix("So I’ll ") ? String(p.dropFirst(8)) : p.hasPrefix("So I'll ") ? String(p.dropFirst(8)) : p
            VStack(alignment: .leading, spacing: 6) {
                Text("So I’ll").hisyBody(14, .semibold, line: 21, color: HISYInk.blueText)
                Text(line).hisyBody(16, line: 24).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 21).padding(.horizontal, 21).padding(.bottom, 16)
            .background(HISYInk.blueSoft, in: RoundedRectangle(cornerRadius: 16))
            .padding(.top, 24)
            .accessibilityElement(children: .combine).accessibilityIdentifier("hisyPromise")
        }
    }

    /// taste: Style / Food / Watch & listen groups, evidence + legend, note. Skip users (S2, Figma 269:228): the N1
    /// tiles untitled on top with "You said this", then the N3 Style / Food rows with "From your answers".
    @ViewBuilder private var taste: some View {
        if skip { skipTaste } else { importTaste }
    }

    private var skipTaste: some View {
        let groups = card.tagGroups
        let interest = groups.first { $0.key == "interest" }
        let rows = groups.filter { $0.key != "interest" }
        let dislikes = rows.contains { g in g.tags.contains { $0.dislike } }
        return VStack(alignment: .leading, spacing: 0) {
            if let interest {
                HISYFlow(spacing: 8) {
                    ForEach(Array(interest.tags.enumerated()), id: \.offset) { _, t in HISYTag(tag: t, changed: changed.contains(t.choiceText)) }
                }.padding(.top, 24)
                HISYEvidenceChip(evidence: "explicit").padding(.top, 14)
            }
            ForEach(Array(rows.enumerated()), id: \.element.key) { i, g in
                VStack(alignment: .leading, spacing: 8) {
                    Text(g.title).hisyBody(14, .semibold, line: 20)
                    HISYFlow(spacing: 8) {
                        ForEach(Array(g.tags.enumerated()), id: \.offset) { _, t in HISYTag(tag: t, changed: changed.contains(t.choiceText)) }
                    }
                }.padding(.top, i == 0 && interest == nil ? 24 : 16)
            }
            if !rows.isEmpty {
                HStack(spacing: 10) {
                    HISYEvidenceChip(evidence: "memory", label: "From your answers")
                    if dislikes { Text("Dashed = not for you").hisyBody(12, line: 16, color: HISYInk.mute) }
                }.padding(.top, 20)
            }
            if let note = card.note, !note.isEmpty {
                Text(note).hisyBody(16, line: 24, color: HISYInk.mute).fixedSize(horizontal: false, vertical: true).padding(.top, 24)
                    .accessibilityIdentifier("hisyNote")
            }
        }
    }

    private var importTaste: some View {
        let groups = card.tagGroups
        let titled = !(groups.count == 1 && groups[0].key == "interest")
        let dislikes = (card.tags ?? []).contains { $0.dislike }
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(groups.enumerated()), id: \.element.key) { i, g in
                VStack(alignment: .leading, spacing: 8) {
                    if titled { Text(g.title).hisyBody(14, .semibold, line: 20) }
                    HISYFlow(spacing: 8) {
                        ForEach(Array(g.tags.enumerated()), id: \.offset) { _, t in HISYTag(tag: t, changed: changed.contains(t.choiceText)) }
                    }
                }.padding(.top, i == 0 ? (titled ? 20 : 24) : 14)
            }
            HStack(spacing: 10) {
                HISYEvidenceChip(evidence: card.evidence)
                if dislikes { Text("Dashed = not for you").hisyBody(12, line: 16, color: HISYInk.mute) }
            }.padding(.top, 16)
            if let note = card.note, !note.isEmpty {
                Text(note).hisyBody(16, line: 24, color: HISYInk.mute).fixedSize(horizontal: false, vertical: true).padding(.top, 24)
                    .accessibilityIdentifier("hisyNote")
            }
        }
    }

    /// help: ≤3 tiles, label + sub + "I'll ask first" / "I'll just do it" (the server's choice on), card evidence.
    private var help: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array((card.help ?? []).enumerated()), id: \.offset) { i, t in
                VStack(alignment: .leading, spacing: 2) {
                    Text(t.label).hisyBody(15, .medium, line: 22).fixedSize(horizontal: false, vertical: true)
                    if !t.sub.isEmpty { Text(t.sub).hisyBody(12, line: 16, color: HISYInk.mute) }
                    HStack(spacing: 8) {
                        option("I’ll ask first", on: t.mode == .askFirst)
                        option("I’ll just do it", on: t.mode == .justDoIt)
                    }.padding(.top, 10)
                }
                .padding(.horizontal, 21).padding(.vertical, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.white, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(changed.contains(t.label) ? HISYInk.blue : HISYInk.line, lineWidth: changed.contains(t.label) ? 1.5 : 1))
                .accessibilityElement(children: .combine).accessibilityValue(changed.contains(t.label) ? "changed" : "")
                .accessibilityIdentifier("hisyHelp")
                .padding(.top, i == 0 ? 20 : 0)
            }
            HISYEvidenceChip(evidence: card.evidence).padding(.top, 6)
        }
    }

    private func option(_ title: String, on: Bool) -> some View {
        Text(title).hisyBody(14, on ? .semibold : .medium, line: 20, color: on ? HISYInk.blueText : HISYInk.ink)
            .frame(maxWidth: .infinity).frame(height: 40)
            .background(on ? HISYInk.blueSoft : Color.white, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(on ? HISYInk.blueSoft : HISYInk.line, lineWidth: 1))
            .accessibilityAddTraits(on ? .isSelected : [])
    }

    /// lines: ⊘ rows with evidence chips and inset dividers, then the app's own "And always" box.
    private var lines: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(card.items.enumerated()), id: \.offset) { i, item in
                HStack(alignment: .top, spacing: 12) {
                    Image("hisy-stop").resizable().renderingMode(.template).foregroundStyle(HISYInk.blue).frame(width: 20, height: 20).padding(.top, 2)
                    VStack(alignment: .leading, spacing: 8) {
                        Text(item.text).hisyBody(16, line: 24).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("hisyItem")
                        HISYEvidenceChip(evidence: item.evidence)
                    }
                }
                .modifier(FixedMark(on: changed.contains(item.text)))
                .padding(.top, i == 0 ? 24 : 16)
                HISYInk.line.frame(height: 1).padding(.leading, 32).padding(.top, 18)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("And always").hisyBody(14, .semibold, line: 21)
                Text("I won’t buy, book, or message anyone for you.").hisyBody(16, line: 24).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 21).padding(.horizontal, 21).padding(.bottom, 16)
            .background(.white, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(HISYInk.line, lineWidth: 1))
            .padding(.top, 20)
            .accessibilityElement(children: .combine).accessibilityIdentifier("hisyAlways")
        }
    }

    /// unknowns: subline, ≤4 dashed tiles with a "?" badge, "Not in what you shared" (import only).
    private var unknowns: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let sub = card.subline, !sub.isEmpty {
                // the last words travel together: no lone "at a time." on the last line (TF 331, 3× check)
                Text(HISYCopy.keepTail(sub)).hisyBody(16, line: 24, color: HISYInk.mute).fixedSize(horizontal: false, vertical: true).padding(.top, 8)
            }
            VStack(spacing: 8) {
                ForEach(Array((card.unknowns ?? []).enumerated()), id: \.offset) { _, u in
                    HStack(spacing: 12) {
                        ZStack {
                            Circle().fill(HISYInk.blueSoft).frame(width: 28, height: 28)
                            Image("hisy-question").resizable().renderingMode(.template).foregroundStyle(HISYInk.blueText).frame(width: 16, height: 16)
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(u.topic).hisyBody(15, .medium, line: 22)
                            if !u.sub.isEmpty { Text(u.sub).hisyBody(12, line: 16, color: HISYInk.mute) }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 16).padding(.vertical, 12)
                    .background(.white, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(changed.contains(u.topic) ? HISYInk.blue : HISYInk.line,
                                                                            style: StrokeStyle(lineWidth: changed.contains(u.topic) ? 1.5 : 1, dash: [4, 3])))
                    .accessibilityElement(children: .combine).accessibilityIdentifier("hisyUnknown")
                }
            }.padding(.top, 20)
            if !skip {
                Text("Not in what you shared").hisyBody(12, line: 16, color: HISYInk.mute).padding(.top, 14)
            }
        }
    }
}

// MARK: - C1 / C2 "What's off?"

struct HISYFixSheet: View {
    @Bindable var model: AppState
    let card: StoryCard
    let width: CGFloat
    var onCancel: () -> Void
    var onSaved: () -> Void
    @State private var picked: [String] = []
    @State private var text = ""
    @State private var saving = false
    @State private var error: String?
    @State private var drag: CGFloat = 0
    @State private var shown = false
    @State private var dictation = HoldToSay()
    @FocusState private var typing: Bool

    private var typed: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    /// unknowns = answering one open topic: the answer is required (server: `items[0]` + `text`)
    private var answering: Bool { card.id == "unknowns" }
    private var canSave: Bool { !saving && (answering ? typed : (!picked.isEmpty || typed)) }
    /// PATCH /v1/profile takes at most 12 `items`
    static let maxPicks = 12

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.black.opacity(shown ? 0.4 : 0).ignoresSafeArea().onTapGesture { cancel() }
                .accessibilityLabel("Close").accessibilityAddTraits(.isButton)
            if shown {
                sheet.offset(y: max(0, drag)).transition(.move(edge: .bottom))
            }
        }
        .onAppear { withAnimation(.easeOut(duration: 0.28)) { shown = true } }
        .onDisappear { dictation.stop() }
        .onChange(of: dictation.text) { _, t in if !t.isEmpty { text = OnboardingClient.correctionText(t, trim: false) } }
    }

    private var sheet: some View {
        VStack(alignment: .leading, spacing: 0) {
            Capsule().fill(HISYInk.line).frame(width: 47, height: 5).frame(maxWidth: .infinity).padding(.top, 10)
            HISYTitle(text: "What’s off?").padding(.top, 21).accessibilityIdentifier("hisyFixTitle")
            Text("Pick what’s wrong, then tell me what’s right.").hisyBody(16, line: 24, color: HISYInk.mute).padding(.top, 8)
            ScrollView(.vertical, showsIndicators: false) {
                HISYFlow(spacing: 8) {
                    ForEach(card.correctionChoices, id: \.self) { c in chip(c) }
                }.frame(width: width - 62, alignment: .leading)
            }
            .frame(maxHeight: 240).fixedSize(horizontal: false, vertical: true)
            .padding(.top, 20)
            HStack(alignment: .top, spacing: 8) {
                ZStack(alignment: .topLeading) {
                    if text.isEmpty {
                        Text("Tell me what’s right").hisyBody(16, line: 24, color: HISYInk.mute).padding(14).allowsHitTesting(false)
                    }
                    TextField("", text: $text, axis: .vertical).font(TypeStyle.body(16)).foregroundStyle(HISYInk.ink)
                        .lineLimit(1...3).focused($typing).padding(14)
                        .onChange(of: text) { _, t in if t.utf16.count > OnboardingClient.correctionMaxLength { text = OnboardingClient.correctionText(t, trim: false) }; error = nil }
                        .accessibilityIdentifier("hisyFixText")
                }
                .frame(maxWidth: .infinity, minHeight: 88, maxHeight: 88, alignment: .topLeading)
                .background(.white, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(typing || dictation.listening ? HISYInk.blue : HISYInk.line, lineWidth: typing || dictation.listening ? 1.5 : 1))
                mic
            }.padding(.top, 20)
            Group {
                if let error {
                    Text(error).hisyBody(12, .medium, line: 16, color: HISYInk.error).accessibilityIdentifier("hisyFixError")
                } else if dictation.listening {
                    Text("Listening… let go when you’re done.").hisyBody(12, .medium, line: 16, color: HISYInk.blueText)
                } else if let note = dictation.note {
                    Text(note).hisyBody(12, line: 16, color: HISYInk.mute)
                } else {
                    Text("Type it, or hold the mic and say it.").hisyBody(12, line: 16, color: HISYInk.mute)
                }
            }.padding(.top, 8).accessibilityIdentifier("hisyFixHint")
            HISYPrimary(title: "Save", enabled: canSave, busy: saving, id: "hisyFixSave", action: save)
                .frame(maxWidth: .infinity).padding(.top, 24)
            HISYTextButton(title: "Cancel", id: "hisyFixCancel") { cancel() }.padding(.top, 6)
        }
        .padding(.horizontal, 31).padding(.bottom, 20)
        .frame(width: width, alignment: .leading)
        .background(HISYInk.canvas, in: UnevenRoundedRectangle(topLeadingRadius: 24, topTrailingRadius: 24))
        .gesture(DragGesture().onChanged { v in drag = v.translation.height }.onEnded { v in
            if v.translation.height > 90 && !saving { cancel() } else { withAnimation(.easeOut(duration: 0.2)) { drag = 0 } }
        })
    }

    private func chip(_ c: String) -> some View {
        let on = picked.contains(c)
        return Button {
            if on { picked.removeAll { $0 == c } }
            else if answering { picked = [c] }   // one open topic at a time
            else if picked.count < Self.maxPicks { picked.append(c) }
            error = nil
        } label: {
            HStack(spacing: 5) {
                if on { Image("hisy-check").resizable().renderingMode(.template).foregroundStyle(HISYInk.blueText).frame(width: 12, height: 12) }
                Text(c).hisyBody(14, on ? .semibold : .medium, line: 18, color: on ? HISYInk.blueText : HISYInk.ink)
                    .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(on ? HISYInk.blueSoft : Color.white, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(on ? HISYInk.blueSoft : HISYInk.line, lineWidth: 1))
        }.buttonStyle(.plain).accessibilityLabel(c).accessibilityAddTraits(on ? .isSelected : []).accessibilityIdentifier("hisyFixChip")
    }

    /// C2: hold to say (on-device speech → the field), let go to stop.
    private var mic: some View {
        let on = dictation.listening
        return ZStack {
            RoundedRectangle(cornerRadius: 12).fill(on ? HISYInk.blue : Color.white)
            RoundedRectangle(cornerRadius: 12).strokeBorder(on ? HISYInk.blue : HISYInk.line, lineWidth: 1)
            Image("hisy-mic").resizable().renderingMode(.template).foregroundStyle(on ? Color.white : HISYInk.ink).frame(width: 20, height: 20)
        }
        .frame(width: 52, height: 88)
        .contentShape(Rectangle())
        .gesture(DragGesture(minimumDistance: 0)
            .onChanged { _ in if !dictation.listening && !dictation.starting { typing = false; error = nil; dictation.start(prefix: text) } }
            .onEnded { _ in dictation.stop() })
        .accessibilityElement().accessibilityLabel("Hold to say").accessibilityAddTraits(.isButton)
        .accessibilityValue(on ? "listening" : "")
        .accessibilityIdentifier("hisyMic")
    }

    private func cancel() {
        guard !saving else { return }   // the answer decides: the sheet closes on success, stays with the error line
        dictation.stop()
        typing = false
        withAnimation(.easeIn(duration: 0.22)) { shown = false }
        onCancel()
    }

    private func save() {
        typing = false
        dictation.stop()
        saving = true; error = nil
        Task {
            let line = await model.correctStory(cardId: card.id, items: picked, text: text)
            saving = false
            if let line { error = line } else { onSaved() }
        }
    }
}

// MARK: - hold to say

/// C2: on-device speech recognition while the mic is held (SFSpeechRecognizer, Speech permission asked on the first
/// hold). Debug UI tests set GENITA_FAKE_DICTATION to a line: the hold "hears" it without the mic or a permission
/// prompt and stays in C2 for 2.5 s after the finger lifts (time for the screenshot).
@MainActor @Observable final class HoldToSay {
    private(set) var listening = false
    private(set) var starting = false
    /// what was heard so far, after the text that was in the field
    private(set) var text = ""
    /// a one-line reason the mic can't be used (permission, no recognizer)
    private(set) var note: String?
    @ObservationIgnored private var prefix = ""
    @ObservationIgnored private var engine: AVAudioEngine?
    @ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var task: SFSpeechRecognitionTask?
    @ObservationIgnored private var fakeStop: Task<Void, Never>?
    /// the finger is still on the mic: the permission callbacks only start recording while this is true
    @ObservationIgnored private var held = false

    private var fake: String? {
        #if DEBUG
        return ProcessInfo.processInfo.environment["GENITA_FAKE_DICTATION"]
        #else
        return nil
        #endif
    }

    func start(prefix: String) {
        self.prefix = prefix.trimmingCharacters(in: .whitespacesAndNewlines)
        note = nil
        held = true
        if let fake {
            fakeStop?.cancel()
            listening = true
            text = join(fake)
            return
        }
        starting = true
        SFSpeechRecognizer.requestAuthorization { status in
            Task { @MainActor in
                guard status == .authorized else { self.starting = false; self.note = "Turn on Speech Recognition for Genita in Settings to say it."; return }
                AVAudioApplication.requestRecordPermission { ok in
                    Task { @MainActor in
                        guard ok else { self.starting = false; self.note = "Turn on the microphone for Genita in Settings to say it."; return }
                        guard self.held else { self.starting = false; return }   // let go while the prompt was up
                        self.begin()
                    }
                }
            }
        }
    }

    private func begin() {
        defer { starting = false }
        // on this phone only (AU audit P2): Genita's AI is Meta's; Apple's server speech recognition is never used
        // (it's not in the privacy notice). No en-US recognizer, or no on-device model → type it instead.
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")), recognizer.isAvailable,
              recognizer.supportsOnDeviceRecognition else {
            note = "Speech isn’t available on this iPhone. Type it instead."; return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let engine = AVAudioEngine()
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            request.requiresOnDeviceRecognition = true
            let input = engine.inputNode
            input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in request.append(buffer) }
            engine.prepare()
            try engine.start()
            self.engine = engine; self.request = request
            listening = true
            task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                let heard = result?.bestTranscription.formattedString
                let final = result?.isFinal ?? false
                Task { @MainActor in
                    guard let self else { return }
                    if let heard { self.text = self.join(heard) }
                    if final || error != nil { self.teardown() }
                }
            }
        } catch {
            teardown()
            note = "Speech isn’t available right now. Type it instead."
        }
    }

    func stop() {
        held = false
        if fake != nil {
            guard listening else { return }
            fakeStop?.cancel()
            fakeStop = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(2500))
                guard !Task.isCancelled else { return }
                self?.listening = false
            }
            return
        }
        guard listening else { return }
        request?.endAudio()
        engine?.stop()
        engine?.inputNode.removeTap(onBus: 0)
        listening = false
    }

    private func teardown() {
        engine?.stop()
        engine?.inputNode.removeTap(onBus: 0)
        task?.cancel()
        engine = nil; request = nil; task = nil
        listening = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func join(_ heard: String) -> String { prefix.isEmpty ? heard : prefix + " " + heard }
}
