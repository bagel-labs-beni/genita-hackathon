import SwiftUI
import UIKit

// SUM insight report — 춘식이 r02 "R1" (Chelsea 11/4 03:57: an MBTI / 사주 style "whoa, that's you", light mode only).
// Design: ./_qa-scripts/genita-splash/insight/index.html "R1" + "5. 정확한 값" (390 × 844 pt).
// One ScrollView on #FDFDFD, body x 24 / w 342; sections 34 apart, label → content 14; bottom CTA = Figma Button
// 313 × 50 r12 #111 Medium 16 (HISYPrimary) over a 150 pt fade. Data: GET /v1/profile/insights (InsightReport).
// The same view without the CTA is Settings "About you" (M02 lane).

enum InsightInk {
    static let canvas = HISYInk.canvas
    static let ink = HISYInk.ink
    static let mute = HISYInk.mute
    static let sub = Color(red: 110 / 255, green: 110 / 255, blue: 115 / 255)
    static let gray = Color(red: 154 / 255, green: 154 / 255, blue: 154 / 255)
    static let body = Color(red: 58 / 255, green: 58 / 255, blue: 58 / 255)
    static let line = Color(red: 237 / 255, green: 237 / 255, blue: 237 / 255)
    static let blue = HISYInk.blue
    static let blueSoft = HISYInk.blueSoft
    static let blueText = HISYInk.blueText
    static let track = Color(red: 238 / 255, green: 240 / 255, blue: 242 / 255)
    static let tick = Color(red: 213 / 255, green: 216 / 255, blue: 220 / 255)
    static let learn = Color(red: 244 / 255, green: 244 / 255, blue: 242 / 255)
    static let warnBg = Color(red: 1, green: 247 / 255, blue: 232 / 255)
    static let warnLine = Color(red: 245 / 255, green: 227 / 255, blue: 191 / 255)
    static let warnDot = Color(red: 251 / 255, green: 227 / 255, blue: 180 / 255)
    static let warnText = Color(red: 138 / 255, green: 75 / 255, blue: 0)
    static let chainLine = Color(red: 229 / 255, green: 231 / 255, blue: 235 / 255)
    static let cardBg = Color(red: 243 / 255, green: 241 / 255, blue: 237 / 255)
    static let chipLine = HISYInk.line
    static let red = Color(red: 200 / 255, green: 40 / 255, blue: 30 / 255)
}

extension View {
    /// Pretendard at a design size / line height.
    func insightText(_ size: CGFloat, _ weight: Font.Weight = .regular, line: CGFloat, color: Color = InsightInk.ink) -> some View {
        font(TypeStyle.body(size, weight)).lineSpacing(HISYType.spacing(size, line: line)).foregroundStyle(color)
    }
}

enum InsightCopy {
    /// No one-word last line: the last space becomes U+00A0 (type names are exempt).
    static func keepLast(_ s: String) -> String {
        guard let r = s.range(of: " ", options: .backwards) else { return s }
        return s.replacingCharacters(in: r, with: "\u{00A0}")
    }
    /// "So you want choices…" → "Want choices…" under the SO YOU label.
    static func chainBody(_ s: String, dropping prefix: String) -> String {
        var t = s.trimmingCharacters(in: .whitespaces)
        if t.lowercased().hasPrefix(prefix.lowercased()) { t = String(t.dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces) }
        return t.prefix(1).uppercased() + t.dropFirst()
    }
    static func quote(_ e: InsightEvidence, ai: String?) -> String {
        e.source == "answer" ? "You picked “\(e.quote)”" : "“\(e.quote)”" + (e.source == "import" ? " · \(ai ?? "your reply")" : " · our call")
    }
}

// MARK: - screen

struct InsightReportView: View {
    @Bindable var model: AppState
    /// SUM: "Start talking to {name}"; Settings About you: none
    var showsCTA = true
    @State private var fixing: InsightObservation?
    @State private var setupOpen = false
    @State private var appeared = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var report: InsightReport? { model.insightReport }
    private var name: String { model.companionDisplayName }

