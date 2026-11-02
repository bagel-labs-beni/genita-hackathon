import SwiftUI
import AppKit

/// F7 · #121 · MAC-RS: the result sheet on the Mac call window (390 × 844 design space), Figma
/// rp1wR9pxV0IsgyjvOcwo92 nodes 184:2 (MAC-RS-a searching) and 184:68 (MAC-RS-b two results).
/// Same r03 interaction as the iPhone (PF-1): the shared `FindsModel` drives searching → rising → half → full,
/// peek, close + Undo, and the same drag / tap rules. Product links open in the Mac's default browser
/// (MAC-LINK, 184:150), never inside the sheet.
enum MacSheetInk {
    static let ink = Color(white: 17.0 / 255)
    static let sheet = Color(white: 254.0 / 255)
    static let onInk = Color(white: 253.0 / 255)
    static let mute = Color(white: 115.0 / 255)
    static let faint = Color(white: 158.0 / 255)
    static let line = Color(white: 232.0 / 255)
    static let handle = Color(white: 219.0 / 255)
    static let chip = Color(white: 242.0 / 255)
    static let chipBlue = Color(red: 222.0 / 255, green: 243.0 / 255, blue: 1)
    static let chipBlueText = Color(red: 0, green: 106.0 / 255, blue: 163.0 / 255)
    static let scan = Color(red: 0, green: 179.0 / 255, blue: 1)
    static let pill = Color(white: 17.0 / 255).opacity(0.84)
    static func sans(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .custom("PretendardVariable-" + (weight == .medium ? "Medium" : weight == .semibold ? "SemiBold" : "Regular"), fixedSize: size)
    }
    static func serif(_ size: CGFloat) -> Font { .custom("KMUTTF-SungkokSemiSerif", fixedSize: size) }
}

extension SheetState {
    /// MAC-RS-a is taller than the iPhone's 148: the searching row plus the scan line (198 visible).
    var macHeight: CGFloat { self == .searching ? 198 : height }
}

struct MacResultSheet: View {
    let finds: FindsModel
    /// MAC-LINK: a product page was opened in the default browser.
    var opened: (ProductPick) -> Void
    @State private var dragY: CGFloat = 0

    private var entry: FindEntry? { finds.current }
    private var card: FindCard? { entry?.card }

    var body: some View {
        let visible = finds.state.macHeight
        ZStack(alignment: .top) {
            UnevenRoundedRectangle(topLeadingRadius: 30, topTrailingRadius: 30).fill(MacSheetInk.sheet)
                .shadow(color: MacSheetInk.ink.opacity(0.18), radius: 16, y: -8)
            ZStack(alignment: .top) {
                searching.opacity(finds.state == .searching ? 1 : 0)
                peek.opacity(finds.state == .peek ? 1 : 0)
                results.opacity([.rising, .half, .full].contains(finds.state) ? 1 : 0)
            }.animation(.easeOut(duration: 0.2), value: finds.state)
            grab
        }
        .frame(width: 390, height: 728)
        .clipShape(UnevenRoundedRectangle(topLeadingRadius: 30, topTrailingRadius: 30))
        .offset(y: 844 - visible + max(-120, dragY))
        .animation(.spring(response: 0.42, dampingFraction: 0.86), value: finds.state)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Finds from this call")
        .accessibilityIdentifier("macResultSheet")
        .accessibilityValue(finds.state.rawValue)
    }

