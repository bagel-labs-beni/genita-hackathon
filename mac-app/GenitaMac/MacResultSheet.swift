import SwiftUI
import AppKit

/// F7 · #121 · MAC-RS (MF-1~3): the result sheet on the Mac call window (390 × 844 design space), Figma
/// rp1wR9pxV0IsgyjvOcwo92 nodes 184:2 (MAC-RS-a searching) and 184:68 (MAC-RS-b two results).
/// Same r03 interaction as the iPhone (PF-1): the shared `FindsModel` drives searching → rising → half → full,
/// peek, close + Undo, and the same drag / tap rules. Product links open in the Mac's default browser
/// (MAC-LINK, 184:150), never inside the sheet.
extension SheetState {
    /// Finds r01: searching is 328 like the iPhone (question title, stage line, 3 skeleton rows).
    /// Mac v2: the full sheet stops 54 pt lower so the face pip (top 28) never covers its ✕ and bookmark.
    var macHeight: CGFloat { self == .searching ? 328 : (self == .full && MacDesignV2.enabled ? 674 : height) }
}

struct MacResultSheet: View {
    /// The " · " parts of a "Why these" line, for the stacked form.
    static func parts(_ line: String) -> [String] { line.components(separatedBy: " · ").filter { !$0.isEmpty } }

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
                if finds.newFind != nil, [.half, .full].contains(finds.state) { newFindBanner }
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
        let failed = entry?.failureLines
        let retry = entry?.canRetry == true
        // MF-1 "Why": a refine stands on the last product answer of this call (none yet on a first search)
        let why = failed == nil && entry?.kind == .product
            ? ProductPicks.searchingWhy(after: finds.entries.filter { $0.id != entry?.id }.compactMap(\.card)) : nil
        return VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 12) {
                if failed == nil { MacSearchOrb() } else { MacTalkWave(color: MacSheetInk.ink) }
                VStack(alignment: .leading, spacing: 0) {
                    // one line each next to Stop, as the iPhone (#211): server copy, never wrapped, never a cut word
                    OneLineText(text: failed?.title ?? entry?.searchTitle ?? "Looking", font: MacSheetInk.sans(16, .medium), color: MacSheetInk.ink)
                        .accessibilityIdentifier("macResultSearchTitle")
                    if let failed {
                        if !failed.body.isEmpty {
                            OneLineText(text: failed.body, font: MacSheetInk.sans(14), color: MacSheetInk.mute, alternates: OneLineText.afterDot(failed.body))
                                .accessibilityIdentifier("macResultSearchDetail")
                        }
                    } else {
                        // r01: server detail first, then the steps it is taking, every 2 s, pushed up from below
                        MacStageLine(lines: MacStageLine.lines(detail: entry?.searchDetail ?? ""))
                            .accessibilityIdentifier("macResultSearchDetail")
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
                // PF-1d on the Mac too: a failed product search can be asked again; other failures close
                Button {
                    withAnimation { failed == nil ? finds.stop() : retry ? finds.retry() : finds.close() }
                } label: {
                    Text(failed == nil ? "Stop" : retry ? "Retry" : "Close").font(MacSheetInk.sans(14, .medium)).foregroundStyle(MacSheetInk.ink)
                        .padding(.horizontal, 14).frame(height: 36)
                        .background(MacSheetInk.sheet, in: Capsule())
                        .overlay(Capsule().strokeBorder(MacFindsInk.line, lineWidth: 1))
                        .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier(failed == nil ? "macResultStop" : retry ? "macResultRetry" : "macResultClose")
            }.frame(minHeight: 52)
            if let why {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Why").font(MacSheetInk.sans(12)).foregroundStyle(MacSheetInk.faint)
                    Text(why).font(MacSheetInk.sans(13)).foregroundStyle(MacSheetInk.ink).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                }.padding(.top, 10).accessibilityElement(children: .combine).accessibilityIdentifier("macResultSearchWhy")
            }
            if failed == nil {
                VStack(spacing: 14) {
                    ForEach(0..<(why == nil ? 3 : 2), id: \.self) { i in MacSkeletonRow(last: i == 2) }
                }.padding(.top, 18).accessibilityHidden(true)
            }
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
            let hidden = max(0, 728 - finds.state.macHeight)
            let evidence = ProductPicks.evidence(from: card)
            ZStack(alignment: .bottom) {
                MacScroll {
                    VStack(alignment: .leading, spacing: 0) {
                        header(card)
                        Text(card.title).font(MacSheetInk.serif(30)).foregroundStyle(MacSheetInk.ink).lineLimit(2).padding(.top, 6)
                            .accessibilityIdentifier("macResultTitle")
                        if !card.subtitle.isEmpty {
                            Text(card.subtitle).font(MacSheetInk.sans(14)).foregroundStyle(MacSheetInk.mute).padding(.top, 2)
                        }
                        // CW-02 (춘식이 11/4): the outfit's occasion, the grey "what you said" chip, 8 pt under the subtitle
                        if let occasion = card.occasionChip {
                            Text(occasion.text).font(MacSheetInk.sans(12, .medium)).lineLimit(1).truncationMode(.tail).foregroundStyle(MacSheetInk.ink)
                                .padding(.horizontal, 10).frame(height: 24).background(MacSheetInk.chip, in: Capsule())
                                .padding(.top, 8)
                                .accessibilityLabel(occasion.accessibilityLabel).accessibilityIdentifier("macOutfitOccasion")
                        }
                        let layout = card.cardLayout
                        if picks.isEmpty, layout == .recipe {
                            // r02: dish photo, ingredient tiles, numbered step cards (no camera boxes on the Mac)
                            MacRecipeCard(card: card).padding(.top, 16)
                        } else if picks.isEmpty, layout == .place {
                            MacPlaceList(card: card)
                        } else if picks.isEmpty, layout == .howTo {
                            MacHowTo(card: card)
                        } else if picks.isEmpty, layout != .outfit, !card.sources.isEmpty {
                            // r01: one row per result, picture first, the reason once
                            MacFindRows(rows: card.macFindRows, top: card.topPick?.index)
                        } else if picks.isEmpty {
                            // chip flow → the rest: 12 pt (춘식이 11/4), else the usual 16 under the subtitle
                            generic(card).padding(.top, card.occasionChip != nil ? 12 : 16)
                        } else {
                            HStack(alignment: .top, spacing: 12) {
                                ForEach(Array(picks.enumerated()), id: \.element.id) { i, pick in
                                    MacProductCard(pick: pick, primary: i == 0, imageURL: pick.image.flatMap { $0.status == .ready ? $0.url : nil }.flatMap { CallController.shared.findsURL($0) }) { open(pick) }
                                }
                                if picks.count == 1 { Spacer(minLength: 0) }
                            }.padding(.top, 16)
                        }
                        // r01: "Why these" is one quiet line under the results, never hidden behind the button
                        if !evidence.lines.isEmpty {
                            Text(evidence.lines.joined(separator: " · ")).font(MacSheetInk.sans(13)).foregroundStyle(MacSheetInk.mute)
                                .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                                .padding(.top, 18).accessibilityLabel("Why these: " + evidence.lines.joined(separator: ". "))
                                .accessibilityIdentifier("macResultEvidence")
                        }
                        // the part of the 728 frame below the visible sheet + the foot (12 + 50 + 24) + 16
                        Color.clear.frame(height: hidden + Self.footHeight + 16)
                    }.padding(.horizontal, 38).padding(.top, 64)
                }
                foot(hidden: hidden)
            }
        }
    }

    /// r01 foot: 12 pt sheet bar + 50 pt button + 24 pt to the VISIBLE bottom of the sheet, a 28 pt fade above.
    static let footHeight: CGFloat = 12 + 50 + 24

    private func foot(hidden: CGFloat) -> some View {
        // PF-1c: saved turns the one button grey (the Mac has no Finds tab to open; the card is in Finds on the iPhone)
        let saved = entry?.saved == true
        return VStack(spacing: 0) {
            LinearGradient(colors: [MacSheetInk.sheet.opacity(0), MacSheetInk.sheet], startPoint: .top, endPoint: .bottom)
                .frame(height: 28).allowsHitTesting(false)
            Button { finds.toggleSave() } label: {
                Text(saved ? "Saved to Finds" : "Save to Finds").font(MacSheetInk.sans(16, .medium)).foregroundStyle(saved ? MacSheetInk.ink : MacSheetInk.onInk)
                    .frame(width: 314, height: 50).contentShape(RoundedRectangle(cornerRadius: 12))
            }.buttonStyle(MacGlassButtonStyle(kind: saved ? .regular : .prominent)).accessibilityIdentifier("macResultSave").accessibilityValue(saved ? "saved" : "")
                .padding(.top, 12).padding(.bottom, 24 + hidden)
                .frame(maxWidth: .infinity).background(MacSheetInk.sheet)
        }
    }

    /// r03 #11: a result arrived while another is open — it never takes the card being read; the banner offers it.
    private var newFindBanner: some View {
        let title = finds.entries.first { $0.id == finds.newFind }?.card?.title ?? "A new find"
        return Button { withAnimation { finds.viewNewFind() } } label: {
            HStack(spacing: 8) {
                Text("New").font(MacSheetInk.sans(12, .medium)).foregroundStyle(MacSheetInk.chipBlueText)
                Text(title).font(MacSheetInk.sans(14, .medium)).foregroundStyle(MacSheetInk.onInk).lineLimit(1)
                Text("View").font(MacSheetInk.sans(14, .medium)).foregroundStyle(MacSheetInk.chipBlue)
            }.padding(.horizontal, 14).frame(height: 36).background(MacSheetInk.pill, in: Capsule())
        }.buttonStyle(.plain).padding(.top, 14).accessibilityIdentifier("macNewFind")
    }

    private func header(_ card: FindCard) -> some View {
        // one dot per result card, pointing at its real index (searches that failed have no dot)
        let carded = finds.entries.indices.filter { finds.entries[$0].card != nil }
        return headerRow(card, carded: carded)
    }

    private func headerRow(_ card: FindCard, carded: [Int]) -> some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 8) {
                Text(card.eyebrow).font(MacSheetInk.sans(14)).foregroundStyle(MacSheetInk.mute)
                // Mac v2: one result = no pager (a lone dot read as a stray mark, QA)
                if carded.count > 1 || !MacDesignV2.enabled { HStack(spacing: 0) {
                    ForEach(carded.suffix(6), id: \.self) { i in
                        Circle().fill(i == finds.page ? MacSheetInk.ink : MacSheetInk.handle).frame(width: 6, height: 6)
                            .padding(2).contentShape(Rectangle()).onTapGesture { withAnimation { finds.showPage(i) } }
                    }
                }.accessibilityLabel("Find \((carded.firstIndex(of: finds.page) ?? 0) + 1) of \(max(carded.count, 1))") }
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

    /// Dyno's demo video (2:22): the first card's Open in browser is filled ink, the other is white with a light blue
    /// outline; hover fills it.
    private var filled: Bool { primary || hover }
    private static let outlineBlue = Color(red: 156.0 / 255, green: 211.0 / 255, blue: 245.0 / 255)
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            picture.frame(width: 151, height: 151).clipShape(RoundedRectangle(cornerRadius: 12))
            Text(pick.name).font(MacSheetInk.sans(15, .medium)).foregroundStyle(MacSheetInk.ink).lineLimit(1).padding(.top, 14)
            Text(pick.brandLine).font(MacSheetInk.sans(13)).foregroundStyle(MacSheetInk.mute).lineLimit(1).minimumScaleFactor(0.8).padding(.top, 6)
            VStack(alignment: .leading, spacing: 6) {
                // D4: ✦ = your style (the import), “ = what they said — PF-1's chips, no colour legend
                if !pick.taste.isEmpty { chip(pick.taste, mark: ProductPicks.styleMark, fg: MacSheetInk.chipBlueText, bg: MacSheetInk.chipBlue).overlay(Capsule().strokeBorder(Self.outlineBlue, lineWidth: 1)).accessibilityIdentifier("macProductTaste") }
                if !pick.situation.isEmpty { chip(pick.situation, mark: ProductPicks.saidMark, fg: MacSheetInk.ink, bg: MacSheetInk.chip).accessibilityIdentifier("macProductSituation") }
            }.padding(.top, 10).frame(minHeight: 58, alignment: .top)
            Button(action: open) {
                // r01: a 36 pt pill, the first card ink, the others outlined
                Text("Open in browser ↗").font(MacSheetInk.sans(13, .medium))
                    .foregroundStyle(filled ? MacSheetInk.onInk : MacSheetInk.ink)
                    .frame(width: 151, height: 36)
                    .background(filled ? MacSheetInk.ink : MacSheetInk.sheet, in: Capsule())
                    .overlay { if !filled { Capsule().strokeBorder(MacFindsInk.line, lineWidth: 1) } }
                    .contentShape(Capsule())
            }.buttonStyle(.plain).onHover { hover = $0 }.padding(.top, 10)
                .accessibilityLabel("Open \(pick.name) in your browser").accessibilityIdentifier("macOpenInBrowser")
        }.frame(width: 151, alignment: .leading)
    }

    @ViewBuilder private var picture: some View {
        if let imageURL {
            AsyncImage(url: imageURL) { phase in
                if let image = phase.image { Color.clear.overlay { image.resizable().scaledToFill() } } else { placeholder }
            }
        } else { placeholder }
    }
    /// Many shops give no readable picture: D4 warm neutral tile (#F3F1ED) + a 34 pt hanger (#B9B2A6), as on the iPhone (PF-1).
    private var placeholder: some View {
        ZStack {
            Color(red: 243 / 255, green: 241 / 255, blue: 237 / 255)
            Image(systemName: "hanger").font(.system(size: 34, weight: .light)).foregroundStyle(Color(red: 185 / 255, green: 178 / 255, blue: 166 / 255))
        }
            .accessibilityLabel("Picture of \(pick.name)")
    }
    private func chip(_ text: String, mark: String, fg: Color, bg: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(mark).font(MacSheetInk.sans(13, .medium)).accessibilityHidden(true)
            Text(text).font(MacSheetInk.sans(12, .medium)).lineLimit(1)
        }
        .foregroundStyle(fg)
        .padding(.horizontal, 10).frame(height: 24).background(bg, in: Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(mark == ProductPicks.styleMark ? "Your style: \(text)" : "You said: \(text)")
    }
}