    var body: some View {
        GeometryReader { safe in
            let w = safe.size.width
            ZStack(alignment: .bottom) {
                InsightInk.canvas.ignoresSafeArea()
                ScrollView(.vertical, showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 0) {
                        header.padding(.top, 62)
                        if let report { content(report, width: w - 48) } else { loading }
                        Color.clear.frame(height: showsCTA ? 170 : 40)
                    }
                    .frame(width: w - 48, alignment: .leading)
                    .padding(.horizontal, 24)
                }
                if showsCTA {
                    LinearGradient(stops: [.init(color: InsightInk.canvas.opacity(0), location: 0), .init(color: InsightInk.canvas, location: 0.45)], startPoint: .top, endPoint: .bottom)
                        .frame(height: 150).allowsHitTesting(false).ignoresSafeArea(edges: .bottom)
                    HISYPrimary(title: "Start talking to \(name)", busy: model.savingPrefs, id: "insightStart") { model.saveSetupAndPrepare() }
                        .padding(.bottom, max(24, 108 - safe.safeAreaInsets.bottom - 50 + 24))
                }
            }
            .frame(width: w)
        }
        .background(InsightInk.canvas.ignoresSafeArea())
        .sheet(item: $fixing) { o in
            InsightFixSheet(model: model, observation: o) { fixing = nil }
                .presentationDetents([.height(440), .large]).presentationCornerRadius(24)
        }
        .task {
            if model.insightReport == nil || model.insightReport?.settings == nil { await model.loadInsights() }
        }
        .onAppear { withAnimation(reduceMotion ? .easeOut(duration: 0.2) : .spring(response: 0.5, dampingFraction: 0.85)) { appeared = true } }
    }

    // MARK: header

    private var header: some View {
        HStack(spacing: 12) {
            Group {
                if let data = model.setup.imageData ?? model.sceneImageData, let img = UIImage(data: data) {
                    Image(uiImage: img).resizable().scaledToFill()
                } else {
                    Circle().fill(InsightInk.blueSoft).overlay(Text(String(name.prefix(1)).uppercased()).insightText(15, .semibold, line: 20, color: InsightInk.blueText))
                }
            }
            .frame(width: 40, height: 40).clipShape(Circle()).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 0) {
                Text(name).insightText(15, .semibold, line: 20)
                Text("Here’s my read on you.").insightText(13, line: 18, color: InsightInk.mute)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var loading: some View {
        VStack(alignment: .leading, spacing: 14) {
            label("YOU’RE", blue: true).padding(.top, 34)
            HStack(spacing: 10) {
                ProgressView().tint(InsightInk.blue)
                Text("Putting it into words…").insightText(17, line: 24, color: InsightInk.body)
            }
            ForEach(0..<3, id: \.self) { _ in RoundedRectangle(cornerRadius: 8).fill(InsightInk.track).frame(height: 22) }
        }
        .accessibilityIdentifier("insightLoading")
    }

    // MARK: sections

    @ViewBuilder private func content(_ r: InsightReport, width: CGFloat) -> some View {
        typeSection(r, width: width)
        if !r.mix.isEmpty {
            section("YOUR MIX") {
                VStack(alignment: .leading, spacing: 18) { ForEach(r.mix) { InsightMixRow(mix: $0) } }
            }
        }
        if r.observations.isEmpty {
            section("WHAT I NOTICED") {
                Text(InsightCopy.keepLast("Most of you, I’ll learn as we talk.")).insightText(17, line: 24, color: InsightInk.body)
            }
        } else {
            section("WHAT I NOTICED") {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(r.observations) { o in
                        InsightTraitRow(observation: o, ai: model.setup.importAI,
                                        onRight: { Task { await model.insightVerdict(id: o.id, verdict: "right") } },
                                        onNotQuite: { fixing = o })
                        if o.id != r.observations.last?.id { Rectangle().fill(InsightInk.line).frame(height: 1) }
                    }
                }
            }
        }
        if !r.strengths.isEmpty {
            InsightNoteCard(title: "STRENGTHS", items: r.strengths.map { ($0.text, nil) }, warn: false).padding(.top, 34)
        }
        if !r.watchouts.isEmpty {
            InsightNoteCard(title: "WATCH-OUTS", items: r.watchouts.map { ($0.text, $0.fix) }, warn: true).padding(.top, 12)
        }
        if let chain = r.chain {
            section("SO ON OUR CALLS") { InsightChainView(chain: chain) }
        } else if !r.usage.isEmpty {
            section("SO ON OUR CALLS") { Text(InsightCopy.keepLast(r.usage)).insightText(17, .semibold, line: 23) }
        }
        if let type = r.type, let share = r.share {
            section("YOUR CARD") { InsightShareCard(type: type, title: share.title(name: model.setup.name), signature: share.lines) }
        }
        if !r.learning.isEmpty { learning(r.learning).padding(.top, 34) }
        if let s = r.settings ?? fallbackSettings { setupDetails(s).padding(.top, 24) }
    }

    @ViewBuilder private func typeSection(_ r: InsightReport, width: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            label("YOU’RE", blue: true)
            HStack(alignment: .top, spacing: 12) {
                Group {
                    if let type = r.type {
                        HISYTitle(text: type.name.hasSuffix(".") ? type.name : type.name + ".", size: 44, line: 48)
                    } else {
                        HISYTitle(text: InsightCopy.keepLast(r.headline), size: 34, line: 39)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .opacity(appeared ? 1 : 0).offset(y: appeared || reduceMotion ? 0 : 12)
                .animation(.easeOut(duration: 0.28).delay(0.2), value: appeared)
                .accessibilityAddTraits(.isHeader)
                Image(resource: "reference-orb-round").resizable().scaledToFit().frame(width: 92, height: 92)
                    .scaleEffect(appeared || reduceMotion ? 1 : 0.85).accessibilityHidden(true)
            }
            .padding(.top, 8)
            if let type = r.type {
                Text(InsightCopy.keepLast(type.line)).insightText(17, line: 24, color: InsightInk.body).padding(.top, 12)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) { ForEach(type.signature, id: \.self) { InsightChipView(label: $0) } }.padding(.top, 16)
            }
        }
        .padding(.top, 34)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("insightType")
    }

    private func label(_ text: String, blue: Bool = false) -> some View {
        Text(text).font(TypeStyle.body(12, .semibold)).tracking(2).foregroundStyle(blue ? InsightInk.blueText : InsightInk.mute).accessibilityAddTraits(.isHeader)
    }

    private func section<C: View>(_ title: String, @ViewBuilder _ body: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 14) { label(title); body() }.padding(.top, 34)
    }

    private func learning(_ items: [InsightLearning]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("I’ll learn these as we talk").insightText(15, .semibold, line: 20)
            HISYFlow(spacing: 8) {
                ForEach(items) { l in
                    Text(l.label).insightText(14, line: 18, color: InsightInk.body).padding(.horizontal, 12).frame(height: 30)
                        .overlay(RoundedRectangle(cornerRadius: 15).strokeBorder(InsightInk.chipLine, lineWidth: 1))
                }
            }
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(InsightInk.learn, in: RoundedRectangle(cornerRadius: 16))
        .accessibilityIdentifier("insightLearning")
    }

    /// The old SUM four lines when the report came without them (answers not sent yet).
    private var fallbackSettings: InsightSettings? {
        let a = model.setup.answers
        let initiative = a["initiative"].flatMap(Int.init).map { ["Only when asked", "By invitation", "Occasional check-ins", "When a deadline is at risk", "Anticipate"][min(4, max(0, $0))] } ?? "Only when asked"
        return InsightSettings(why: a["help"] ?? "Think with me", energy: model.setup.presence.sorted().joined(separator: ", "), initiative: initiative,
                               never: model.setup.boundaries.isEmpty ? "No messages or actions without approval" : model.setup.boundaries.sorted().joined(separator: ", "))
    }

    private func setupDetails(_ s: InsightSettings) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { withAnimation(.easeOut(duration: 0.2)) { setupOpen.toggle() } } label: {
                HStack {
                    Text("Setup details").insightText(15, .medium, line: 20)
                    Spacer()
                    Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold)).foregroundStyle(InsightInk.mute).rotationEffect(.degrees(setupOpen ? 180 : 0))
                }
                .frame(height: 48).contentShape(Rectangle())
            }
            .buttonStyle(.plain).accessibilityIdentifier("insightSetupDetails").accessibilityValue(setupOpen ? "expanded" : "collapsed")
            if setupOpen {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach([("Why", s.why), ("Energy", s.energy), ("Initiative", s.initiative), ("Never", s.never)], id: \.0) { row in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.0).insightText(13, .semibold, line: 16, color: InsightInk.mute)
                            Text(row.1).insightText(17, line: 24)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
                .padding(.bottom, 16)
            }
        }
        .overlay(alignment: .top) { Rectangle().fill(InsightInk.line).frame(height: 1) }
        .overlay(alignment: .bottom) { Rectangle().fill(InsightInk.line).frame(height: 1) }
    }
}