    // 96 × 44 grab target, 47 × 5 handle (r03 `.grab`); one state per gesture.
    private var grab: some View {
        Capsule().fill(MacSheetInk.handle).frame(width: 47, height: 5).padding(.top, 26)
            .frame(width: 96, height: 44, alignment: .top).contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 4)
                .onChanged { v in finds.touching = true; dragY = v.translation.height * 0.6 }
                .onEnded { v in
                    finds.touching = false
                    let velocity = (v.predictedEndTranslation.height - v.translation.height) * 4
                    withAnimation(.spring(response: 0.42, dampingFraction: 0.86)) { dragY = 0; finds.dragEnded(translation: v.translation.height, velocity: velocity) }
                })
            .onTapGesture { withAnimation { if finds.state == .peek { finds.tapPeek() } else if finds.state == .half { finds.state = .full } } }
            .accessibilityElement().accessibilityLabel("Find sheet. Drag up or down to resize").accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("macResultGrab")
    }

    // MARK: MAC-RS-a · searching

    private var searching: some View {
        let failed = entry?.failed
        return VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 12) {
                MacTalkWave(color: MacSheetInk.ink)
                VStack(alignment: .leading, spacing: 0) {
                    Text(failed?.message ?? entry?.searchTitle ?? "Looking")
                        .font(MacSheetInk.sans(16, .medium)).foregroundStyle(MacSheetInk.ink).lineSpacing(4).lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    if failed == nil, let detail = entry?.searchDetail, !detail.isEmpty {
                        Text(detail).font(MacSheetInk.sans(14)).foregroundStyle(MacSheetInk.mute).lineLimit(1)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
                Button(failed == nil ? "Stop" : "Close") { withAnimation { failed == nil ? finds.stop() : finds.close() } }
                    .buttonStyle(.plain).font(MacSheetInk.sans(14, .medium)).foregroundStyle(MacSheetInk.ink)
                    .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle()).accessibilityIdentifier("macResultStop")
            }.frame(minHeight: 68)
            if failed == nil { MacScanLine().padding(.top, 6) }
        }
        .padding(.horizontal, 38).padding(.top, 32)
        .frame(maxHeight: .infinity, alignment: .top)
    }

    // MARK: peek (148): the card's title, tap to open

    private var peek: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(card?.eyebrow ?? "").font(MacSheetInk.sans(12)).foregroundStyle(MacSheetInk.faint)
                Text(card?.title ?? "").font(MacSheetInk.sans(16, .medium)).foregroundStyle(MacSheetInk.ink).lineLimit(1)
            }.frame(maxWidth: .infinity, alignment: .leading)
            Button { withAnimation { finds.close() } } label: { Image(systemName: "xmark").font(.system(size: 15, weight: .medium)).frame(width: 44, height: 44) }
                .buttonStyle(.plain).foregroundStyle(MacSheetInk.ink).accessibilityLabel("Close. It stays in Finds")
        }
        .padding(.horizontal, 38).padding(.top, 52)
        .frame(maxHeight: .infinity, alignment: .top)
        .contentShape(Rectangle())
        .onTapGesture { withAnimation { finds.tapPeek() } }
    }

    // MARK: MAC-RS-b · results

    @ViewBuilder private var results: some View {
        if let card {
            let picks = card.kind == .product ? ProductPicks.picks(from: card) : []
            let evidence = ProductPicks.evidence(from: card)
            ZStack(alignment: .bottom) {
                ScrollView(.vertical, showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 0) {
                        header(card, count: max(finds.entries.filter { $0.card != nil }.count, 1))
                        Text(card.title).font(MacSheetInk.serif(30)).foregroundStyle(MacSheetInk.ink).lineLimit(2).padding(.top, 6)
                            .accessibilityIdentifier("macResultTitle")
                        if !card.subtitle.isEmpty {
                            Text(card.subtitle).font(MacSheetInk.sans(14)).foregroundStyle(MacSheetInk.mute).padding(.top, 2)
                        }
                        if picks.isEmpty {
                            generic(card).padding(.top, 16)
                        } else {
                            HStack(alignment: .top, spacing: 12) {
                                ForEach(Array(picks.enumerated()), id: \.element.id) { i, pick in
                                    MacProductCard(pick: pick, primary: i == 0, imageURL: productImage(card, i).flatMap { CallController.shared.findsURL($0) }) { open(pick) }
                                }
                                if picks.count == 1 { Spacer(minLength: 0) }
                            }.padding(.top, 16)
                        }
                        if !evidence.lines.isEmpty {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Why these").font(MacSheetInk.sans(12)).foregroundStyle(MacSheetInk.faint)
                                ForEach(Array(evidence.lines.enumerated()), id: \.offset) { i, line in
                                    Text(line).font(MacSheetInk.sans(14)).foregroundStyle(i == 0 ? MacSheetInk.ink : MacSheetInk.mute)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }.padding(.top, 36).accessibilityElement(children: .combine).accessibilityIdentifier("macResultEvidence")
                        }
                        Color.clear.frame(height: 110)
                    }.padding(.horizontal, 38).padding(.top, 64)
                }
                Button { finds.toggleSave() } label: {
                    Text(entry?.saved == true ? "Saved to Finds" : "Save to Finds").font(MacSheetInk.sans(16, .medium)).foregroundStyle(MacSheetInk.onInk)
                        .frame(width: 314, height: 50).background(MacSheetInk.ink, in: RoundedRectangle(cornerRadius: 12))
                }.buttonStyle(.plain).padding(.bottom, 56).accessibilityIdentifier("macResultSave")
            }
        }
    }

    private func header(_ card: FindCard, count: Int) -> some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 8) {
                Text(card.eyebrow).font(MacSheetInk.sans(14)).foregroundStyle(MacSheetInk.mute)
                HStack(spacing: 4) {
                    ForEach(0..<min(count, 6), id: \.self) { i in Circle().fill(i == finds.page ? MacSheetInk.ink : MacSheetInk.handle).frame(width: 6, height: 6) }
                }.accessibilityLabel("Find \(finds.page + 1) of \(count)")
            }
            Spacer()
            Button { finds.toggleSave() } label: { Image(systemName: entry?.saved == true ? "bookmark.fill" : "bookmark").font(.system(size: 16)).frame(width: 44, height: 44) }
                .buttonStyle(.plain).foregroundStyle(MacSheetInk.ink).accessibilityLabel("Save to Finds")
            Button { withAnimation { finds.close() } } label: { Image(systemName: "xmark").font(.system(size: 16)).frame(width: 44, height: 44) }
                .buttonStyle(.plain).foregroundStyle(MacSheetInk.ink).accessibilityLabel("Close. It stays in Finds").accessibilityIdentifier("macResultClose")
        }
    }

    /// Recipe / outfit / link cards on the Mac: the same sheet, text only (camera boxes stay on the iPhone).
    private func generic(_ card: FindCard) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(card.steps.enumerated()), id: \.offset) { _, step in
                Text("• " + step.text).font(MacSheetInk.sans(15)).foregroundStyle(MacSheetInk.ink).fixedSize(horizontal: false, vertical: true)
            }
            ForEach(Array(card.sources.enumerated()), id: \.offset) { _, source in
                if let url = ExternalLink.web(source.url) {
                    Button { NSWorkspace.shared.open(url) } label: {
                        Text("\(source.title) ↗").font(MacSheetInk.sans(14, .medium)).foregroundStyle(MacSheetInk.ink).underline()
                    }.buttonStyle(.plain)
                }
            }
        }
    }

    /// The server's product picture (`hero`, ready) on the first card; the others show their shop's name.
    private func productImage(_ card: FindCard, _ i: Int) -> String? {
        guard i == 0, let hero = card.hero, hero.status == .ready else { return nil }
        return hero.url
    }

    private func open(_ pick: ProductPick) {
        NSWorkspace.shared.open(pick.url)
        opened(pick)
    }
}

