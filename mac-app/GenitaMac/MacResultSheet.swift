import SwiftUI
import AppKit

/// F7 · #121 · MAC-RS (MF-1~3): the result sheet on the Mac call window (390 × 844 design space), Figma
/// rp1wR9pxV0IsgyjvOcwo92 nodes 184:2 (MAC-RS-a searching) and 184:68 (MAC-RS-b two results).
/// Same r03 interaction as the iPhone (PF-1): the shared `FindsModel` drives searching → rising → half → full,
/// peek, close + Undo, and the same drag / tap rules. Product links open in the Mac's default browser
/// (MAC-LINK, 184:150), never inside the sheet.
extension SheetState {
    /// MAC-RS-a is taller than the iPhone's 148: the searching row plus the scan line (198 visible).
    /// Mac v2: the full sheet stops 54 pt lower so the face pip (top 28) never covers its ✕ and bookmark.
    var macHeight: CGFloat { self == .searching ? 198 : (self == .full && MacDesignV2.enabled ? 674 : height) }
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
                MacTalkWave(color: MacSheetInk.ink)
                VStack(alignment: .leading, spacing: 0) {
                    // one line each next to Stop, as the iPhone (#211): server copy, never wrapped, never a cut word
                    OneLineText(text: failed?.title ?? entry?.searchTitle ?? "Looking", font: MacSheetInk.sans(16, .medium), color: MacSheetInk.ink)
                        .accessibilityIdentifier("macResultSearchTitle")
                    if let detail = failed?.body ?? entry?.searchDetail, !detail.isEmpty {
                        OneLineText(text: detail, font: MacSheetInk.sans(14), color: MacSheetInk.mute, alternates: OneLineText.afterDot(detail))
                            .accessibilityIdentifier("macResultSearchDetail")
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
                // PF-1d on the Mac too: a failed product search can be asked again; other failures close
                Button(failed == nil ? "Stop" : retry ? "Retry" : "Close") {
                    withAnimation { failed == nil ? finds.stop() : retry ? finds.retry() : finds.close() }
                }
                    .buttonStyle(.plain).font(MacSheetInk.sans(14, .medium)).foregroundStyle(MacSheetInk.ink)
                    .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                    .accessibilityIdentifier(failed == nil ? "macResultStop" : retry ? "macResultRetry" : "macResultClose")
            }.frame(minHeight: 68)
            if failed == nil { MacScanLine().padding(.top, 6) }
            if let why {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Why").font(MacSheetInk.sans(12)).foregroundStyle(MacSheetInk.faint)
                    Text(why).font(MacSheetInk.sans(13)).foregroundStyle(MacSheetInk.ink).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                }.padding(.top, 10).accessibilityElement(children: .combine).accessibilityIdentifier("macResultSearchWhy")
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
                        if picks.isEmpty {
                            generic(card).padding(.top, 16)
                        } else {
                            HStack(alignment: .top, spacing: 12) {
                                ForEach(Array(picks.enumerated()), id: \.element.id) { i, pick in
                                    MacProductCard(pick: pick, primary: i == 0, imageURL: pick.image.flatMap { $0.status == .ready ? $0.url : nil }.flatMap { CallController.shared.findsURL($0) }) { open(pick) }
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
                // PF-1c: saved turns the one button grey (the Mac has no Finds tab to open; the card is in Finds on the iPhone)
                let saved = entry?.saved == true
                Button { finds.toggleSave() } label: {
                    Text(saved ? "Saved to Finds" : "Save to Finds").font(MacSheetInk.sans(16, .medium)).foregroundStyle(saved ? MacSheetInk.ink : MacSheetInk.onInk)
                        .frame(width: 314, height: 50).contentShape(Capsule())
                }.buttonStyle(MacGlassButtonStyle(kind: saved ? .regular : .prominent)).padding(.bottom, 56).accessibilityIdentifier("macResultSave").accessibilityValue(saved ? "saved" : "")
            }
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

    /// Mac v2: both cards' Open in browser look the same (outlined, ink on hover) — one action, one style.
    private var filled: Bool { (primary && !MacDesignV2.enabled) || hover }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            picture.frame(width: 151, height: 151).clipShape(RoundedRectangle(cornerRadius: 8))
            Text(pick.name).font(MacSheetInk.sans(15, .medium)).foregroundStyle(MacSheetInk.ink).lineLimit(1).padding(.top, 14)
            Text(pick.brandLine).font(MacSheetInk.sans(13)).foregroundStyle(MacSheetInk.mute).lineLimit(1).minimumScaleFactor(0.8).padding(.top, 6)
            VStack(alignment: .leading, spacing: 6) {
                // blue = from the import (taste), grey = from what they said (situation) — PF-1's chips
                if !pick.taste.isEmpty { chip(pick.taste, fg: MacSheetInk.chipBlueText, bg: MacSheetInk.chipBlue).accessibilityIdentifier("macProductTaste") }
                if !pick.situation.isEmpty { chip(pick.situation, fg: MacSheetInk.ink, bg: MacSheetInk.chip).accessibilityIdentifier("macProductSituation") }
            }.padding(.top, 10).frame(minHeight: 58, alignment: .top)
            Button(action: open) {
                Text("Open in browser ↗").font(MacSheetInk.sans(14, .medium))
                    .foregroundStyle(filled ? MacSheetInk.onInk : MacSheetInk.ink)
                    .frame(width: 151, height: 34).contentShape(Capsule())
            }.buttonStyle(MacGlassButtonStyle(kind: filled ? .prominent : .regular)).onHover { hover = $0 }.padding(.top, 6)
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
    /// Many shops give no readable picture: a calm bag, as on the iPhone (PF-1).
    private var placeholder: some View {
        ZStack { MacSheetInk.chip; Image(systemName: "bag").font(.system(size: 28, weight: .light)).foregroundStyle(MacSheetInk.faint) }
            .accessibilityLabel("Picture of \(pick.name)")
    }
    private func chip(_ text: String, fg: Color, bg: Color) -> some View {
        Text(text).font(MacSheetInk.sans(12, .medium)).lineLimit(1).foregroundStyle(fg)
            .padding(.horizontal, 10).frame(height: 24).background(bg, in: Capsule())
    }
}

/// MAC-LINK (184:150): after a link opens in the browser, the Genita window offers to look at it together.
/// "Share this window" opens the system picker (window mode) for the share + ask path (F9, D40).
struct MacLinkPrompt: View {
    let share: () -> Void
    let notNow: () -> Void
    var body: some View {
        if MacDesignV2.enabled { v2Body } else { v1Body }
    }
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
        case .micBlocked: "Microphone is off for Genita."
        }
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