/// MAC-LINK (184:150): after a link opens in the browser, the Genita window offers to look at it together.
/// "Share this window" opens the system picker (window mode) for the share + ask path (F9, D40).
struct MacLinkPrompt: View {
    let share: () -> Void
    let notNow: () -> Void
    /// Dyno's demo video (2:16–2:20) shows this layout: the spoken line as a pill at the top, one white "Share this
    /// window" button at the bottom of the face (no sheet). Lead 11/4: match the video.
    var body: some View { v1Body }
    /// MAC-LINK v2: the spoken line stays a one-line pill (#211, drawn by the call view); the ask is the same white
    /// sheet as MS-1 (handle, serif title, ink button, Not now).
    private var v2Body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            VStack(alignment: .leading, spacing: 0) {
                Capsule().fill(MacSheetInk.handle).frame(width: 47, height: 5).frame(maxWidth: .infinity).padding(.bottom, 24)
                Text("Look at it together?").font(MacSheetInk.serif(24)).tracking(-0.24).foregroundStyle(MacSheetInk.ink).lineLimit(1)
                    .accessibilityAddTraits(.isHeader).accessibilityIdentifier("macLinkPrompt")
                Text("I opened it in your browser. Share that window and I’ll see what you see.")
                    .font(MacSheetInk.sans(15)).foregroundStyle(MacSheetInk.ink).lineSpacing(4).padding(.top, 12).fixedSize(horizontal: false, vertical: true)
                MacV2Button(label: "Share this window", id: "macShareThisWindow", action: share).padding(.top, 24)
                MacV2Button(label: "Not now", style: .text, id: "macLinkNotNow", action: notNow).frame(maxWidth: .infinity).padding(.top, 4)
            }
            .padding(.top, 28).padding(.horizontal, 38).padding(.bottom, 40)
            .frame(width: 390, alignment: .leading)
            .background(MacSheetInk.sheet, in: UnevenRoundedRectangle(topLeadingRadius: 30, topTrailingRadius: 30))
            .shadow(color: .black.opacity(0.06), radius: 12)
        }.frame(width: 390, height: 844)
    }
    private var v1Body: some View {
        ZStack(alignment: .topLeading) {
            LinearGradient(colors: [MacSheetInk.ink.opacity(0), MacSheetInk.ink.opacity(0.55)], startPoint: .top, endPoint: .bottom)
                .frame(width: 390, height: 260).position(x: 195, y: 844 - 130).allowsHitTesting(false)
            Text("Opened it in your browser. Want me to look at it with you?")
                .font(MacSheetInk.sans(14)).foregroundStyle(MacSheetInk.onInk).lineSpacing(4)
                .padding(.horizontal, 12).padding(.vertical, 9)
                .frame(width: 350, alignment: .leading)
                .background(MacSheetInk.pill, in: RoundedRectangle(cornerRadius: 14))
                .position(x: 195, y: MacDesignV2.enabled ? 87 : 124 + 28)   // v2: no fake status bar, top of the window
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

extension MacCallCue {
    static func text(_ cue: CallCue, name: String) -> String? {
        switch cue {
        case .none: nil
        case .listening: "Listening"
        case .thinking: "\(name) is thinking"
        case .speaking: "\(name) is talking"
        case .interrupted: "Stopped. Go ahead."
        case .reconnecting: "Reconnecting…"
        case .answerFailed: "Couldn’t get an answer."
        case .micOff: "Stopped"
        case .micBlocked: "Microphone is off for Genita."
        }
    }
}

/// A vertical scroll view. Review renders (ImageRenderer, GENITA_MAC_REVIEW_OUT) can't draw AppKit's scroll view,
/// so they get the plain stack — the same content, top-aligned.
struct MacScroll<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        if ProcessInfo.processInfo.environment["GENITA_MAC_REVIEW_OUT"] != nil {
            content.frame(maxHeight: .infinity, alignment: .top)
        } else {
            ScrollView(.vertical, showsIndicators: false) { content }
        }
    }
}

