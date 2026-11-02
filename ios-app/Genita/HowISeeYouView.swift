import SwiftUI
import UIKit

// D47 "How I see you" (lane 개인화, Chelsea 11/3): I04's card area as seven story cards
// (opener → think → talk → taste → help → lines → unknowns), each with "That's not me".
// Functional version in I04's visual language (white rounded bordered card, Pretendard body, KMU serif for the
// story line, the I04 evidence legend) until 춘식이's HISY frames land.

/// The card area of I04: the deck, its loading state, or the six rows as text when no story could be had.
struct StoryArea: View {
    @Bindable var model: AppState
    let width: CGFloat
    let height: CGFloat

    var body: some View {
        Group {
            if let cards = model.story, !cards.isEmpty {
                StoryDeck(model: model, cards: cards, width: width, height: height)
            } else if model.storyFailed || !model.serverWired {
                StoryFallback(text: model.styleText, width: width, height: height)
            } else {
                StoryLoading(width: width, height: height)
            }
        }
        .task { await model.loadStory() }
    }
}

enum StoryInk {
    static let border = Color(white: 0.89)
    static let blue = Color(red: 0, green: 162 / 255, blue: 1)
    static let blueSoft = Color(red: 215 / 255, green: 241 / 255, blue: 1)
    static let blueText = Color(red: 0, green: 99 / 255, blue: 159 / 255)
    static let error = Color(red: 0.85, green: 0.2, blue: 0.2)
    static let chip = Color(white: 0.955)
}

/// White rounded bordered card (I04 "Your preferences").
private struct StoryCardSurface: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 20).fill(.white).overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(StoryInk.border, lineWidth: 1))
    }
}

private struct StoryLoading: View {
    let width: CGFloat, height: CGFloat
    var body: some View {
        ZStack {
            StoryCardSurface()
            VStack(spacing: 14) {
                ProgressView().tint(CallInk.ink)
                Text("Putting how I see you into words…").font(TypeStyle.body(15)).foregroundStyle(CallInk.mute).multilineTextAlignment(.center)
            }.padding(24)
        }.frame(width: width, height: height).accessibilityElement(children: .combine).accessibilityIdentifier("storyLoading")
    }
}

/// No story (offline, the server couldn't write it): the six I04 rows as before.
private struct StoryFallback: View {
    let text: String, width: CGFloat, height: CGFloat
    var body: some View {
        ZStack(alignment: .topLeading) {
            StoryCardSurface()
            ScrollView {
                Text(text).font(TypeStyle.body(14)).foregroundStyle(CallInk.ink).lineSpacing(4).frame(maxWidth: .infinity, alignment: .leading).padding(21)
            }
        }.frame(width: width, height: height).accessibilityElement(children: .combine).accessibilityIdentifier("profileResult")
            .accessibilityValue(text)
    }
}

// MARK: deck

struct StoryDeck: View {
    @Bindable var model: AppState
    let cards: [StoryCard]
    let width: CGFloat
    let height: CGFloat
    @State private var page: Int? = 0
    @State private var correcting: StoryCard?

    private var index: Int { min(max(0, page ?? 0), cards.count - 1) }

    var body: some View {
        VStack(spacing: 12) {
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 0) {
                    ForEach(Array(cards.enumerated()), id: \.element.id) { i, card in
                        StoryCardView(card: card, number: i + 1, total: cards.count, ack: model.storyAck[card.id]) { correcting = card }
                            .frame(width: width, height: height - 20)
                            .contentShape(Rectangle())
                            .onTapGesture { go(i + 1) }
                            .accessibilityAction(named: "Next card") { go(i + 1) }
                            .id(i)
                    }
                }.scrollTargetLayout()
            }
            .scrollTargetBehavior(.paging)
            .scrollPosition(id: $page)
            .frame(width: width, height: height - 20)
            // vertical swipes page too (up = next, down = back)
            .simultaneousGesture(DragGesture(minimumDistance: 24).onEnded { v in
                let dx = v.translation.width, dy = v.translation.height
                guard abs(dy) > abs(dx) * 1.3, abs(dy) > 40 else { return }
                go(index + (dy < 0 ? 1 : -1))
            })
            dots
        }
        .frame(width: width, height: height + 12, alignment: .top)
        .sheet(item: $correcting) { card in
            StoryCorrectionSheet(model: model, card: card) { correcting = nil }
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
    }

    private func go(_ i: Int) {
        guard (0..<cards.count).contains(i) else { return }
        withAnimation(.easeInOut(duration: 0.32)) { page = i }
    }

    private var dots: some View {
        HStack(spacing: 6) {
            ForEach(cards.indices, id: \.self) { i in
                Capsule().fill(i == index ? CallInk.ink : Color(white: 0.82)).frame(width: i == index ? 16 : 6, height: 6)
            }
        }.frame(height: 8).animation(.easeInOut(duration: 0.2), value: index)
            .accessibilityElement().accessibilityLabel("Card \(index + 1) of \(cards.count)").accessibilityIdentifier("storyDots")
    }
}

