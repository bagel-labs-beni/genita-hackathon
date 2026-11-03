import SwiftUI

// F10-U-SHEET · The in-call result sheet, r03 board direction A (design-r02/revisions/r03/board.html).
// Values are the board's CSS on a 390 × 844 frame: sheet top 116, 728 tall, visible 148 / 328 / 468 / 728,
// page padding 40 38 24 (72 on top when full), serif 28/34 titles, 44 pt targets, drawer curve 420 ms.
// Pure SwiftUI so it also type-checks against the macOS SDK.

enum FindsInk {
    static let line = Color(red: 227 / 255, green: 227 / 255, blue: 227 / 255)
    static let blue = Color(red: 0, green: 162 / 255, blue: 1)
    static let blueSoft = Color(red: 215 / 255, green: 241 / 255, blue: 1)
    static let blueText = Color(red: 0, green: 99 / 255, blue: 159 / 255)
    static let blueTint = Color(red: 0, green: 162 / 255, blue: 1).opacity(0.18)
    static let skip = Color(red: 239 / 255, green: 239 / 255, blue: 239 / 255)
    static let boxLine = Color(red: 253 / 255, green: 253 / 255, blue: 253 / 255).opacity(0.82)
    static let white = Color.white
}

/// D48 ③ reason chips under the card title: blue "Your style/taste: …" from the profile, grey "You said: …" from
/// this call (`Reason.from`). VoiceOver reads them as one "Why this: …" line.
struct FindReasonChips: View {
    let reasons: [FindCard.Reason]
    var body: some View {
        // wraps: each chip reads whole (two short chips usually share a line)
        ChipLayout(spacing: 6) {
            ForEach(Array(reasons.enumerated()), id: \.offset) { _, r in
                // blue = from the profile (HISY, import, corrections) · grey = what they said in this call
                let call = r.from == "call"
                Text(r.text).font(TypeStyle.body(13, .medium)).foregroundStyle(call ? CallInk.mute : FindsInk.blueText).lineLimit(1).truncationMode(.tail).frame(maxWidth: 260)
                    .padding(.horizontal, 10).frame(height: 26).background(call ? FindsInk.skip : FindsInk.blueSoft, in: Capsule())
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .ignore).accessibilityLabel("Why this: " + reasons.map(\.text).joined(separator: ", "))
            .accessibilityIdentifier("findReasons")
    }
}

extension Animation {
    /// r03 `--ease-drawer` cubic-bezier(0.32, 0.72, 0, 1), 420 ms.
    static let drawer = Animation.timingCurve(0.32, 0.72, 0, 1, duration: 0.42)
    /// r03 `--dur-fade` 200 ms ease-out.
    static let fade = Animation.easeOut(duration: 0.2)
}

/// Loads a card picture: "bundle:<name>" (fixtures), or a server-relative URL through the call's host.
struct FindPicture: View {
    let image: FindImage?
    let resolve: (String) -> URL?
    var retry: () -> Void = {}
    var showFailText = true
    /// A calm placeholder (SF Symbol) instead of "Picture didn't load" — product shots, where many shops give no picture.
    var quietGlyph: String?
    @State private var attempt = 0
    var body: some View {
        ZStack {
            FindsInk.skip
            if let image {
                switch image.status {
                case .pending: Shimmer()
                case .failed: failed
                case .ready:
                    if let url = image.url, url.hasPrefix("bundle:"), let pic = BundlePicture.image(String(url.dropFirst(7))) {
                        pic.resizable().scaledToFill()
                    } else if let url = image.url.flatMap(resolve) {
                        AsyncImage(url: url, transaction: Transaction(animation: .fade)) { phase in
                            switch phase {
                            case let .success(pic): pic.resizable().scaledToFill()
                            case .failure: failed
                            default: Shimmer()
                            }
                        }.id(attempt)
                    } else { failed }
                }
            } else if quietGlyph != nil { failed }
        }.clipped()
    }
    @ViewBuilder private var failed: some View {
        if let quietGlyph {
            Image(systemName: quietGlyph).font(.system(size: 28, weight: .light)).foregroundStyle(CallInk.mute.opacity(0.7)).accessibilityHidden(true)
        } else {
        VStack(spacing: 4) {
            if showFailText { Text("Picture didn’t load").font(TypeStyle.body(12)).foregroundStyle(CallInk.mute) }
            Button { attempt += 1; retry() } label: {
                Image(systemName: "arrow.clockwise").font(.system(size: 15, weight: .medium)).foregroundStyle(CallInk.ink).frame(width: 44, height: 44).contentShape(Rectangle())
            }.buttonStyle(PressScale(scale: 0.94)).accessibilityLabel("Retry picture")
        }.multilineTextAlignment(.center)
        }
    }
}

enum BundlePicture {
    static func image(_ name: String) -> Image? {
        guard let url = Bundle.main.url(forResource: name, withExtension: "jpg") ?? Bundle.main.url(forResource: name, withExtension: "png"),
              let data = try? Data(contentsOf: url) else { return nil }
        return PlatformImage.make(data)
    }
}

/// r03 `.skel`: a 1.4 s shimmer; still under Reduce Motion.
struct Shimmer: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        if reduceMotion { FindsInk.skip } else {
            TimelineView(.animation) { context in
                let t = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.4) / 1.4
                LinearGradient(stops: [.init(color: FindsInk.skip, location: 0.3), .init(color: CallInk.sheet, location: 0.5), .init(color: FindsInk.skip, location: 0.7)],
                               startPoint: UnitPoint(x: 1 - 3 * t, y: 0.5), endPoint: UnitPoint(x: 4 - 3 * t, y: 0.5))
            }
        }
    }
}

/// r03 `.scan`: 2 px line with a 40% blue runner, 1.4 s.
struct ScanLine: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                FindsInk.line
                if !reduceMotion {
                    TimelineView(.animation) { context in
                        let t = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.4) / 1.4
                        FindsInk.blue.frame(width: g.size.width * 0.4).offset(x: g.size.width * 0.4 * (-1 + 3.5 * t))
                    }
                }
            }.clipped()
        }.frame(height: 2).accessibilityHidden(true)
    }
}

/// r03 `.wave`: four 2 × 12 bars, 900 ms.
struct FindsTalkWave: View {
    var color: Color = CallInk.ink
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        TimelineView(.animation(paused: reduceMotion)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: 2) {
                ForEach(0..<4, id: \.self) { i in
                    let phase = (t * 1000 + [0, 200, 450, 650][i]).truncatingRemainder(dividingBy: 900) / 900
                    RoundedRectangle(cornerRadius: 1).fill(color).frame(width: 2, height: 12 * (0.4 + 0.6 * abs(sin(phase * .pi))))
                }
            }.frame(height: 20)
        }.accessibilityHidden(true)
    }
}

