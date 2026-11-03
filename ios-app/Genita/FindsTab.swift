import SwiftUI

// F10-U-FINDS · The Finds tab: r03 board "Finds 탭에서 다시 열기" (F1 list, F0 empty) and r02 F0.
// Coordinates are the board's 390 × 844 frame: back 16/52, serif 35/39 title at 31/98, subtitle 141, list from 188,
// rows ≥ 72 with a 1 px line above, 44 × 44 thumbnail = the card's picture, 14/20 muted day headings.
// A row opens the card in the call's sheet (F2) over a dim scrim; the sheet's button continues the call about it.

struct FindsTabView: View {
    let call: CallController
    let list: FindsListModel
    let top: CGFloat
    var close: () -> Void
    @State private var undoTask: Task<Void, Never>?

    var body: some View {
        let sheetOpen = call.finds.state != .idle && call.finds.state != .dismissed
        ZStack(alignment: .topLeading) {
            Color("Canvas").ignoresSafeArea().contentShape(Rectangle()).onTapGesture {}
            VStack(alignment: .leading, spacing: 0) {
                Button(action: close) {
                    Image(systemName: "chevron.left").font(.system(size: 17, weight: .medium)).foregroundStyle(CallInk.ink).frame(width: 44, height: 44).contentShape(Rectangle())
                }.buttonStyle(PressScale(scale: 0.94)).accessibilityLabel("Back").accessibilityIdentifier("findsBack")
                    .padding(.leading, 16).padding(.top, 52 + top).padding(.bottom, 2)
                Text("Finds").font(TypeStyle.title(35)).tracking(-0.35).foregroundStyle(CallInk.ink).padding(.horizontal, 31).accessibilityAddTraits(.isHeader)
                Text("What I looked up on our calls.").font(TypeStyle.body(16)).foregroundStyle(CallInk.mute).padding(.horizontal, 31).padding(.top, 2)
                content
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .accessibilityHidden(sheetOpen)
            if sheetOpen {
                // r03 `.scrim`: the list steps back; a tap on it closes the card
                CallInk.dim.ignoresSafeArea().onTapGesture { withAnimation(.drawer) { call.finds.close() } }
                    .accessibilityLabel("Close card").accessibilityAddTraits(.isButton).accessibilityIdentifier("findsScrim").transition(.opacity)
            }
            if let removed = list.removed, !sheetOpen {
                undoToast(removed).frame(maxWidth: .infinity).padding(.bottom, 34).frame(maxHeight: .infinity, alignment: .bottom).transition(.opacity)
            }
        }
        .onChange(of: call.finds.current?.saved) { _, saved in
            if let current = call.finds.current, let saved { list.markSaved(current.id, saved) }
        }
        .animation(.fade, value: sheetOpen)
        .animation(.fade, value: list.removed?.id)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("findsTab")
        .task { await list.load() }
    }

    @ViewBuilder private var content: some View {
        switch list.phase {
        case .loading:
            Color.clear.frame(maxHeight: .infinity)
        case .failed:
            VStack(spacing: 8) {
                Text("Couldn’t load your Finds.").font(TypeStyle.body(16, .medium)).foregroundStyle(CallInk.ink)
                Text("Check your connection and try again.").font(TypeStyle.body(16)).foregroundStyle(CallInk.mute)
                Button("Try again") { Task { await list.load() } }.buttonStyle(SmallChipStyle(filled: true)).padding(.top, 8).accessibilityIdentifier("findsRetry")
            }.multilineTextAlignment(.center).frame(maxWidth: .infinity, maxHeight: .infinity).padding(.horizontal, 38)
        case .loaded where list.isEmpty:
            empty
        case .loaded:
            rows
        }
    }

    // r02 F0 (full-flow board F0): the orb, "Nothing here yet.", one line, "Back to our call"
    private var empty: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            // the art has wide transparent margins: draw it 450 pt wide in an overlay (no layout width) clipped to the 314 × 190 slot
            Color.clear.frame(width: 314, height: 190)
                .overlay(Image(resource: "reference-orb-round").resizable().scaledToFill().frame(width: 450, height: 450 * 975 / 748))
                .clipped().accessibilityHidden(true)
            Text("Nothing here yet.").font(TypeStyle.body(18, .semibold)).foregroundStyle(CallInk.ink).padding(.top, 48)
            // two even lines (QA build 7: "…on a call, and / it stays here." left a 3-word orphan); same F1 copy
            Text("Ask me to look something up\non a call, and it stays here.").font(TypeStyle.body(16)).foregroundStyle(CallInk.mute)
                .multilineTextAlignment(.center).padding(.top, 4).padding(.horizontal, 6)
            Spacer(minLength: 0)
            Button(action: close) {
                Text("Back to our call").font(TypeStyle.body(16, .medium)).foregroundStyle(CallInk.onInk).frame(maxWidth: .infinity).frame(height: 50)
                    .background(GlassCTA(color: CallInk.ink))
            }.buttonStyle(PressScale()).accessibilityIdentifier("findsBackToCall").padding(.bottom, 62)
        }.padding(.horizontal, 38).frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityElement(children: .contain).accessibilityIdentifier("findsEmpty")
    }

    private var rows: some View {
        List {
            ForEach(list.sections) { section in
                Text(section.title).font(TypeStyle.body(14)).foregroundStyle(CallInk.mute)
                    .padding(.top, 16).padding(.bottom, 4).frame(maxWidth: .infinity, alignment: .leading)
                    .listRowInsets(EdgeInsets(top: 0, leading: 31, bottom: 0, trailing: 31)).listRowSeparator(.hidden).listRowBackground(Color.clear)
                    .accessibilityAddTraits(.isHeader).accessibilityIdentifier("findsDay-\(section.title)")
                ForEach(section.rows) { row in
                    Button { open(row.card) } label: { FindRowView(call: call, row: row, frames: list.frames(row.id)) }
                        .buttonStyle(RowPress())
                        .listRowInsets(EdgeInsets(top: 0, leading: 31, bottom: 0, trailing: 31)).listRowSeparator(.hidden).listRowBackground(Color.clear)
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            Button(role: .destructive) { Task { await list.delete(row.id) } } label: { Label("Delete", systemImage: "trash") }.accessibilityIdentifier("findDelete")
                        }
                        .swipeActions(edge: .leading) {
                            Button { Task { await list.toggleSaved(row.id) } } label: { Label(row.saved ? "Unsave" : "Save", systemImage: row.saved ? "bookmark.slash" : "bookmark") }
                                .tint(FindsInk.blue).accessibilityIdentifier("findPin")
                        }
                        .accessibilityIdentifier("findsRow-\(row.card.title)")
                }
            }
            Color.clear.frame(height: 40).listRowSeparator(.hidden).listRowBackground(Color.clear)
        }
        .listStyle(.plain).scrollContentBackground(.hidden).environment(\.defaultMinListRowHeight, 1)
        .padding(.top, 20)
        .accessibilityIdentifier("findsList")
    }

    private func open(_ card: FindCard) {
        withAnimation(.drawer) { call.finds.openSaved(card, frames: list.frames(card.id)) }
    }

    private func undoToast(_ card: FindCard) -> some View {
        HStack(spacing: 12) {
            Text("Deleted").font(TypeStyle.body(14, .medium)).foregroundStyle(CallInk.onInk)
            Button("Undo") { Task { await list.undoDelete() } }.font(TypeStyle.body(14, .medium)).underline().foregroundStyle(CallInk.onInk)
                .padding(.horizontal, 8).frame(minHeight: 44).accessibilityIdentifier("findsUndo")
        }
        .padding(.leading, 16).padding(.trailing, 8)
        .background(CallInk.pill, in: RoundedRectangle(cornerRadius: 16))
        .accessibilityElement(children: .contain).accessibilityIdentifier("findsToast")
    }
}