// MARK: Finds r01 (board Ao82Jv1iTdDL9FtFjZR2g6): searching orb + stage line + skeleton rows, the result row list

/// r01 tokens the Mac ink set doesn't have yet (board `--blueSoft`, `--blue`, `--line`, warm tile, why grey).
enum MacFindsInk {
    static let blueSoft = Color(red: 215.0 / 255, green: 241.0 / 255, blue: 1)
    static let blueText = Color(red: 0, green: 99.0 / 255, blue: 159.0 / 255)
    static let blue = Color(red: 0, green: 162.0 / 255, blue: 1)
    static let line = Color(white: 227.0 / 255)
    static let tile = Color(red: 243.0 / 255, green: 241.0 / 255, blue: 237.0 / 255)
    static let why = Color(white: 74.0 / 255)
    static let hover = Color(white: 246.0 / 255)
    /// r02: the serif initial and the line glyph on a tile with no photo
    static let tileInitial = Color(red: 138.0 / 255, green: 129.0 / 255, blue: 115.0 / 255)
    static let tileGlyph = Color(red: 185.0 / 255, green: 178.0 / 255, blue: 166.0 / 255)
    @MainActor static var reduceMotion: Bool {
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion || ProcessInfo.processInfo.environment["GENITA_MAC_REVIEW_OUT"] != nil
    }
}