struct PressScale: ButtonStyle {
    var scale: CGFloat = 0.97
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.scaleEffect(configuration.isPressed ? scale : 1).animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

// MARK: - Sheet

struct FindsSheet: View {
    let call: CallController
    let size: CGSize
    /// F10-U-FINDS: "Talk about this on a call" on a card reopened from the Finds tab.
    var talk: (() -> Void)?
    /// PF-1c "Open Finds": the Finds tab over the call.
    var openFinds: (() -> Void)?
    @State private var dragY: CGFloat = 0
    @State private var scrolledPage: Int?
    private var finds: FindsModel { call.finds }
    private var offline: Bool { call.link == .reconnecting || call.finds.offline }
    /// Figma F2 (138:2): a card reopened from Finds is 520 tall (picture 196, CTA 58 above the bottom), not the call's 468.
    static let reopenedHeight: CGFloat = 520
    private var reopenedHalf: Bool { finds.state == .half && finds.current?.reopened == true }

    var body: some View {
        let visible = reopenedHalf ? Self.reopenedHeight : finds.state.height
        ZStack(alignment: .top) {
            UnevenRoundedRectangle(topLeadingRadius: 30, topTrailingRadius: 30).fill(CallInk.sheet)
                .shadow(color: CallInk.ink.opacity(0.18), radius: 16, y: -8)
            ZStack(alignment: .top) {
                searchLayer.opacity(finds.state == .searching ? 1 : 0)
                peekLayer.opacity(finds.state == .peek ? 1 : 0)
                mainLayer.opacity([.half, .full, .rising].contains(finds.state) ? 1 : 0)
                if finds.newFind != nil, [.half, .full].contains(finds.state) { newFindBanner }
                if let source = finds.browser, finds.state == .full { browserLayer(source) }
            }.animation(.fade, value: finds.state)
            grab
        }
        .frame(width: size.width, height: 728)
        .clipShape(UnevenRoundedRectangle(topLeadingRadius: 30, topTrailingRadius: 30))
        .offset(y: size.height - visible + max(-120, dragY))
        .animation(.drawer, value: finds.state)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Finds from this call")
        .accessibilityIdentifier("findsSheet")
        .accessibilityValue(finds.state.rawValue)
    }