/// One product of MAC-RS-b: 151 wide, square picture, name, brand · price, reason chips, Open in browser.
struct MacProductCard: View {
    let pick: ProductPick
    let primary: Bool
    var imageURL: URL?
    let open: () -> Void
    @State private var hover = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            picture.frame(width: 151, height: 151).clipShape(RoundedRectangle(cornerRadius: 8))
            Text(pick.name).font(MacSheetInk.sans(15, .medium)).foregroundStyle(MacSheetInk.ink).lineLimit(1).padding(.top, 14)
            Text(pick.brandLine).font(MacSheetInk.sans(13)).foregroundStyle(MacSheetInk.mute).lineLimit(1).padding(.top, 6)
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(pick.reasons.prefix(2).enumerated()), id: \.offset) { i, reason in
                    Text(reason).font(MacSheetInk.sans(12, .medium)).lineLimit(1)
                        .foregroundStyle(i == 0 ? MacSheetInk.chipBlueText : MacSheetInk.ink)
                        .padding(.horizontal, 10).frame(height: 24)
                        .background(i == 0 ? MacSheetInk.chipBlue : MacSheetInk.chip, in: Capsule())
                }
            }.padding(.top, 10).frame(minHeight: 58, alignment: .top)
            Button(action: open) {
                Text("Open in browser ↗").font(MacSheetInk.sans(14, .medium))
                    .foregroundStyle(primary || hover ? MacSheetInk.onInk : MacSheetInk.ink)
                    .frame(width: 151, height: 34)
                    .background(primary || hover ? MacSheetInk.ink : MacSheetInk.sheet, in: RoundedRectangle(cornerRadius: 6))
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(primary || hover ? .clear : MacSheetInk.line))
            }.buttonStyle(.plain).onHover { hover = $0 }.padding(.top, 6)
                .accessibilityLabel("Open \(pick.name) in your browser").accessibilityIdentifier("macOpenInBrowser")
        }.frame(width: 151, alignment: .leading)
    }

    @ViewBuilder private var picture: some View {
        if let imageURL {
            AsyncImage(url: imageURL) { phase in
                if let image = phase.image { image.resizable().scaledToFill() } else { placeholder }
            }
        } else { placeholder }
    }
    private var placeholder: some View {
        ZStack { MacSheetInk.chip; Text(pick.brand).font(MacSheetInk.sans(12)).foregroundStyle(MacSheetInk.faint) }
    }
}