/// 32 pt blue-soft orb with a magnifier; a 40 pt ring turns every 1.1 s (TimelineView, so it never freezes the way
/// an onAppear animation did while the sheet was hidden).
struct MacSearchOrb: View {
    var body: some View {
        ZStack {
            Circle().fill(MacFindsInk.blueSoft).frame(width: 32, height: 32)
            Image(systemName: "magnifyingglass").font(.system(size: 14, weight: .semibold)).foregroundStyle(MacFindsInk.blueText)
            if !MacFindsInk.reduceMotion {
                TimelineView(.animation) { ctx in
                    let t = ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.1) / 1.1
                    Circle().trim(from: 0, to: 0.5).stroke(MacFindsInk.blue, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                        .frame(width: 38, height: 38).rotationEffect(.degrees(135 + t * 360))
                }
            }
        }.frame(width: 40, height: 40).accessibilityHidden(true)
    }
}

/// The line under the question: what the search is doing now, changing every 2 s, pushed up from below (200 ms).
struct MacStageLine: View {
    let lines: [String]

    /// Server detail first ("Searching the web", later "Reading 8 pages"), then the generic steps it hasn't said.
    static func lines(detail: String) -> [String] {
        let d = detail.trimmingCharacters(in: .whitespacesAndNewlines)
        var out = d.isEmpty ? ["Searching the web"] : [d]
        for s in ["Reading pages", "Picking the best"] where !out.contains(where: { $0.lowercased().hasPrefix(s.lowercased().components(separatedBy: " ")[0]) }) {
            out.append(s)
        }
        return out
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 2)) { ctx in
            let i = lines.isEmpty ? 0 : Int(ctx.date.timeIntervalSinceReferenceDate / 2) % lines.count
            let text = lines.isEmpty ? "" : (MacFindsInk.reduceMotion ? lines[0] : lines[i])
            ZStack(alignment: .leading) {
                Text(text).font(MacSheetInk.sans(14)).foregroundStyle(MacSheetInk.mute).lineLimit(1)
                    .id(text)
                    .transition(.asymmetric(insertion: .offset(y: 8).combined(with: .opacity), removal: .offset(y: -8).combined(with: .opacity)))
            }
            .frame(maxWidth: .infinity, minHeight: 20, maxHeight: 20, alignment: .leading).clipped()
            .animation(.easeOut(duration: 0.2), value: text)
        }
    }
}

/// Board `.sh`: grey bar with a light band sweeping across every 1.4 s.
struct MacShimmer: View {
    var radius: CGFloat = 8
    private static let base = Color(white: 233.0 / 255)
    private static let light = Color(white: 247.0 / 255)
    var body: some View {
        if MacFindsInk.reduceMotion {
            RoundedRectangle(cornerRadius: radius).fill(Self.base)
        } else {
            TimelineView(.animation) { ctx in
                let p = ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.4) / 1.4
                RoundedRectangle(cornerRadius: radius).fill(LinearGradient(
                    stops: [.init(color: Self.base, location: 0.3), .init(color: Self.light, location: 0.5), .init(color: Self.base, location: 0.7)],
                    startPoint: UnitPoint(x: -2 + 2 * p, y: 0.5), endPoint: UnitPoint(x: 1 + 2 * p, y: 0.5)))
            }
        }
    }
}

/// One skeleton row: 64 thumb (r12) + bars 14 / 12 / 10 high at 78 / 94 / 40 %, 7 apart.
struct MacSkeletonRow: View {
    var last = false
    var body: some View {
        HStack(spacing: 12) {
            MacShimmer(radius: 12).frame(width: 64, height: 64)
            GeometryReader { g in
                VStack(alignment: .leading, spacing: 7) {
                    MacShimmer().frame(width: g.size.width * (last ? 0.60 : 0.78), height: 14)
                    MacShimmer().frame(width: g.size.width * (last ? 0.82 : 0.94), height: 12)
                    MacShimmer().frame(width: g.size.width * 0.40, height: 10)
                }.frame(maxHeight: .infinity, alignment: .center)
            }.frame(height: 64)
        }
    }
}