// MARK: one card

struct StoryCardView: View {
    let card: StoryCard
    let number: Int
    let total: Int
    var ack: String?
    var notMe: () -> Void

    var body: some View {
        ZStack(alignment: .topLeading) {
            StoryCardSurface()
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline) {
                    Text(card.title).font(TypeStyle.body(15, .semibold)).foregroundStyle(CallInk.ink)
                    Spacer(minLength: 8)
                    Text("\(number) / \(total)").font(TypeStyle.body(13)).foregroundStyle(CallInk.mute).monospacedDigit()
                }
                Text(card.observation).font(TypeStyle.title(23)).foregroundStyle(card.later ? CallInk.mute : CallInk.ink)
                    .lineSpacing(3).minimumScaleFactor(0.8).fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 16).accessibilityIdentifier("storyObservation")
                Text(card.promise).font(TypeStyle.body(15, .medium)).foregroundStyle(CallInk.ink).fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 10).accessibilityIdentifier("storyPromise")
                if !card.later { EvidenceMark(label: card.evidence).padding(.top, 10) }
                extras.padding(.top, 14)
                Spacer(minLength: 8)
                if let ack {
                    Label(ack, systemImage: "checkmark.circle.fill").font(TypeStyle.body(14, .medium)).foregroundStyle(StoryInk.blueText)
                        .labelStyle(.titleAndIcon).padding(.bottom, 6).accessibilityIdentifier("storyAck")
                        .transition(.opacity)
                }
                Button(action: notMe) {
                    Text("That’s not me").font(TypeStyle.body(14, .medium)).underline().foregroundStyle(CallInk.mute).frame(minHeight: 44, alignment: .leading).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityIdentifier("storyNotMe")
            }
            .padding(.horizontal, 21).padding(.top, 21).padding(.bottom, 6)
            .id(card)   // a corrected card fades in as a new card
            .transition(.opacity.combined(with: .scale(scale: 0.98)))
        }
        .animation(.easeInOut(duration: 0.35), value: card)
        .animation(.easeInOut(duration: 0.25), value: ack)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("storyCard-\(card.id)")
    }

    @ViewBuilder private var extras: some View {
        if let tags = card.tags, !tags.isEmpty { TasteTags(tags: tags) }
        if let help = card.help, !help.isEmpty { HelpTiles(tiles: help) }
        if let items = card.unknowns, !items.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(items, id: \.self) { item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Circle().strokeBorder(CallInk.ink, lineWidth: 1).frame(width: 7, height: 7)
                        Text(item).font(TypeStyle.body(14)).foregroundStyle(CallInk.ink)
                    }
                }
            }.accessibilityElement(children: .combine).accessibilityIdentifier("storyUnknowns")
        }
    }
}

/// I04 legend: ● You said so · ○ Your AI noticed · ◐ Your AI's memory · blue ● My suggestion.
struct EvidenceMark: View {
    let label: String
    var body: some View {
        HStack(spacing: 6) {
            dot.frame(width: 8, height: 8)
            Text(StoryCard.evidenceLabel(label)).font(TypeStyle.body(13)).foregroundStyle(CallInk.mute)
        }.accessibilityElement(children: .combine).accessibilityIdentifier("storyEvidence")
    }
    @ViewBuilder private var dot: some View {
        switch label {
        case "explicit": Circle().fill(CallInk.ink)
        case "observed": Circle().strokeBorder(CallInk.ink, lineWidth: 1)
        case "memory": ZStack { Circle().strokeBorder(CallInk.ink, lineWidth: 1); HalfCircle().fill(CallInk.ink) }
        default: Circle().fill(StoryInk.blue)
        }
    }
}

private struct HalfCircle: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        p.addArc(center: CGPoint(x: r.midX, y: r.midY), radius: r.width / 2, startAngle: .degrees(90), endAngle: .degrees(270), clockwise: false)
        p.closeSubpath()
        return p
    }
}

/// Taste: style · food · watch chips; dislikes faded.
private struct TasteTags: View {
    let tags: StoryCard.Tags
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            row("Style", tags.style, faded: false)
            row("Food", tags.food, faded: false)
            row("Watch", tags.watch, faded: false)
            row("Not for you", tags.dislikes, faded: true)
        }.accessibilityElement(children: .combine).accessibilityIdentifier("storyTags")
    }
    @ViewBuilder private func row(_ name: String, _ items: [String], faded: Bool) -> some View {
        if !items.isEmpty {
            HStack(alignment: .top, spacing: 8) {
                Text(name).font(TypeStyle.body(12, .medium)).foregroundStyle(CallInk.mute).frame(width: 52, height: 26, alignment: .leading)
                ChipLayout(spacing: 6) {
                    ForEach(items.prefix(4), id: \.self) { t in
                        Text(t).font(TypeStyle.body(13, .medium)).foregroundStyle(faded ? CallInk.mute : CallInk.ink).strikethrough(faded, color: CallInk.mute.opacity(0.6))
                            .lineLimit(1).padding(.horizontal, 10).frame(height: 26)
                            .background(.white, in: RoundedRectangle(cornerRadius: 9))
                            .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(StoryInk.border, lineWidth: 1))
                            .opacity(faded ? 0.75 : 1)
                    }
                }
            }
        }
    }
}