    // r03 `.grab`: 96 × 44 target, 47 × 5 handle 12 from the top. One state per gesture.
    private var grab: some View {
        Capsule().fill(CallInk.handle).frame(width: 47, height: 5).padding(.top, 12)
            .frame(width: 96, height: 44, alignment: .top).contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 4)
                .onChanged { v in finds.touching = true; dragY = v.translation.height * 0.6 }
                .onEnded { v in
                    finds.touching = false
                    let velocity = (v.predictedEndTranslation.height - v.translation.height) * 4
                    withAnimation(.drawer) { dragY = 0; finds.dragEnded(translation: v.translation.height, velocity: velocity) }
                })
            .onTapGesture { withAnimation(.drawer) { if finds.state == .peek { finds.tapPeek() } else if finds.state == .half { finds.state = .full } } }
            .accessibilityElement().accessibilityLabel("Find sheet. Swipe up or down to resize").accessibilityAddTraits(.isButton)
            .accessibilityAction(named: "Expand") { withAnimation(.drawer) { finds.dragEnded(translation: -100, velocity: 0) } }
            .accessibilityAction(named: "Collapse") { withAnimation(.drawer) { finds.dragEnded(translation: 100, velocity: 0) } }
            .accessibilityIdentifier("findsGrab")
    }

    // MARK: r03 #1 searching (148)

    private var searchLayer: some View {
        let f = finds.current
        return VStack(spacing: 0) {
            HStack(spacing: 12) {
                FindsTalkWave()
                VStack(alignment: .leading, spacing: 0) {
                    // one line each next to Stop at 390 pt (Chelsea 11/3): never wraps, never cuts a word
                    OneLineText(text: f?.failureLines?.title ?? f?.searchTitle ?? "Looking", font: TypeStyle.body(16, .medium), color: CallInk.ink)
                        .accessibilityIdentifier("findSearchTitle")
                    let detail = f?.failureLines?.body ?? f?.searchDetail ?? ""
                    if !detail.isEmpty {
                        OneLineText(text: detail, font: TypeStyle.body(14), color: CallInk.mute, alternates: OneLineText.afterDot(detail))
                            .accessibilityIdentifier("findSearchDetail")
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
                Button(f?.failed == nil ? "Stop" : f?.canRetry == true ? "Retry" : "Close") {
                    withAnimation(.drawer) { f?.failed == nil ? finds.stop() : f?.canRetry == true ? finds.retry() : finds.close() }
                }
                    .font(TypeStyle.body(14, .medium)).foregroundStyle(CallInk.ink).frame(minWidth: 44, minHeight: 44).buttonStyle(PressScale())
                    .accessibilityIdentifier(f?.canRetry == true ? "findRetry" : "findStop")
            }.frame(height: 74)
            if f?.failed == nil { ScanLine() }
        }
        .padding(.horizontal, 38).padding(.top, 32)
        .frame(maxHeight: .infinity, alignment: .top)
        .accessibilityElement(children: .contain).accessibilityIdentifier("findSearching")
    }

    // MARK: r03 #9 peek (148)

    private var peekLayer: some View {
        let f = finds.current
        return ZStack(alignment: .topLeading) {
            Button { withAnimation(.drawer) { finds.tapPeek() } } label: {
                HStack(spacing: 12) {
                    FindPicture(image: f?.card?.hero ?? f.flatMap(firstFramePicture), resolve: call.findsURL, showFailText: false)
                        .frame(width: 44, height: 44).clipShape(RoundedRectangle(cornerRadius: 12))
                    VStack(alignment: .leading, spacing: 4) {
                        Text(f?.card?.title ?? f?.searchTitle ?? "").font(TypeStyle.title(18)).foregroundStyle(CallInk.ink).lineLimit(1)
                        Text(peekSubtitle).font(TypeStyle.body(14)).foregroundStyle(CallInk.mute).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.up").font(.system(size: 15, weight: .medium)).foregroundStyle(CallInk.mute)
                }.frame(width: 264, height: 64).contentShape(Rectangle())
            }.buttonStyle(PressScale()).offset(x: 38, y: 36).accessibilityIdentifier("findPeek")
            closeButton.offset(x: size.width - 38 - 44, y: 46)
        }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var peekSubtitle: String {
        let n = finds.cardCount
        let status = finds.current?.card?.status ?? ""
        return [n > 1 ? "\(n) finds" : nil, status.isEmpty ? nil : status].compactMap { $0 }.joined(separator: " · ")
    }

    private func firstFramePicture(_ f: FindEntry) -> FindImage? { nil }

    private var closeButton: some View {
        Button { withAnimation(.drawer) { finds.close() } } label: {
            Image(systemName: "xmark").font(.system(size: 17, weight: .medium)).foregroundStyle(CallInk.ink).frame(width: 44, height: 44).contentShape(Rectangle())
        }.buttonStyle(PressScale(scale: 0.94)).accessibilityLabel("Close. It stays in Finds").accessibilityIdentifier("findClose")
    }

    // MARK: half / full pages

    private var mainLayer: some View {
        let full = finds.state == .full
        let pageHeight: CGFloat = full ? 612 : reopenedHalf ? 396 : 344
        return ZStack(alignment: .top) {
            ScrollView(.horizontal) {
                LazyHStack(spacing: 0) {
                    ForEach(Array(finds.entries.enumerated()), id: \.element.id) { i, entry in
                        if let card = entry.card {
                            FindCardPage(call: call, entry: entry, card: card, index: i, full: full, offline: offline, openFinds: openFinds)
                                .frame(width: size.width, height: pageHeight, alignment: .top)
                                .id(i)
                        }
                    }
                }.scrollTargetLayout()
            }
            .scrollTargetBehavior(.paging)
            .scrollIndicators(.hidden)
            .scrollPosition(id: $scrolledPage)
            .onChange(of: scrolledPage) { _, p in if let p, p != finds.page { finds.showPage(p) } }
            .onChange(of: finds.page) { _, p in if scrolledPage != p { withAnimation(.drawer) { scrolledPage = p } } }
            .onAppear { scrolledPage = finds.page }
            .frame(height: pageHeight)
            if full {
                // r03 `.main::before/after`: clean top and bottom edges under the face window
                CallInk.sheet.frame(height: 64).allowsHitTesting(false)
                LinearGradient(colors: [CallInk.sheet.opacity(0), CallInk.sheet], startPoint: .top, endPoint: .bottom).frame(height: 32).offset(y: 580).allowsHitTesting(false)
            }
            // r03 `.foot` top 620, translateY(-260) unless full; while rising it sits below the visible part
            foot.offset(y: full ? 620 : reopenedHalf ? 412 : 360)
        }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    // r03 `.foot`: CTA 313 × 50 (+ mic when full); offline note instead when the link is down (#16).
    @ViewBuilder private var foot: some View {
        let card = finds.current?.card
        HStack(spacing: 8) {
            if offline {
                Text("You’re offline. This card is saved, and sources open when you’re back.").font(TypeStyle.body(14)).foregroundStyle(CallInk.mute)
                    .frame(maxWidth: .infinity, alignment: .leading).accessibilityIdentifier("findOffline")
            } else {
                if finds.state == .full {
                    Button { call.toggleMic() } label: {
                        Image(systemName: call.micOn ? "mic.fill" : "mic").font(.system(size: 18, weight: .medium)).foregroundStyle(CallInk.onInk).frame(width: 50, height: 50).background(CallInk.ink, in: Circle())
                    }.buttonStyle(PressScale(scale: 0.96)).accessibilityLabel(call.micOn ? "Mute" : "Unmute")
                }
                let reopened = finds.current?.reopened == true
                if card?.kind == .product, !reopened {
                    // PF-1b/c: one button — Save to Finds, then Open Finds (grey)
                    let saved = finds.current?.saved == true
                    Button { if saved { openFinds?() } else { finds.toggleSave() } } label: {
                        Text(saved ? "Open Finds" : "Save to Finds").font(TypeStyle.body(16, .medium)).foregroundStyle(saved ? CallInk.ink : CallInk.onInk)
                            .frame(maxWidth: .infinity).frame(height: 50).background(saved ? FindsInk.skip : CallInk.ink, in: RoundedRectangle(cornerRadius: 12))
                    }.buttonStyle(PressScale()).accessibilityIdentifier(saved ? "openFinds" : "findCTA").accessibilitySortPriority(-10)
                } else {
                // r03 F2 `.fcta`: on a card reopened from Finds the one button continues the call about it
                Button { if reopened { finds.talkAboutThis(); talk?() } else if let card { finds.ask(Self.cta(card.kind)) } } label: {
                    Text(reopened ? "Talk about this on a call" : (card.map { Self.cta($0.kind) } ?? "")).font(TypeStyle.body(16, .medium)).foregroundStyle(CallInk.onInk)
                        .frame(maxWidth: .infinity).frame(height: 50).background(CallInk.ink, in: RoundedRectangle(cornerRadius: 12))
                }.buttonStyle(PressScale()).disabled(!reopened && !finds.canAsk).opacity(reopened || finds.canAsk ? 1 : 0.4).accessibilityIdentifier(reopened ? "findTalk" : "findCTA").accessibilitySortPriority(-10)
                }
            }
        }.frame(width: size.width - 76).padding(.horizontal, 38)
    }

    static func cta(_ kind: FindKind) -> String {
        switch kind {
        case .recipe: "Walk me through it"
        case .outfit: "Show me one more"
        case .link: "Read it with me"
        case .product: "Save to Finds"
        case .unknown: "Tell me more"
        }
    }

    // r03 #11: a new result waits above the card you're reading.
    private var newFindBanner: some View {
        let title = finds.entries.first { $0.id == finds.newFind }?.card?.title ?? ""
        return Button { withAnimation(.drawer) { finds.viewNewFind() } } label: {
            HStack(spacing: 8) {
                FindsTalkWave(color: CallInk.onInk)
                (Text("New: ") + Text(title).fontWeight(.semibold)).font(TypeStyle.body(14)).foregroundStyle(CallInk.onInk).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                Text("View").font(TypeStyle.body(14, .medium)).underline().foregroundStyle(CallInk.onInk)
            }.padding(.horizontal, 12).frame(width: 228, height: 44).background(CallInk.ink, in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(PressScale())
        .frame(maxWidth: .infinity, alignment: .leading).padding(.leading, 38).padding(.top, finds.state == .full ? 72 : 40)
        .transition(.opacity.combined(with: .offset(y: -8)))
        .accessibilityIdentifier("findNew")
    }

    // r03 #8: the source opens inside the sheet, Done goes back to the card.
    private func browserLayer(_ source: FindCard.Source) -> some View {
        VStack(spacing: 0) {
            // Figma F10-8 (125:357): left 38, top 72, 324 wide: Done (underlined) · lock + domain · Open in Safari 44 × 44
            HStack(spacing: 0) {
                Button("Done") { withAnimation(.fade) { finds.browser = nil } }.font(TypeStyle.body(16)).underline().foregroundStyle(CallInk.ink)
                    .frame(minWidth: 44, minHeight: 44, alignment: .leading).accessibilityIdentifier("browserDone")
                Spacer(minLength: 8)
                HStack(spacing: 4) {
                    Image(systemName: "lock.fill").font(.system(size: 11, weight: .medium))
                    Text(source.domain).font(TypeStyle.body(14, .medium)).lineLimit(1)
                }.foregroundStyle(CallInk.ink)
                Spacer(minLength: 8)
                if let url = URL(string: source.url) {
                    Link(destination: url) { Image(systemName: "arrow.up.right.square").font(.system(size: 17)).foregroundStyle(CallInk.ink).frame(width: 44, height: 44) }
                        .accessibilityLabel("Open in Safari").accessibilityIdentifier("browserOpenExternal")
                }
            }.frame(height: 44).padding(.horizontal, 38).padding(.top, 72)
            FindsBrowser(url: URL(string: source.url)).padding(.top, 16)
        }.background(CallInk.sheet).transition(.opacity).accessibilityIdentifier("findBrowser")
    }
}

// MARK: - One card page

struct FindCardPage: View {
    let call: CallController
    let entry: FindEntry
    let card: FindCard
    let index: Int
    let full: Bool
    let offline: Bool
    var openFinds: (() -> Void)?
    private var finds: FindsModel { call.finds }
    /// The title row's measured height (title, subtitle, reason chips): the half sheet sizes the camera picture from it.
    @State private var titleRowHeight: CGFloat = 0

    var body: some View {
        ScrollViewReader { reader in
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 8) {
                header
                titleRow.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { titleRowHeight = $0 }
                switch card.kind {
                case .recipe: recipe
                case .outfit: outfit
                case .product: product
                case .link, .unknown: link
                }
                if !card.ask.isEmpty { askSection.id("ask") }
                if !card.sources.isEmpty, card.kind != .product { sourcesSection.id("sources") }
                if !card.how.isEmpty { howSection.id("how") }
                Color.clear.frame(height: full ? 96 : 24)
            }
            // PF-1b (Figma 179:68): the product card starts 14 pt higher so "How I found this" clears the CTA (#214)
            .padding(.horizontal, 38).padding(.top, full ? (card.kind == .product ? 58 : 72) : 40)
        }
        .onChange(of: finds.scrollTarget, initial: true) { _, target in
            guard let target, finds.current?.id == entry.id else { return }
            withAnimation(.drawer) { reader.scrollTo(target, anchor: .top) }
        }
        }
        .scrollDisabled(!full)
        .scrollIndicators(.hidden)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Find \(index + 1) of \(finds.cardCount): \(card.title)")
        .accessibilityIdentifier("findPage\(index)")
    }

    /// r03 F2: "From your fridge · Today" when reopened from Finds.
    private var eyebrow: String {
        guard entry.reopened, let date = FindsListModel.date(card.createdAt) else { return card.eyebrow }
        return card.eyebrow + " · " + FindsListModel.dayTitle(Calendar.current.startOfDay(for: date), now: Date(), calendar: .current)
    }

    // r03 `.hd`: eyebrow + dots | save, close
    private var header: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 4) {
                Text(eyebrow).font(TypeStyle.body(14)).foregroundStyle(CallInk.mute)
                if finds.cardCount > 1, !entry.reopened {
                    HStack(spacing: 4) {
                        ForEach(Array(finds.entries.filter { $0.card != nil }.enumerated()), id: \.element.id) { i, e in
                            Circle().fill(e.id == entry.id ? CallInk.ink : (e.id == finds.newFind ? FindsInk.blue : FindsInk.line)).frame(width: 6, height: 6)
                        }
                    }.accessibilityElement().accessibilityLabel("Find \(index + 1) of \(finds.cardCount)")
                }
            }
            Spacer()
            HStack(spacing: 0) {
                Button { finds.toggleSave() } label: {
                    Image(systemName: entry.saved ? "bookmark.fill" : "bookmark").font(.system(size: 17, weight: .medium)).foregroundStyle(entry.saved ? FindsInk.blueText : CallInk.ink).frame(width: 44, height: 44).contentShape(Rectangle())
                }.buttonStyle(PressScale(scale: 0.94)).accessibilityLabel(entry.saved ? "Saved to Finds" : "Save to Finds").accessibilityIdentifier("findSave")
                // Figma F2: the X is there on a reopened card too (it goes back to the list)
                Button { withAnimation(.drawer) { finds.close() } } label: {
                    Image(systemName: "xmark").font(.system(size: 17, weight: .medium)).foregroundStyle(CallInk.ink).frame(width: 44, height: 44).contentShape(Rectangle())
                }.buttonStyle(PressScale(scale: 0.94)).accessibilityLabel(entry.reopened ? "Close" : "Close. It stays in Finds").accessibilityIdentifier("findCloseCard")
            }.padding(.trailing, -10)
        }.frame(height: 44)
    }

    // r03 `.tt`: serif 28/34 title, 14/20 meta | 56 × 56 picture
    private var titleRow: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 0) {
                Text(card.title).font(TypeStyle.title(28)).tracking(-0.28).foregroundStyle(CallInk.ink).lineSpacing(2).fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                if !card.subtitle.isEmpty {
                    Text(entry.reopened ? Self.reopenedSubtitle(card.subtitle) : card.subtitle)
                        .font(TypeStyle.body(14)).foregroundStyle(CallInk.mute).lineLimit(1).truncationMode(.tail)
                }
                // D48 ③: why this fits you — 1–2 chips from the user's own taste lines (not on link cards)
                if card.kind != .link, let reasons = card.reasons, !reasons.isEmpty { FindReasonChips(reasons: Array(reasons.prefix(2))).padding(.top, 8) }
            }.frame(maxWidth: .infinity, alignment: .leading)
            if card.kind != .link, let hero = card.hero {
                FindPicture(image: hero, resolve: call.findsURL, showFailText: false).frame(width: 56, height: 56).clipShape(RoundedRectangle(cornerRadius: 12))
                    .accessibilityLabel("Illustration of \(card.title)")
            }
        }
    }

    /// A saved recipe describes the camera result as a completed observation (Figma F2 138:2).
    /// "15 min · Have 6 · Need soy sauce" → "15 min · Had 6 · Needed soy sauce" (#215 short line; the older
    /// "You have 4, need rice" form is still read for saved cards).
    static func reopenedSubtitle(_ subtitle: String) -> String {
        subtitle.components(separatedBy: " · ").map { part in
            if part.hasPrefix("Have ") { return "Had " + part.dropFirst(5) }
            if part.hasPrefix("Need ") { return "Needed " + part.dropFirst(5) }
            return part
                .replacingOccurrences(of: "You have ", with: "You had ")
                .replacingOccurrences(of: ", need ", with: ", needed ")
        }.joined(separator: " · ")
    }

    // MARK: recipe

    private var orderedItems: [FindItem] {
        let rank: [FindTier: Int] = [.buy: 0, .have: 1, .maybe: 2, .checking: 3]
        return card.items.enumerated().sorted { (rank[$0.element.tier] ?? 9, $0.offset) < (rank[$1.element.tier] ?? 9, $1.offset) }.map(\.element)
    }

    @ViewBuilder private var recipe: some View {
        if let cam = card.camera {
            CameraFrame(frame: entry.frames.indices.contains(cam.frame) ? entry.frames[cam.frame] : nil, camera: cam, items: card.items, selected: finds.selectedItem,
                        checking: entry.checking, height: full ? 196 : (entry.reopened ? (card.title.count <= 17 ? 196 : 130) : halfCameraHeight))
        }
        chipRow
        if let sel = card.items.first(where: { $0.id == finds.selectedItem }), sel.tier == .maybe { confirmRow(sel) }
        if !card.steps.isEmpty { stepsSection }
    }

    /// Half sheet (344 pt page, scrolling off): the picture gives way so the ingredient chips show whole under a
    /// two-line title. 344 − 40 top − 44 header − 3 × 8 spacing − 44 chips = 192 for title row + picture; 132 at most
    /// (r03), 88 at least. Before: "Kimchi fried rice / with tofu and egg" cut the chip row in half (UI sweep 11/3).
    static func halfCameraHeight(titleRow: CGFloat) -> CGFloat { min(132, max(88, 192 - titleRow)) }
    private var halfCameraHeight: CGFloat { titleRowHeight > 0 ? Self.halfCameraHeight(titleRow: titleRowHeight) : 132 }

    // r03 `.chiprow`: missing first (blue, +), then what you have (white, ✓); maybe = faded "?"
    private var chipRow: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(orderedItems) { item in chip(item) }
            }.padding(.horizontal, 38)
        }
        .scrollIndicators(.hidden)
        .padding(.horizontal, -38)
        .accessibilityElement(children: .contain).accessibilityLabel("Ingredients")
    }

    private func chip(_ item: FindItem) -> some View {
        let pressed = finds.selectedItem == item.id
        let miss = item.tier == .buy
        let icon = miss ? "plus" : item.tier == .maybe ? "questionmark" : "checkmark"
        let fg: Color = pressed ? CallInk.onInk : miss ? FindsInk.blueText : CallInk.ink
        let bg: Color = pressed ? CallInk.ink : miss ? FindsInk.blueSoft : FindsInk.white
        let border: Color = pressed ? CallInk.ink : miss ? FindsInk.blueSoft : FindsInk.line
        return Button { withAnimation(.fade) { finds.tapItem(item) } } label: {
            HStack(spacing: 6) {
                if item.tier == .checking { ProgressView().controlSize(.mini).tint(CallInk.mute) }
                else { Image(systemName: icon).font(.system(size: 13, weight: .semibold)).foregroundStyle(pressed ? CallInk.onInk : miss ? FindsInk.blueText : CallInk.mute) }
                Text(item.name.capitalizedFirst).font(TypeStyle.body(14, .medium))
                if item.optional == true { Text("optional").font(TypeStyle.body(12)) }
            }
            .foregroundStyle(fg).padding(.horizontal, 12).frame(height: 44)
            .background(bg, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(border, lineWidth: 1))
            .opacity(item.tier == .maybe && !pressed ? 0.55 : item.tier == .checking ? 0.5 : 1)
        }
        .buttonStyle(PressScale())
        .accessibilityLabel(chipLabel(item))
        .accessibilityAddTraits(pressed ? .isSelected : [])
        .accessibilityIdentifier("chip-\(item.name)")
    }

    private func chipLabel(_ item: FindItem) -> String {
        switch item.tier {
        case .have: "\(item.name), on your camera"
        case .maybe: "\(item.name)? Not sure. Tap to confirm"
        case .buy: "\(item.name), not on your camera\(item.optional == true ? ", optional" : "")"
        case .checking: "\(item.name), checking"
        }
    }

    // IC-2/IC-3 "맞아?": Yes → have, No → to buy
    private func confirmRow(_ item: FindItem) -> some View {
        HStack(spacing: 8) {
            Text("Is that \(item.name)?").font(TypeStyle.body(14, .medium)).foregroundStyle(CallInk.ink).frame(maxWidth: .infinity, alignment: .leading)
            Button("Yes") { withAnimation(.fade) { finds.confirm(item, yes: true) } }.buttonStyle(SmallChipStyle(filled: true)).accessibilityIdentifier("confirmYes")
            Button("No") { withAnimation(.fade) { finds.confirm(item, yes: false) } }.buttonStyle(SmallChipStyle(filled: false)).accessibilityIdentifier("confirmNo")
        }.transition(.opacity)
    }

    private var stepsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Steps").font(TypeStyle.body(12, .medium)).foregroundStyle(CallInk.mute)
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: 12) {
                    ForEach(Array(card.steps.enumerated()), id: \.offset) { i, step in stepCard(i, step) }
                }.padding(.horizontal, 38).scrollTargetLayout()
            }
            .scrollTargetBehavior(.viewAligned)
            .scrollIndicators(.hidden)
            .padding(.horizontal, -38)
        }.padding(.top, 8)
    }

    private func stepCard(_ i: Int, _ step: FindCard.Step) -> some View {
        let done = finds.doneSteps[entry.id]?.contains(i) == true
        let now = !done && (finds.doneSteps[entry.id] ?? []).count == i && full
        return VStack(alignment: .leading, spacing: 4) {
            FindPicture(image: step.image, resolve: call.findsURL).frame(width: 240, height: 136).clipShape(RoundedRectangle(cornerRadius: 12)).opacity(done ? 0.5 : 1)
                .accessibilityLabel("Illustration of step \(i + 1)")
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text("\(i + 1)").font(TypeStyle.title(18)).frame(width: 20, alignment: .leading)
                Text(step.text).font(TypeStyle.body(14)).fixedSize(horizontal: false, vertical: true)
            }.foregroundStyle(now ? FindsInk.blueText : CallInk.ink).padding(.top, 4)
            if let source = step.source { Text("From \(source)").font(TypeStyle.body(12)).foregroundStyle(CallInk.mute).padding(.leading, 24) }
            Button { withAnimation(.fade) { finds.toggleStep(i) } } label: {
                HStack(spacing: 4) {
                    Image(systemName: "checkmark").font(.system(size: 12, weight: .semibold))
                    Text("Done").font(TypeStyle.body(14, .medium))
                }
                .foregroundStyle(done ? FindsInk.blueText : CallInk.ink).padding(.horizontal, 12).frame(height: 44)
                .background(done ? FindsInk.blueSoft : FindsInk.white, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(done ? FindsInk.blueSoft : FindsInk.line, lineWidth: 1))
            }.buttonStyle(PressScale()).accessibilityLabel("Step \(i + 1) done").accessibilityAddTraits(done ? .isSelected : [])
        }.frame(width: 240, alignment: .leading)
    }

    // MARK: outfit (r03 "Wear the navy one.")

    @ViewBuilder private var outfit: some View {
        HStack(alignment: .top, spacing: 12) {
            ForEach(Array(card.options.enumerated()), id: \.offset) { _, option in
                VStack(alignment: .leading, spacing: 4) {
                    OptionCrop(frame: entry.frames.indices.contains(option.frame) ? entry.frames[option.frame] : nil, box: option.box, height: full ? 220 : 160)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(option.picked ? FindsInk.blueText : .clear, lineWidth: 2).padding(-4))
                    HStack(spacing: 4) {
                        if option.picked { Image(systemName: "checkmark").font(.system(size: 12, weight: .semibold)).foregroundStyle(FindsInk.blueText) }
                        Text(option.label).font(TypeStyle.body(14, option.picked ? .medium : .regular)).foregroundStyle(option.picked ? CallInk.ink : CallInk.mute)
                    }
                }
                .frame(maxWidth: .infinity)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(option.label + (option.picked ? ", my pick" : ""))
            }
        }.padding(.top, 4)
        if !card.why.isEmpty {
            Text("Why").font(TypeStyle.body(12, .medium)).foregroundStyle(CallInk.mute).padding(.top, 8)
            VStack(alignment: .leading, spacing: 8) {
                ForEach(card.why, id: \.self) { line in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Circle().fill(CallInk.ink).frame(width: 4, height: 4).offset(y: -4)
                        Text(line).font(TypeStyle.body(16)).foregroundStyle(CallInk.ink).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    // MARK: link (r03 #13 / #14)

    @ViewBuilder private var link: some View {
        if let hero = card.hero {
            FindPicture(image: hero, resolve: call.findsURL).frame(height: 132).frame(maxWidth: .infinity).clipShape(RoundedRectangle(cornerRadius: 12))
                .accessibilityLabel("Illustration for \(card.title)")
        }
        if card.page?.opened == false {
            VStack(alignment: .leading, spacing: 4) {
                Text("I couldn’t open this page.").font(TypeStyle.body(14, .semibold))
                Text("These points come from search results about it, not the page itself.").font(TypeStyle.body(14))
                Button("Try again") { finds.ask("Can you try opening that link again?") }.font(TypeStyle.body(14, .medium)).underline().frame(minHeight: 44)
            }
            .foregroundStyle(CallInk.ink).padding(.horizontal, 12).padding(.top, 12).padding(.bottom, 4)
            .frame(maxWidth: .infinity, alignment: .leading).background(FindsInk.skip, in: RoundedRectangle(cornerRadius: 12))
            .accessibilityIdentifier("linkFailed")
        }
        Text("Takeaways").font(TypeStyle.body(12, .medium)).foregroundStyle(CallInk.mute).padding(.top, 8)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(card.steps.enumerated()), id: \.offset) { i, s in
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text("\(i + 1)").font(TypeStyle.title(18)).frame(width: 20, alignment: .leading)
                    Text(s.text).font(TypeStyle.body(16)).fixedSize(horizontal: false, vertical: true)
                }.foregroundStyle(CallInk.ink)
            }
        }
    }

    // MARK: product (PF-1b: two columns, View ↗ opens the shop page in the sheet browser)

    @ViewBuilder private var product: some View {
        let items = Array((card.products ?? []).prefix(2))
        HStack(alignment: .top, spacing: 12) {
            ForEach(items) { p in productColumn(p) }
            if items.count == 1 { Color.clear.frame(maxWidth: .infinity) }
        }.padding(.top, 8)
        .accessibilityElement(children: .contain).accessibilityIdentifier("productView")
    }

    private func productColumn(_ p: FindCard.Product) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            FindPicture(image: p.image, resolve: call.findsURL, showFailText: false, quietGlyph: "bag")
                .aspectRatio(1, contentMode: .fit).clipShape(RoundedRectangle(cornerRadius: 12))
                .accessibilityLabel("Picture of \(p.name)")
            VStack(alignment: .leading, spacing: 4) {
                Text(p.name).font(TypeStyle.body(14, .medium)).foregroundStyle(CallInk.ink).lineLimit(2).multilineTextAlignment(.leading)
                Text(p.store + " · " + (p.price ?? "Price on site")).font(TypeStyle.body(14)).foregroundStyle(CallInk.mute).lineLimit(1)
            }
            if !p.taste.isEmpty { productChip(p.taste, fg: FindsInk.blueText, bg: FindsInk.blueSoft) }
            if !p.situation.isEmpty { productChip(p.situation, fg: CallInk.ink, bg: FindsInk.skip) }
            Button {
                if !offline { withAnimation(.drawer) { finds.state = .full; finds.browser = FindCard.Source.make(title: p.name, url: p.url, domain: p.domain) } }
            } label: {
                HStack(spacing: 4) {
                    Text("View").font(TypeStyle.body(14))
                    Image(systemName: "arrow.up.right").font(.system(size: 12, weight: .medium))
                }.foregroundStyle(CallInk.ink).frame(maxWidth: .infinity).frame(height: 34)
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(FindsInk.line, lineWidth: 1))
                .padding(.vertical, 5).contentShape(Rectangle())
            }.buttonStyle(PressScale()).opacity(offline ? 0.5 : 1)
            .accessibilityLabel("View \(p.name) at \(p.store)").accessibilityIdentifier("productLink-\(p.id)")
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private func productChip(_ text: String, fg: Color, bg: Color) -> some View {
        Text(text).font(TypeStyle.body(12, .medium)).foregroundStyle(fg).fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 12).padding(.vertical, 4).background(bg, in: RoundedRectangle(cornerRadius: 12))
    }

    // MARK: shared sections

    private var askSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Ask about this").font(TypeStyle.body(12, .medium)).foregroundStyle(CallInk.mute)
            FlowRow(spacing: 8) {
                ForEach(card.ask, id: \.self) { q in
                    Button { finds.ask(q) } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "waveform").font(.system(size: 13, weight: .medium)).foregroundStyle(CallInk.mute)
                            Text(q).font(TypeStyle.body(14, .medium)).foregroundStyle(CallInk.ink)
                        }.padding(.horizontal, 12).frame(height: 44).background(FindsInk.skip, in: RoundedRectangle(cornerRadius: 12))
                    }.buttonStyle(PressScale()).disabled(offline || !finds.canAsk).accessibilityHint(finds.canAsk ? "Asks out loud" : "Unavailable while interpreting").accessibilityIdentifier("ask-\(q)")
                }
            }
        }.padding(.top, 8)
    }

    private var sourcesSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Sources").font(TypeStyle.body(12, .medium)).foregroundStyle(CallInk.mute)
            if card.page?.opened == false {
                Text("The page didn’t open. Tap to try it in the browser.").font(TypeStyle.body(14)).foregroundStyle(CallInk.mute)
            }
            VStack(spacing: 0) {
                ForEach(card.sources, id: \.url) { s in
                    Button { if !offline { withAnimation(.drawer) { finds.state = .full; finds.browser = s } } } label: {
                        HStack(spacing: 12) {
                            Text(String(s.domain.prefix(1)).uppercased()).font(TypeStyle.title(14)).frame(width: 24, height: 24).background(FindsInk.skip, in: Circle())
                            VStack(alignment: .leading, spacing: 0) {
                                Text(s.title).font(TypeStyle.body(16, .medium)).foregroundStyle(CallInk.ink).lineLimit(2).multilineTextAlignment(.leading)
                                Text(s.domain).font(TypeStyle.body(14)).foregroundStyle(CallInk.mute)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                            Image(systemName: "arrow.up.right").font(.system(size: 13, weight: .medium)).foregroundStyle(CallInk.mute).frame(width: 20)
                        }.padding(.vertical, 8).frame(minHeight: 64).contentShape(Rectangle())
                        .overlay(alignment: .top) { FindsInk.line.frame(height: 1) }
                    }.buttonStyle(PressScale(scale: 0.99)).opacity(offline ? 0.5 : 1).accessibilityIdentifier("source-\(s.domain)")
                }
            }
        }.padding(.top, 8)
    }

    // r03 #19 "How I found this"
    private var howSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("How I found this").font(TypeStyle.body(12, .medium)).foregroundStyle(CallInk.mute)
            ForEach(card.how, id: \.self) { line in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    // PF-1b has no icons here: the lines use the full column (Figma 179:68)
                    if card.kind != .product {
                        Image(systemName: Self.howIcon(line)).font(.system(size: 13, weight: .medium)).foregroundStyle(CallInk.mute).frame(width: 16)
                    }
                    Text(line).font(TypeStyle.body(14)).foregroundStyle(card.kind == .product && line.hasPrefix("Searched") ? CallInk.mute : CallInk.ink).fixedSize(horizontal: false, vertical: true)
                }
            }
        }.padding(.top, 8).accessibilityElement(children: .combine).accessibilityIdentifier("findHow")
    }

    static func howIcon(_ line: String) -> String {
        let l = line.lowercased()
        if l.contains("illustration") || l.contains("picture") { return "paintbrush" }
        if l.contains("camera") || l.contains("box") || l.contains("frame") { return "viewfinder" }
        if l.contains("open") || l.contains("page") { return "doc.text" }
        return "magnifyingglass"
    }
}