/// r01 result list: #1 as a 164 pt photo with "Top pick" when it has a picture, then 64 pt thumbnail rows.
/// Whole row = button → the Mac's default browser.
struct MacFindRows: View {
    let rows: [MacFindRow]
    /// `FindCard.topPick`: the row shown big (contract v2: not always row 0)
    var top: Int?

    private var heroRow: MacFindRow? { top.flatMap { rows.indices.contains($0) && rows[$0].picture != nil ? rows[$0] : nil } }

    var body: some View {
        let rest = rows.filter { $0.id != heroRow?.id }
        VStack(alignment: .leading, spacing: 0) {
            if let hero = heroRow { MacTopPick(row: hero).padding(.top, 18) }
            VStack(spacing: 0) {
                ForEach(Array(rest.enumerated()), id: \.element.id) { i, row in
                    MacFindRowView(row: row, divider: i > 0)
                }
            }.padding(.top, heroRow == nil ? 12 : 14)
        }
        .accessibilityElement(children: .contain).accessibilityIdentifier("macResultRows")
    }
}

/// Picture from the server (ready → AsyncImage, pending → shimmer); nil = the warm tile + site initial.
struct MacRowPicture: View {
    let row: MacFindRow
    var initialSize: CGFloat = 28
    var body: some View {
        ZStack {
            MacFindsInk.tile
            if let img = row.picture, img.status == .pending {
                MacShimmer(radius: 0)
            } else if let path = row.picture?.url, let url = CallController.shared.findsURL(path) {
                AsyncImage(url: url) { phase in
                    // the photo fills the slot and never sizes it (P0 build 13: a fill image grew past its frame)
                    if let image = phase.image { Color.clear.overlay { image.resizable().scaledToFill() }.transition(.opacity) }
                    else if phase.error != nil { MacInitialTile(row: row, size: initialSize) }
                    else { MacShimmer(radius: 0) }
                }
            } else {
                MacInitialTile(row: row, size: initialSize)
            }
        }.clipped()
    }
}

struct MacInitialTile: View {
    let row: MacFindRow
    var size: CGFloat = 28
    var body: some View {
        let c = row.tint
        Text(row.initial).font(.system(size: size * 0.5, weight: .bold)).foregroundStyle(MacSheetInk.onInk)
            .frame(width: size, height: size)
            .background(Color(red: c.r, green: c.g, blue: c.b), in: RoundedRectangle(cornerRadius: size * 0.28))
    }
}

/// Favicon (16, r4) + domain, 13 mute.
struct MacSourceLine: View {
    let row: MacFindRow
    var body: some View {
        HStack(spacing: 6) {
            Group {
                if let f = row.favicon, let url = f.hasPrefix("http") ? URL(string: f) : CallController.shared.findsURL(f) {
                    AsyncImage(url: url) { phase in
                        if let image = phase.image { image.resizable().scaledToFit() } else { MacInitialTile(row: row, size: 16) }
                    }.frame(width: 16, height: 16).clipShape(RoundedRectangle(cornerRadius: 4))
                } else {
                    MacInitialTile(row: row, size: 16)
                }
            }
            Text(row.domain.replacingOccurrences(of: "www.", with: "")).font(MacSheetInk.sans(13)).foregroundStyle(MacSheetInk.mute).lineLimit(1)
        }
    }
}

@MainActor private func openRow(_ row: MacFindRow) {
    if let url = ExternalLink.web(row.url) { NSWorkspace.shared.open(url) }
}

struct MacTopPick: View {
    let row: MacFindRow
    @State private var hover = false
    var body: some View {
        Button { openRow(row) } label: {
            VStack(alignment: .leading, spacing: 0) {
                MacRowPicture(row: row, initialSize: 44).frame(maxWidth: .infinity).frame(height: 164)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .overlay(alignment: .topLeading) {
                        Text("Top pick").font(MacSheetInk.sans(12, .medium)).foregroundStyle(MacSheetInk.ink)
                            .padding(.horizontal, 9).padding(.vertical, 3)
                            .background(MacSheetInk.sheet.opacity(0.92), in: Capsule()).padding(10)
                    }
                Text(row.title).font(MacSheetInk.sans(17, .semibold)).foregroundStyle(MacSheetInk.ink).lineLimit(2)
                    .lineSpacing(1).padding(.top, 12).fixedSize(horizontal: false, vertical: true)
                if let why = row.why {
                    Text(why).font(MacSheetInk.sans(14)).foregroundStyle(MacFindsInk.why).lineLimit(2).lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true).padding(.top, 3)
                }
                MacSourceLine(row: row).padding(.top, 6)
            }.contentShape(Rectangle()).opacity(hover ? 0.92 : 1)
        }
        .buttonStyle(MacRowPress())
        .onHover { hover = $0 }
        .accessibilityLabel("Top pick: \(row.title). \(row.why ?? "") \(row.domain)")
        .accessibilityIdentifier("macResultTopPick")
    }
}