/// Help: up to 4 tiles with "Ask first" / "Just do it".
private struct HelpTiles: View {
    let tiles: [StoryCard.HelpTile]
    var body: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
            ForEach(Array(tiles.prefix(4).enumerated()), id: \.offset) { _, t in
                VStack(alignment: .leading, spacing: 8) {
                    Text(t.label).font(TypeStyle.body(14, .medium)).foregroundStyle(CallInk.ink).lineLimit(2).minimumScaleFactor(0.85)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(t.badge).font(TypeStyle.body(11, .semibold))
                        .foregroundStyle(t.mode == .askFirst ? CallInk.ink : StoryInk.blueText)
                        .padding(.horizontal, 8).frame(height: 20)
                        .background(t.mode == .askFirst ? StoryInk.chip : StoryInk.blueSoft, in: Capsule())
                }
                .padding(10).frame(maxWidth: .infinity, minHeight: 74, alignment: .topLeading)
                .background(.white, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(StoryInk.border, lineWidth: 1))
                .accessibilityElement(children: .combine)
            }
        }
    }
}

// MARK: "That's not me"

struct StoryCorrectionSheet: View {
    @Bindable var model: AppState
    let card: StoryCard
    var done: () -> Void
    @State private var pick: String?
    @State private var text = ""
    @State private var sending = false
    @State private var error: String?
    @FocusState private var typing: Bool

    private var canSend: Bool { !sending && (pick != nil || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("What did I get wrong?").font(TypeStyle.title(28)).foregroundStyle(CallInk.ink).padding(.top, 28)
            Text("About “\(card.title)”. I’ll fix it and remember.").font(TypeStyle.body(15)).foregroundStyle(CallInk.mute).padding(.top, 6)
            if !card.picks.isEmpty {
                FlowChips(items: card.picks, selected: Set(pick.map { [$0] } ?? [])) { p in pick = pick == p ? nil : p; error = nil }
                    .padding(.top, 20)
            }
            ZStack(alignment: .topLeading) {
                if text.isEmpty {
                    Text("Tell me in your words (optional)").font(TypeStyle.body(15)).foregroundStyle(Color(white: 0.6)).padding(.horizontal, 14).padding(.vertical, 12)
                }
                TextField("", text: $text, axis: .vertical).font(TypeStyle.body(15)).foregroundStyle(CallInk.ink).lineLimit(3...5)
                    .focused($typing).padding(.horizontal, 14).padding(.vertical, 12)
                    .onChange(of: text) { _, t in if t.count > OnboardingClient.correctionMaxLength { text = String(t.prefix(OnboardingClient.correctionMaxLength)) }; error = nil }
                    .accessibilityIdentifier("storyCorrectionText")
            }
            .background(.white, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(StoryInk.border, lineWidth: 1))
            .padding(.top, 16)
            Text("\(text.count)/\(OnboardingClient.correctionMaxLength)").font(TypeStyle.body(12)).foregroundStyle(CallInk.mute).frame(maxWidth: .infinity, alignment: .trailing).padding(.top, 6)
            if let error {
                Text(error).font(TypeStyle.body(13)).foregroundStyle(StoryInk.error).padding(.top, 4).accessibilityIdentifier("storyCorrectionError")
            }
            Spacer(minLength: 16)
            Button(action: send) {
                ZStack {
                    RoundedRectangle(cornerRadius: 12).fill(canSend ? Color("Ink") : Color(white: 0.8))
                    if sending { ProgressView().tint(.white) }
                    else { Text("Send").font(TypeStyle.body(16, .medium)).foregroundStyle(canSend ? Color(white: 0.992) : Color(white: 0.65)) }
                }.frame(height: 50)
            }.buttonStyle(.plain).disabled(!canSend).accessibilityLabel("Send").accessibilityIdentifier("storyCorrectionSend")
            .padding(.bottom, 12)
        }
        .padding(.horizontal, 24)
        .background(Color("Canvas").ignoresSafeArea())
        .scrollDismissesKeyboard(.interactively)
    }

    private func send() {
        typing = false
        sending = true; error = nil
        Task {
            let line = await model.correctStory(cardId: card.id, pick: pick, text: text)
            sending = false
            if let line { error = line } else { done() }
        }
    }
}