// MARK: - pieces

/// Signature / taste chip: like #D7F1FF / #00639F h32 r16; dislike white + 1.5 pt dashed #E3E3E3 + ✕ #949494.
struct InsightChipView: View {
    let label: String
    var dislike = false
    var body: some View {
        HStack(spacing: 5) {
            if dislike { Text("✕").insightText(13, .medium, line: 18, color: HISYInk.dislike).accessibilityHidden(true) }
            Text(label).insightText(15, .medium, line: 20, color: dislike ? HISYInk.dislike : InsightInk.blueText).lineLimit(1)
        }
        .padding(.horizontal, 13).frame(height: 32)
        .background(dislike ? Color.white : InsightInk.blueSoft, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(dislike ? InsightInk.chipLine : .clear, style: StrokeStyle(lineWidth: 1.5, dash: dislike ? [4, 3] : [])))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(dislike ? "Not for you: \(label)" : label)
    }
}

/// Options ←•——→ One answer: 5 ticks, the user's dot, and what they picked.
struct InsightMixRow: View {
    let mix: InsightMix
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(mix.left).insightText(14, .medium, line: 18)
                Spacer()
                Text(mix.right).insightText(14, .medium, line: 18, color: InsightInk.gray)
            }
            GeometryReader { g in
                let step = (g.size.width - 16) / 4
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 3).fill(InsightInk.track).frame(height: 6)
                    ForEach(0..<5, id: \.self) { i in Circle().fill(InsightInk.tick).frame(width: 4, height: 4).offset(x: 8 + step * CGFloat(i) - 2) }
                    Circle().fill(InsightInk.blue).frame(width: 16, height: 16).overlay(Circle().strokeBorder(InsightInk.canvas, lineWidth: 3))
                        .shadow(color: .black.opacity(0.18), radius: 2, y: 1)
                        .offset(x: step * CGFloat(min(4, max(0, mix.position))))
                }
                .frame(height: 16)
            }
            .frame(height: 16)
            if let e = mix.evidence {
                Text("You picked “\(e.quote)”").insightText(12, line: 16, color: InsightInk.mute)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(mix.left) or \(mix.right.lowercased()): \(mix.position == 2 ? "in the middle" : "closer to " + (mix.position < 2 ? mix.left.lowercased() : mix.right.lowercased())).\(mix.evidence.map { " You picked \($0.quote)." } ?? "")")
    }
}