struct MacFindRowView: View {
    let row: MacFindRow
    let divider: Bool
    @State private var hover = false
    var body: some View {
        Button { openRow(row) } label: {
            HStack(alignment: .top, spacing: 12) {
                MacRowPicture(row: row).frame(width: 64, height: 64).clipShape(RoundedRectangle(cornerRadius: 12))
                VStack(alignment: .leading, spacing: 0) {
                    Text(row.title).font(MacSheetInk.sans(15.5, .semibold)).foregroundStyle(MacSheetInk.ink).lineLimit(1)
                    if let why = row.why {
                        Text(why).font(MacSheetInk.sans(14)).foregroundStyle(MacFindsInk.why).lineLimit(2).lineSpacing(3)
                            .fixedSize(horizontal: false, vertical: true).padding(.top, 1)
                    }
                    MacSourceLine(row: row).padding(.top, 4)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 10).padding(.vertical, 12)
            .background(hover ? MacFindsInk.hover : Color.clear, in: RoundedRectangle(cornerRadius: 14))
            .overlay(alignment: .top) {
                if divider && !hover { Rectangle().fill(MacFindsInk.line).frame(height: 1).padding(.leading, 86).padding(.trailing, 10) }
            }
            .contentShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(MacRowPress())
        .onHover { hover = $0 }
        .padding(.horizontal, -10)
        .accessibilityLabel("\(row.title). \(row.why ?? "") \(row.domain)")
        .accessibilityHint("Opens in your browser")
        .accessibilityIdentifier("macResultRow")
    }
}

/// Board `.row:active`: scale .99.
struct MacRowPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.scaleEffect(configuration.isPressed ? 0.99 : 1).animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

/// Finds r01: one row per web result (link / unknown cards), shared by the iPhone and Mac sheets.
/// Old servers send no `why` / `image`: the reason then comes from the " — why" tail of the title or the matching
/// step ("Title — why"), and the picture falls back to the domain-initial tile.
struct MacFindRow: Identifiable, Equatable {
    var id: Int
    var title: String
    var why: String?
    var domain: String
    var url: String
    var image: FindImage?
    var favicon: String?

    /// The picture to draw: ready → URL, pending → shimmer, nil / failed → initial tile.
    var picture: FindImage? { image.flatMap { $0.status == .failed ? nil : $0 } }
    var initial: String { (domain.replacingOccurrences(of: "www.", with: "").first ?? title.first).map { String($0).uppercased() } ?? "•" }
    /// A steady colour per site for the initial tile (no favicon yet).
    var tint: (r: Double, g: Double, b: Double) {
        let palette: [(Double, Double, Double)] = [(0.12, 0.44, 0.70), (0.91, 0.35, 0.05), (0.0, 0.67, 0.42), (0.44, 0.28, 0.91), (0.79, 0.16, 0.16), (0.10, 0.55, 0.60)]
        let h = domain.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xFFFF }
        let p = palette[h % palette.count]
        return (r: p.0, g: p.1, b: p.2)
    }
}

extension FindCard {
    /// Rows for the r01 list, or [] when the card has no web sources (recipe / outfit keep their own layout).
    var macFindRows: [MacFindRow] {
        sources.enumerated().map { i, s in
            var title = s.displayTitle
            var why = s.why?.trimmingCharacters(in: .whitespacesAndNewlines)
            if why?.isEmpty != false {
                why = nil
                if let r = title.range(of: " — ") {
                    why = String(title[r.upperBound...]); title = String(title[..<r.lowerBound])
                } else {
                    let step = steps.first { $0.text.hasPrefix(title) } ?? (steps.count == sources.count ? steps[i] : nil)
                    if let t = step?.text {
                        if let r = t.range(of: " — ") { why = String(t[r.upperBound...]) } else if t != title { why = t }
                    }
                }
            }
            var image = s.image
            // an older server sends #1's picture only as the hero; never when some row has its own (v2: the hero may be another row's)
            if i == 0, image?.status != .ready, hero?.status == .ready, !sources.contains(where: { $0.image?.status == .ready }) { image = hero }
            return MacFindRow(id: i, title: title, why: why.flatMap { $0.isEmpty ? nil : $0 }, domain: s.domain, url: s.url, image: image, favicon: s.favicon)
        }
    }
}

// MARK: r02 visual cards (mock 6rTNaagEG4qFYQ5FvCqyhU): recipe tiles + step cards, place, how-to

/// A server picture that fills the slot it is given and never sizes it (P0 build 13: a scaledToFill photo grew past its
/// frame and slid under the text). nil / failed → `fallback`.
struct MacFindPicture<Fallback: View>: View {
    let image: FindImage?
    @ViewBuilder var fallback: Fallback
    var body: some View {
        ZStack {
            MacFindsInk.tile
            if let image, image.status == .pending {
                MacShimmer(radius: 0)
            } else if let image, image.status == .ready, let path = image.url, let url = CallController.shared.findsURL(path) {
                AsyncImage(url: url) { phase in
                    if let pic = phase.image { Color.clear.overlay { pic.resizable().scaledToFill() }.transition(.opacity) }
                    else if phase.error != nil { fallback }
                    else { MacShimmer(radius: 0) }
                }
            } else {
                fallback
            }
        }.clipped()
    }
}

struct MacSectionLabel: View {
    let text: String
    var body: some View { Text(text).font(MacSheetInk.sans(12, .medium)).foregroundStyle(MacSheetInk.mute) }
}

struct MacRecipeCard: View {
    let card: FindCard
    private var ordered: [FindItem] {
        let rank: [FindTier: Int] = [.buy: 0, .have: 1, .maybe: 2, .checking: 3]
        return card.items.enumerated().sorted { (rank[$0.element.tier] ?? 9, $0.offset) < (rank[$1.element.tier] ?? 9, $1.offset) }.map(\.element)
    }
    private var photo: FindImage? { card.hero.flatMap { $0.status == .failed ? nil : $0 } }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let photo {
                MacFindPicture(image: photo) { Image(systemName: "fork.knife").font(.system(size: 34, weight: .light)).foregroundStyle(MacFindsInk.tileGlyph) }
                    .frame(maxWidth: .infinity).frame(height: 164).clipShape(RoundedRectangle(cornerRadius: 12))
                    .accessibilityLabel("Photo of \(card.title)").accessibilityIdentifier("macDishPhoto")
                    .padding(.bottom, 18)
            }
            if !card.items.isEmpty {
                MacSectionLabel(text: "Ingredients").padding(.bottom, 12)
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12, alignment: .topLeading), count: 4), alignment: .leading, spacing: 16) {
                    ForEach(ordered) { MacIngredientTile(item: $0) }
                }.accessibilityElement(children: .contain).accessibilityLabel("Ingredients").accessibilityIdentifier("macIngredients")
            }
            if !card.steps.isEmpty { MacStepCards(steps: card.steps).padding(.top, 22) }
            // the recipe pages it came from, once, as r01 rows (Codex r1: the old text card had these links)
            let rows = card.macFindRows
            if !rows.isEmpty {
                MacSectionLabel(text: "Sources").padding(.top, 10)
                VStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { i, row in MacFindRowView(row: row, divider: i > 0) }
                }.padding(.top, 4)
            }
        }
    }
}