struct SmallChipStyle: ButtonStyle {
    let filled: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(TypeStyle.body(14, .medium)).foregroundStyle(filled ? CallInk.onInk : CallInk.ink)
            .padding(.horizontal, 16).frame(minWidth: 56, minHeight: 44)
            .background(filled ? CallInk.ink : FindsInk.white, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(filled ? CallInk.ink : FindsInk.line, lineWidth: 1))
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
    }
}

/// Wrapping row for the Ask chips (r03 `.askrow` flex-wrap).
struct FlowRow: Layout {
    var spacing: CGFloat = 8
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0, maxX: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width { x = 0; y += row + spacing; row = 0 }
            x += size.width + spacing
            maxX = max(maxX, x - spacing)
            row = max(row, size.height)
        }
        return CGSize(width: min(maxX, width), height: y + row)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, row: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX { x = bounds.minX; y += row + spacing; row = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            row = max(row, size.height)
        }
    }
}

// MARK: - Camera frame with SAM boxes (r03 `.camf`, #4 chip → box, #5 not on your camera)

struct CameraFrame: View {
    let frame: Data?
    let camera: FindCard.Camera
    let items: [FindItem]
    let selected: String?
    let checking: Bool
    let height: CGFloat

    var body: some View {
        GeometryReader { g in
            let w = g.size.width
            let aspect = camera.w > 0 && camera.h > 0 ? CGFloat(camera.h) / CGFloat(camera.w) : 16 / 9
            let h = w * aspect
            let sel = items.first { $0.id == selected }
            let shown = items.filter { $0.box != nil && $0.tier == .have }
            let focus = (sel?.box ?? sel?.hint).map { [$0] } ?? shown.compactMap(\.box)
            let oy = Self.offset(for: focus, imageHeight: h, window: height)
            ZStack(alignment: .topLeading) {
                CallInk.ink
                if let frame, let pic = PlatformImage.make(frame) {
                    pic.resizable().frame(width: w, height: h).brightness(sel != nil ? -0.4 : 0).offset(y: -oy)
                }
                ForEach(shown) { item in
                    box(item.box!, label: label(item), w: w, h: h, oy: oy, on: sel?.id == item.id).opacity(sel == nil || sel?.id == item.id ? 1 : 0)
                }
                if let sel, sel.tier == .maybe, let hint = sel.hint {
                    box(hint, label: "\(sel.name.capitalizedFirst)?", w: w, h: h, oy: oy, on: true, dashed: true)
                }
                Text(camera.label).font(TypeStyle.body(12, .medium)).foregroundStyle(CallInk.onInk).padding(.horizontal, 8).padding(.vertical, 2)
                    .background(CallInk.pill, in: RoundedRectangle(cornerRadius: 3)).frame(width: w - 8, alignment: .trailing).offset(y: 8)
                if let sel, sel.tier == .buy || (sel.tier == .maybe && sel.hint == nil) {
                    Text("Not on your camera").font(TypeStyle.body(14, .medium)).foregroundStyle(CallInk.onInk).padding(.horizontal, 12).padding(.vertical, 8)
                        .background(CallInk.pill, in: RoundedRectangle(cornerRadius: 3)).frame(width: w, height: height).accessibilityIdentifier("notOnCamera")
                }
                if checking { ScanLine().frame(width: w).offset(y: height - 2) }
            }
            .frame(width: w, height: height, alignment: .topLeading)
        }
        .frame(height: height)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .animation(.drawer, value: height)
        .animation(.fade, value: selected)
        .accessibilityElement()
        .accessibilityLabel(a11y)
        .accessibilityIdentifier("findCamera")
    }