private struct RowPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.6 : 1).animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

/// r03 `.f-row`: 72 pt min, line above, thumbnail 44 × 44 radius 12, title 16/24 medium, kind · detail 14/20 muted.
struct FindRowView: View {
    let call: CallController
    let row: FindsRow
    let frames: [Data]

    var body: some View {
        HStack(spacing: 12) {
            thumb.frame(width: 44, height: 44).clipShape(RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 0) {
                Text(row.title).font(TypeStyle.body(16, .medium)).foregroundStyle(CallInk.ink).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                Text(row.subtitle).font(TypeStyle.body(14)).foregroundStyle(CallInk.mute).lineLimit(1)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minHeight: 72)
        .overlay(alignment: .top) { FindsInk.line.frame(height: 1) }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(row.title). \(row.subtitle)\(row.saved ? ". Saved" : "")")
        .accessibilityAddTraits(.isButton)
    }

    /// The card's own picture; an outfit without one shows the option it picked, cut from the frame the phone kept.
    @ViewBuilder private var thumb: some View {
        let card = row.card
        if let hero = card.hero, card.kind != .link || hero.status == .ready {
            FindPicture(image: hero, resolve: call.findsURL, showFailText: false)
        } else if card.kind == .outfit, let option = card.options.first(where: \.picked) ?? card.options.first, frames.indices.contains(option.frame) {
            OptionCrop(frame: frames[option.frame], box: option.box, height: 44)
        } else {
            ZStack {
                FindsInk.skip
                Image(systemName: glyph).font(.system(size: 18, weight: .medium)).foregroundStyle(CallInk.ink)
            }
        }
    }

    private var glyph: String {
        switch row.card.kind {
        case .recipe: "fork.knife"
        case .outfit: "tshirt"
        case .link: "link"
        case .product: "bag"
        case .unknown: "bookmark"
        }
    }
}