/// 64 pt tile (photo, or the warm tile + serif initial), the have / need / maybe chip on its corner, name + amount.
struct MacIngredientTile: View {
    let item: FindItem
    var body: some View {
        let miss = item.tier == .buy
        let amount = [item.tileAmount, item.optional == true ? "optional" : nil].compactMap { $0 }.joined(separator: " · ")
        VStack(alignment: .leading, spacing: 0) {
            MacFindPicture(image: item.tilePicture) {
                Text(item.tileInitial).font(MacSheetInk.serif(24)).foregroundStyle(MacFindsInk.tileInitial)
            }
            .frame(width: 64, height: 64).clipShape(RoundedRectangle(cornerRadius: 12))
            .opacity(item.tier == .maybe ? 0.55 : item.tier == .checking ? 0.5 : 1)
            .overlay(alignment: .topTrailing) { badge.offset(x: 5, y: -5) }
            Text(item.tileName).font(MacSheetInk.sans(13, .medium)).foregroundStyle(miss ? MacFindsInk.blueText : MacSheetInk.ink)
                .lineLimit(2).fixedSize(horizontal: false, vertical: true).padding(.top, 7)
            if !amount.isEmpty { Text(amount).font(MacSheetInk.sans(12)).foregroundStyle(MacSheetInk.mute).lineLimit(1) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityIdentifier("macIngredient-\(item.name)")
    }
    private var label: String {
        let state: String = switch item.tier {
        case .have: "on your camera"
        case .maybe: "not sure"
        case .buy: "to buy"
        case .checking: "checking"
        }
        return [item.tileName, item.tileAmount, state].compactMap { $0 }.joined(separator: ", ")
    }
    private var badge: some View {
        let icon = item.tier == .buy ? "plus" : item.tier == .maybe ? "questionmark" : "checkmark"
        let light = item.tier == .maybe || item.tier == .checking
        let fg: Color = item.tier == .buy ? MacFindsInk.blueText : light ? MacSheetInk.mute : MacSheetInk.onInk
        let bg: Color = item.tier == .buy ? MacFindsInk.blueSoft : light ? .white : MacSheetInk.ink
        return ZStack {
            Circle().fill(bg)
            if light { Circle().strokeBorder(MacFindsInk.line, lineWidth: 1) }
            if item.tier == .checking { ProgressView().controlSize(.mini) } else { Image(systemName: icon).font(.system(size: 11, weight: .bold)).foregroundStyle(fg) }
        }
        .frame(width: 22, height: 22)
        .background(Circle().fill(MacSheetInk.sheet).padding(-2))
        .accessibilityHidden(true)
    }
}

/// Numbered step cards: the step's photo on top (full width, 150, r12) when one came, never behind the text; the
/// serif number and the text use the full width; a hairline between steps.
struct MacStepCards: View {
    let steps: [FindCard.Step]
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            MacSectionLabel(text: "Steps").padding(.bottom, 2)
            ForEach(Array(steps.enumerated()), id: \.offset) { i, step in
                VStack(alignment: .leading, spacing: 0) {
                    if let img = step.image, img.status != .failed {
                        MacFindPicture(image: img) { Image(systemName: "photo").font(.system(size: 28, weight: .light)).foregroundStyle(MacFindsInk.tileGlyph) }
                            .frame(maxWidth: .infinity).frame(height: 150).clipShape(RoundedRectangle(cornerRadius: 12))
                            .accessibilityLabel("Photo of step \(i + 1)")
                            .padding(.bottom, 12)
                    }
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("\(i + 1)").font(MacSheetInk.serif(20)).frame(width: 24, alignment: .leading)
                        Text(step.text).font(MacSheetInk.sans(15)).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
                    }.foregroundStyle(MacSheetInk.ink)
                    if let source = step.source { Text("From \(source)").font(MacSheetInk.sans(12)).foregroundStyle(MacSheetInk.mute).padding(.leading, 30).padding(.top, 4) }
                }
                .padding(.vertical, 14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(alignment: .top) { if i > 0 { Rectangle().fill(MacFindsInk.line).frame(height: 1) } }
                .accessibilityElement(children: .combine)
            }
        }.accessibilityIdentifier("macSteps")
    }
}

/// How-to: the step cards, then each source once as an r01 row.
struct MacHowTo: View {
    let card: FindCard
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            MacStepCards(steps: card.steps).padding(.top, 16)
            let rows = card.macFindRows
            if !rows.isEmpty {
                MacSectionLabel(text: "Sources").padding(.top, 10)
                VStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { i, row in MacFindRowView(row: row, divider: i > 0) }
                }.padding(.top, 4)
            }
        }
    }
}

/// Place: #1 photo 164 + name + ★ rating (reviews) · hours + address + Map / Website pills; the rest as rows with the
/// rating line and the address. Map opens the default maps app, Website the default browser.
struct MacPlaceList: View {
    let card: FindCard
    var body: some View {
        let rows = card.macFindRows
        let top = card.topPick.flatMap { rows.indices.contains($0.index) && rows[$0.index].picture != nil ? $0.index : nil }
        let rest = Array(card.sources.enumerated()).filter { $0.offset != top }
        VStack(alignment: .leading, spacing: 0) {
            if let top { MacPlaceTop(row: rows[top], source: card.sources[top]).padding(.top, 18) }
            VStack(spacing: 0) {
                ForEach(Array(rest.enumerated()), id: \.element.offset) { n, item in
                    MacPlaceRow(row: rows[item.offset], source: item.element, divider: n > 0)
                }
            }.padding(.top, top == nil ? 12 : 14)
        }.accessibilityElement(children: .contain).accessibilityIdentifier("macPlaceList")
    }
}