    private func label(_ item: FindItem) -> String { item.name.capitalizedFirst + (item.count.map { " · \($0)" } ?? "") }

    private var a11y: String {
        let have = items.filter { $0.tier == .have }.map(\.name)
        let buy = items.filter { $0.tier == .buy }.map(\.name)
        var s = "\(camera.label)."
        if !have.isEmpty { s += " \(have.joined(separator: ", ")) marked." }
        if !buy.isEmpty { s += " No \(buy.joined(separator: " or ")) seen." }
        return s
    }

    /// Vertical offset so the boxes sit inside the window (r03 shows the middle band of the shelf).
    static func offset(for boxes: [NormBox], imageHeight h: CGFloat, window: CGFloat) -> CGFloat {
        guard h > window else { return 0 }
        guard !boxes.isEmpty else { return (h - window) / 2 }
        let top = boxes.map(\.y1).min()! * h, bottom = boxes.map(\.y2).max()! * h
        let center = (top + bottom) / 2
        return min(max(0, center - window / 2), h - window)
    }

    private func box(_ b: NormBox, label: String, w: CGFloat, h: CGFloat, oy: CGFloat, on: Bool, dashed: Bool = false) -> some View {
        let rect = CGRect(x: b.x1 * w, y: b.y1 * h - oy, width: (b.x2 - b.x1) * w, height: (b.y2 - b.y1) * h)
        return ZStack(alignment: .bottomLeading) {
            RoundedRectangle(cornerRadius: 3).fill(on ? FindsInk.blueTint : .clear)
            RoundedRectangle(cornerRadius: 3).strokeBorder(on ? FindsInk.blue : FindsInk.boxLine, style: StrokeStyle(lineWidth: on ? 2 : 1.5, dash: dashed ? [5, 4] : []))
            if on {
                Text(label).font(TypeStyle.body(12, .medium)).foregroundStyle(CallInk.onInk).padding(.horizontal, 6).padding(.vertical, 2)
                    .background(CallInk.pill, in: RoundedRectangle(cornerRadius: 3)).fixedSize().padding(4)
            }
        }
        .frame(width: max(8, rect.width), height: max(8, rect.height))
        .offset(x: rect.minX, y: rect.minY)
    }
}