/// MAC-LINK (184:150): after a link opens in the browser, the Genita window offers to look at it together.
/// "Share this window" opens the system picker (window mode) for the share + ask path (F9, D40).
struct MacLinkPrompt: View {
    let share: () -> Void
    let notNow: () -> Void
    var body: some View {
        ZStack(alignment: .topLeading) {
            Text("Opened it in your browser. Want me to look at it with you?")
                .font(MacSheetInk.sans(14)).foregroundStyle(MacSheetInk.onInk).lineSpacing(4)
                .padding(.horizontal, 12).padding(.vertical, 9)
                .frame(width: 350, alignment: .leading)
                .background(MacSheetInk.pill, in: RoundedRectangle(cornerRadius: 14))
                .position(x: 195, y: 124 + 28)
                .accessibilityIdentifier("macLinkPrompt")
            VStack(spacing: 6) {
                Button(action: share) {
                    Text("Share this window").font(MacSheetInk.sans(16, .medium)).foregroundStyle(MacSheetInk.ink)
                        .frame(width: 350, height: 58).background(MacSheetInk.onInk, in: RoundedRectangle(cornerRadius: 12))
                }.buttonStyle(.plain).accessibilityIdentifier("macShareThisWindow")
                Button(action: notNow) {
                    Text("Not now").font(MacSheetInk.sans(15)).foregroundStyle(MacSheetInk.onInk.opacity(0.8)).frame(width: 350, height: 44).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityIdentifier("macLinkNotNow")
            }.position(x: 195, y: 760)
        }.frame(width: 390, height: 844, alignment: .topLeading)
    }
}

/// The call's one-line status (S09 pill), Mac copy of the iPhone's cue: "Listening", "{name} is talking"…
/// At full sheet it carries the card's spoken line, as MAC-RS-b shows.
struct MacCallCue: View {
    let text: String
    var wave = true
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if wave { MacTalkWave(color: MacSheetInk.onInk).padding(.top, 4) }
            Text(text).font(MacSheetInk.sans(14, .medium)).foregroundStyle(MacSheetInk.onInk).lineSpacing(4).lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(MacSheetInk.pill, in: RoundedRectangle(cornerRadius: 18))
        .accessibilityElement(children: .combine).accessibilityIdentifier("macCallCue")
    }

    static func text(_ cue: CallCue, name: String) -> String? {
        switch cue {
        case .none: nil
        case .listening: "Listening"
        case .thinking: "\(name) is thinking"
        case .speaking: "\(name) is talking"
        case .interrupted: "Stopped. Go ahead."
        case .reconnecting: "Reconnecting…"
        case .answerFailed: "Couldn’t get an answer."
        case .micBlocked: "Microphone is off for Genita."
        }
    }
}

/// Four 2 × 12 bars (the board's talk wave).
struct MacTalkWave: View {
    var color: Color
    @State private var phase = false
    var body: some View {
        HStack(spacing: 2) {
            ForEach(0..<4, id: \.self) { i in
                Capsule().fill(color).frame(width: 2, height: 12).scaleEffect(y: phase ? [0.5, 1, 0.7, 0.9][i] : [1, 0.6, 1, 0.5][i])
            }
        }.frame(width: 14, height: 12)
        .onAppear {
            guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion, ProcessInfo.processInfo.environment["GENITA_MAC_REVIEW_OUT"] == nil else { return }
            withAnimation(.easeInOut(duration: 0.5).repeatForever(autoreverses: true)) { phase = true }
        }
        .accessibilityHidden(true)
    }
}

/// r03 scan line: a blue segment across a 2 pt grey track while looking.
struct MacScanLine: View {
    @State private var x: CGFloat = 0
    var body: some View {
        ZStack(alignment: .leading) {
            Capsule().fill(MacSheetInk.line)
            Capsule().fill(MacSheetInk.scan).frame(width: 126).offset(x: x)
        }.frame(height: 2).clipped()
        .onAppear {
            guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion, ProcessInfo.processInfo.environment["GENITA_MAC_REVIEW_OUT"] == nil else { return }
            withAnimation(.easeInOut(duration: 1.4).repeatForever(autoreverses: true)) { x = 314 - 126 }
        }
        .accessibilityHidden(true)
    }
}