struct MacPlaceMeta: View {
    let place: FindCard.Source.Place
    var body: some View {
        let hours = place.hours?.trimmingCharacters(in: .whitespaces) ?? ""
        if place.ratingText != nil || !hours.isEmpty {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                if let r = place.ratingText {
                    Text("★ " + r).font(MacSheetInk.sans(14, .semibold)).foregroundStyle(MacSheetInk.ink)
                    if let n = place.reviewsText { Text(n).font(MacSheetInk.sans(14)).foregroundStyle(MacFindsInk.why) }
                }
                if place.ratingText != nil, !hours.isEmpty { Text("·").font(MacSheetInk.sans(14)).foregroundStyle(MacFindsInk.why) }
                if !hours.isEmpty {
                    Text(hours).font(MacSheetInk.sans(14, place.hoursSayOpen ? .medium : .regular))
                        .foregroundStyle(place.hoursSayOpen ? MacSheetInk.ink : MacFindsInk.why).lineLimit(1)
                }
            }.lineLimit(1)
        }
    }
}

struct MacPlaceTop: View {
    let row: MacFindRow
    let source: FindCard.Source
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { if let url = ExternalLink.web(row.url) { NSWorkspace.shared.open(url) } } label: {
                VStack(alignment: .leading, spacing: 0) {
                    MacRowPicture(row: row, initialSize: 44).frame(maxWidth: .infinity).frame(height: 164)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .overlay(alignment: .topLeading) {
                            Text("Top pick").font(MacSheetInk.sans(12, .medium)).foregroundStyle(MacSheetInk.ink)
                                .padding(.horizontal, 9).padding(.vertical, 3)
                                .background(MacSheetInk.sheet.opacity(0.92), in: Capsule()).padding(10)
                        }
                    Text(source.placeName).font(MacSheetInk.sans(17, .semibold)).foregroundStyle(MacSheetInk.ink).lineLimit(2).padding(.top, 12)
                    if let p = source.place { MacPlaceMeta(place: p).padding(.top, 3) }
                    if let a = source.place?.address, !a.isEmpty {
                        Text(a).font(MacSheetInk.sans(14)).foregroundStyle(MacSheetInk.mute).lineLimit(2).padding(.top, 2)
                    } else if let why = row.why {
                        Text(why).font(MacSheetInk.sans(14)).foregroundStyle(MacFindsInk.why).lineLimit(2).padding(.top, 3)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(MacRowPress())
            .accessibilityLabel(["Top pick", source.placeName, source.place?.accessibilityText].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ". "))
            .accessibilityIdentifier("macPlaceTop")
            HStack(spacing: 8) {
                if let map = source.place?.mapLink {
                    MacPill(text: "Map", icon: "mappin.and.ellipse", filled: true) { NSWorkspace.shared.open(map) }
                        .accessibilityLabel("Open \(source.placeName) in Maps").accessibilityIdentifier("macPlaceMap")
                }
                MacPill(text: "Website", icon: "arrow.up.right", filled: source.place?.mapLink == nil, trailing: true) {
                    if let url = ExternalLink.web(row.url) { NSWorkspace.shared.open(url) }
                }.accessibilityIdentifier("macPlaceWebsite")
            }.padding(.top, 12)
        }
    }
}

/// r01 36 pt pill: ink filled, or outlined with the hairline colour (hover fills it).
struct MacPill: View {
    let text: String
    let icon: String
    var filled = false
    var trailing = false
    let action: () -> Void
    @State private var hover = false
    var body: some View {
        let ink = filled || hover
        Button(action: action) {
            HStack(spacing: 5) {
                if !trailing { Image(systemName: icon).font(.system(size: 12, weight: .medium)) }
                Text(text).font(MacSheetInk.sans(13, .medium))
                if trailing { Image(systemName: icon).font(.system(size: 11, weight: .medium)) }
            }
            .foregroundStyle(ink ? MacSheetInk.onInk : MacSheetInk.ink).padding(.horizontal, 16).frame(height: 36)
            .background(ink ? MacSheetInk.ink : MacSheetInk.sheet, in: Capsule())
            .overlay { if !ink { Capsule().strokeBorder(MacFindsInk.line, lineWidth: 1) } }
            .contentShape(Capsule())
        }.buttonStyle(.plain).onHover { hover = $0 }
    }
}

struct MacPlaceRow: View {
    let row: MacFindRow
    let source: FindCard.Source
    let divider: Bool
    @State private var hover = false
    var body: some View {
        Button { if let url = ExternalLink.web(row.url) { NSWorkspace.shared.open(url) } } label: {
            HStack(alignment: .top, spacing: 12) {
                MacRowPicture(row: row).frame(width: 64, height: 64).clipShape(RoundedRectangle(cornerRadius: 12))
                VStack(alignment: .leading, spacing: 0) {
                    Text(source.placeName).font(MacSheetInk.sans(15.5, .semibold)).foregroundStyle(MacSheetInk.ink).lineLimit(1)
                    if let p = source.place { MacPlaceMeta(place: p).padding(.top, 1) }
                    if let a = source.place?.address, !a.isEmpty {
                        Text(a).font(MacSheetInk.sans(13)).foregroundStyle(MacSheetInk.mute).lineLimit(1).padding(.top, 2)
                    } else if let why = row.why {
                        Text(why).font(MacSheetInk.sans(14)).foregroundStyle(MacFindsInk.why).lineLimit(2).lineSpacing(3).padding(.top, 1)
                    }
                    if source.place == nil { MacSourceLine(row: row).padding(.top, 4) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 10).padding(.vertical, 12)
            .background(hover ? MacFindsInk.hover : Color.clear, in: RoundedRectangle(cornerRadius: 14))
            .overlay(alignment: .top) {
                if divider && !hover { Rectangle().fill(MacFindsInk.line).frame(height: 1).padding(.leading, 86).padding(.trailing, 10) }
            }
            .contentShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(MacRowPress())
        .onHover { hover = $0 }
        .padding(.horizontal, -10)
        .accessibilityLabel([source.placeName, source.place?.accessibilityText].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ". "))
        .accessibilityHint("Opens in your browser")
        .accessibilityIdentifier("macPlaceRow")
    }
}