/// An outfit option cut from its camera frame around the SAM box (or the middle of the frame).
struct OptionCrop: View {
    let frame: Data?
    let box: NormBox?
    let height: CGFloat
    var body: some View {
        GeometryReader { g in
            ZStack {
                FindsInk.skip
                if let frame, let pic = PlatformImage.make(frame), let size = PlatformImage.size(frame) {
                    let b = box ?? NormBox(x1: 0.2, y1: 0.2, x2: 0.8, y2: 0.8)
                    // scale so the box fills the window, centered on it
                    let bw = (b.x2 - b.x1) * size.width, bh = (b.y2 - b.y1) * size.height
                    let scale = max(g.size.width / max(bw, 1), height / max(bh, 1)) * 0.92
                    let cx = (b.x1 + b.x2) / 2 * size.width * scale, cy = (b.y1 + b.y2) / 2 * size.height * scale
                    pic.resizable().frame(width: size.width * scale, height: size.height * scale)
                        .offset(x: g.size.width / 2 - cx, y: height / 2 - cy)
                        .frame(width: g.size.width, height: height, alignment: .topLeading)
                }
            }.frame(width: g.size.width, height: height).clipped()
        }.frame(height: height)
    }
}

// MARK: - Over the call: undo toast (r03 #17)

struct FindsToast: View {
    let finds: FindsModel
    var body: some View {
        HStack(spacing: 12) {
            Text("In Finds").font(TypeStyle.body(14, .medium)).foregroundStyle(CallInk.onInk)
            Button("Undo") { withAnimation(.drawer) { finds.undo() } }.font(TypeStyle.body(14, .medium)).underline().foregroundStyle(CallInk.onInk)
                .padding(.horizontal, 8).frame(minHeight: 44).accessibilityIdentifier("findUndo")
        }
        .padding(.leading, 16).padding(.trailing, 8)
        .background(CallInk.pill, in: RoundedRectangle(cornerRadius: 16))
        .accessibilityElement(children: .contain).accessibilityIdentifier("findToast")
    }
}