/// WHAT I NOTICED row: claim (serif 22/28, "I think" grey for medium), its receipts, That's me · Not quite.
struct InsightTraitRow: View {
    let observation: InsightObservation
    let ai: String?
    let onRight: () -> Void
    let onNotQuite: () -> Void
    var body: some View {
        let o = observation
        VStack(alignment: .leading, spacing: 8) {
            claim(o).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("insightClaim")
            if !o.chips.isEmpty {
                HISYFlow(spacing: 8) { ForEach(o.chips, id: \.self) { InsightChipView(label: $0.label, dislike: $0.dislike) } }
            }
            ForEach(o.evidence.filter { !($0.source == "answer" && !o.chips.isEmpty) }, id: \.self) { e in
                Text(InsightCopy.keepLast(InsightCopy.quote(e, ai: ai))).insightText(14, line: 20, color: InsightInk.sub)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 18) {
                Button(action: onRight) {
                    HStack(spacing: 6) {
                        if o.verdict == "right" {
                            Circle().fill(InsightInk.blue).frame(width: 20, height: 20)
                                .overlay(Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.white))
                        } else { Text("✓").insightText(14, .medium, line: 18) }
                        Text("That’s me").insightText(14, .medium, line: 18)
                    }
                    .frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(o.verdict == "right").accessibilityIdentifier("insightRight")
                .accessibilityValue(o.verdict == "right" ? "selected" : "")
                Button(action: onNotQuite) {
                    Text("Not quite").insightText(14, .medium, line: 18, color: InsightInk.mute).frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityIdentifier("insightNotQuite")
            }
        }
        .padding(.vertical, 16)
    }

    private func claim(_ o: InsightObservation) -> Text {
        let size: CGFloat = 22
        let body = InsightCopy.keepLast(o.isMedium ? o.claim.prefix(1).lowercased() + o.claim.dropFirst() : o.claim)
        let main = Text(body).foregroundColor(InsightInk.ink)
        let text = o.isMedium ? Text("I think ").foregroundColor(InsightInk.gray) + main : main
        return text.font(TypeStyle.title(size)).kerning(-0.2)
    }
}

/// Strengths (white, + #D7F1FF) / Watch-outs (#FFF7E8, ! #FBE3B4, fix line indented 30).
struct InsightNoteCard: View {
    let title: String
    let items: [(String, String?)]
    let warn: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(TypeStyle.body(12, .semibold)).tracking(2).foregroundStyle(warn ? InsightInk.warnText : InsightInk.mute).accessibilityAddTraits(.isHeader)
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .top, spacing: 10) {
                        Circle().fill(warn ? InsightInk.warnDot : InsightInk.blueSoft).frame(width: 20, height: 20)
                            .overlay(Text(warn ? "!" : "+").font(TypeStyle.body(14, .bold)).foregroundStyle(warn ? InsightInk.warnText : InsightInk.blueText))
                            .padding(.top, 1).accessibilityHidden(true)
                        Text(InsightCopy.keepLast(item.0)).insightText(16, .medium, line: 22).fixedSize(horizontal: false, vertical: true)
                    }
                    if let fix = item.1 {
                        Text(InsightCopy.keepLast(fix)).insightText(14, line: 20, color: InsightInk.warnText).padding(.leading, 30).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
        .padding(.horizontal, 16).padding(.top, 16).padding(.bottom, 18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(warn ? InsightInk.warnBg : Color.white, in: RoundedRectangle(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(warn ? InsightInk.warnLine : InsightInk.line, lineWidth: 1))
        .accessibilityIdentifier(warn ? "insightWatchouts" : "insightStrengths")
    }
}

/// YOU'RE → SO YOU → SO I'LL on a 2 pt line with 10 pt dots.
struct InsightChainView: View {
    let chain: InsightChain
    var body: some View {
        let steps = [("YOU’RE", InsightCopy.chainBody(chain.youAre, dropping: "You")), ("SO YOU", InsightCopy.chainBody(chain.soYou, dropping: "So you")),
                     ("SO I’LL", InsightCopy.chainBody(chain.soIll, dropping: "So I'll"))]
        VStack(alignment: .leading, spacing: 22) {
            ForEach(steps, id: \.0) { step in
                HStack(alignment: .top, spacing: 14) {
                    Circle().fill(InsightInk.blue).frame(width: 10, height: 10).overlay(Circle().strokeBorder(InsightInk.canvas, lineWidth: 3).frame(width: 16, height: 16)).padding(.top, 3)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(step.0).font(TypeStyle.body(11, .semibold)).tracking(2).foregroundStyle(InsightInk.mute)
                        Text(InsightCopy.keepLast(step.1)).insightText(17, .semibold, line: 23).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
        .background(alignment: .leading) { Rectangle().fill(InsightInk.chainLine).frame(width: 2).padding(.leading, 4).padding(.vertical, 6) }
        .accessibilityIdentifier("insightChain")
    }
}

/// YOUR CARD: #F3F1ED r24, "{name} is" + type (serif 32/36) + signature pills + "genita"; "Share my card" → 1080 × 1350.
struct InsightShareCard: View {
    let type: InsightType
    let title: String
    let signature: [String]
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            card.frame(maxWidth: .infinity)
            if let image = rendered {
                ShareLink(item: image, preview: SharePreview(title, image: image)) {
                    Text("Share my card").insightText(15, .medium, line: 20).padding(.horizontal, 16).frame(height: 36)
                        .overlay(Capsule().strokeBorder(InsightInk.chipLine, lineWidth: 1))
                }
                .buttonStyle(.plain).accessibilityIdentifier("insightShare")
            }
        }
    }

    private var isPrefix: String { title.hasSuffix(type.name) ? String(title.dropLast(type.name.count)).trimmingCharacters(in: .whitespaces) : title }

    var card: some View {
        ZStack(alignment: .topLeading) {
            InsightInk.cardBg
            Image(resource: "reference-orb-round").resizable().scaledToFit().frame(width: 130, height: 130).offset(x: 14, y: -14)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                Text(isPrefix).insightText(13, .medium, line: 18, color: InsightInk.sub)
                Text(type.name).font(TypeStyle.title(32)).foregroundStyle(InsightInk.ink).frame(maxWidth: 240, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    ForEach(signature, id: \.self) { s in Text(s).insightText(13, .medium, line: 18).padding(.horizontal, 10).frame(height: 26).background(.white, in: Capsule()) }
                }
                .padding(.top, 8)
            }
            .padding(.horizontal, 22).padding(.top, 22).padding(.bottom, 20)
            Text("genita").insightText(13, .semibold, line: 18).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing).padding(.trailing, 20).padding(.bottom, 18)
        }
        .frame(minHeight: 170)
        .clipShape(RoundedRectangle(cornerRadius: 24))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("insightCard")
    }

    /// The card at 1080 × 1350 for the share sheet.
    @MainActor private var rendered: Image? {
        let view = card.frame(width: 342, height: 427.5).padding(0)
        let r = ImageRenderer(content: view)
        r.scale = 1080 / 342
        guard let ui = r.uiImage else { return nil }
        return Image(uiImage: ui)
    }
}

/// "Not quite": what's off (quick chips) and/or what's right, Save · Remove this.
struct InsightFixSheet: View {
    @Bindable var model: AppState
    let observation: InsightObservation
    let done: () -> Void
    @State private var pick: String?
    @State private var text = ""
    @State private var saving = false
    @State private var error: String?
    private static let quick = ["Sometimes", "Not really me", "It’s the opposite"]

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) { content }.scrollBounceBehavior(.basedOnSize).background(InsightInk.canvas)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 14) {
            HISYTitle(text: "What’s off?", size: 28, line: 32).padding(.top, 28)
            Text("Pick one, or tell me what’s right.").insightText(15, line: 22, color: InsightInk.mute)
            HISYFlow(spacing: 8) {
                ForEach(Self.quick, id: \.self) { q in
                    Button { pick = pick == q ? nil : q } label: {
                        Text(q).insightText(15, .medium, line: 20, color: pick == q ? InsightInk.blueText : InsightInk.ink).padding(.horizontal, 13).frame(height: 32)
                            .background(pick == q ? InsightInk.blueSoft : .white, in: RoundedRectangle(cornerRadius: 16))
                            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(pick == q ? .clear : InsightInk.chipLine, lineWidth: 1))
                    }
                    .buttonStyle(.plain).accessibilityAddTraits(pick == q ? .isSelected : [])
                }
            }
            TextField("What’s right?", text: $text, axis: .vertical).font(TypeStyle.body(16)).lineLimit(2...3)
                .padding(12).background(Color(white: 0.96), in: RoundedRectangle(cornerRadius: 12)).accessibilityIdentifier("insightFixText")
            if let error { Text(error).insightText(13, line: 18, color: HISYInk.error) }
            HStack {
                Spacer()
                HISYPrimary(title: "Save", enabled: pick != nil || !text.trimmingCharacters(in: .whitespaces).isEmpty, busy: saving, id: "insightFixSave") { send(correction: correction) }
                Spacer()
            }
            Button { send(correction: nil) } label: {
                Text("Remove this").insightText(15, .medium, line: 22, color: InsightInk.red).frame(maxWidth: .infinity).frame(height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).accessibilityIdentifier("insightRemove")
        }
        .padding(.horizontal, 24).padding(.bottom, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var correction: String {
        [pick, text.trimmingCharacters(in: .whitespacesAndNewlines)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ". ")
    }

    private func send(correction: String?) {
        guard !saving else { return }
        saving = true; error = nil
        Task {
            let e = await model.insightVerdict(id: observation.id, verdict: "not_me", correction: correction)
            saving = false
            if let e { error = e } else { done() }
        }
    }
}