/// IC-4 · "안 보임 (실패)" (Figma rp1wR9…, frame 102:2): rgba(17,17,17,.84) card, radius 16, padding 16, 310 wide.
/// Title 15/20 medium, body 14/20 at 76 %, a white 44 pt "Look again". Nothing is guessed: no ingredient is named.
struct FindUnclearCard: View {
    let call: CallController
    var finds: FindsModel { call.finds }
    var body: some View {
        let lines = finds.current?.failureLines
        VStack(alignment: .leading, spacing: 4) {
            Text(lines?.title ?? "I can’t see it clearly").font(TypeStyle.body(15, .medium)).foregroundStyle(CallInk.onInk)
            Text(lines?.body ?? "").font(TypeStyle.body(14)).foregroundStyle(CallInk.onInk.opacity(0.76)).fixedSize(horizontal: false, vertical: true)
            Button { withAnimation(.fade) { call.lookAgain() } } label: {
                Text("Look again").font(TypeStyle.body(16, .medium)).foregroundStyle(CallInk.ink)
                    .frame(maxWidth: .infinity).frame(height: 44).background(CallInk.onInk, in: RoundedRectangle(cornerRadius: 12))
            }.buttonStyle(PressScale()).padding(.top, 8).accessibilityIdentifier("findLookAgain")
        }
        .padding(16).frame(width: 342, alignment: .leading)
        .background(Color(red: 17 / 255, green: 17 / 255, blue: 17 / 255).opacity(0.84), in: RoundedRectangle(cornerRadius: 16))
        .accessibilityElement(children: .contain).accessibilityIdentifier("findUnclear")
    }
}
