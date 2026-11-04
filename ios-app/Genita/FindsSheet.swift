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
    /// D4: product picture that didn't come — warm neutral, not grey
    static let photoMissing = Color(red: 243 / 255, green: 241 / 255, blue: 237 / 255)
    static let photoMissingGlyph = Color(red: 185 / 255, green: 178 / 255, blue: 166 / 255)
    /// D4: "From your style and what you said · …" Regular 13/18 #6E6E73
    static let sourceLine = Color(red: 110 / 255, green: 110 / 255, blue: 115 / 255)
    /// r02: the serif initial on an ingredient tile with no photo (on the warm #F3F1ED tile)
    static let tileInitial = Color(red: 138 / 255, green: 129 / 255, blue: 115 / 255)
}

/// D48 ③ reason chips under the card title: blue "Your style/taste: …" from the profile, grey "You said: …" from
/// this call (`Reason.from`). VoiceOver reads them as one "Why this: …" line.
struct FindReasonChips: View {
    let reasons: [FindCard.Reason]
    /// CW-02 (춘식이 11/4): an outfit's occasion, last in the same flow — the grey "what you said" chip
    var occasion: (text: String, accessibilityLabel: String)? = nil
    var body: some View {
        // wraps: each chip reads whole (two short chips usually share a line)
        ChipLayout(spacing: 6) {
            ForEach(Array(reasons.enumerated()), id: \.offset) { _, r in
                // blue = from the profile (HISY, import, corrections) · grey = what they said in this call
                let call = r.from == "call"
                Text(r.text).font(TypeStyle.body(13, .medium)).foregroundStyle(call ? CallInk.mute : FindsInk.blueText).lineLimit(1).truncationMode(.tail).frame(maxWidth: 260)
                    .padding(.horizontal, 10).frame(height: 26).background(call ? FindsInk.skip : FindsInk.blueSoft, in: Capsule())
            }
            if let occasion {
                // capped at the content width (390 pt screen − 2 × 38 margin − 2 × 12 padding): ChipLayout proposes no width,
                // so the cap is what makes a long occasion end in "…" on one line (Codex #625 r6)
                Text(occasion.text).font(TypeStyle.body(12, .medium)).foregroundStyle(CallInk.ink).lineLimit(1).truncationMode(.tail)
                    .frame(maxWidth: 290, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 12).padding(.vertical, 4).background(FindsInk.skip, in: RoundedRectangle(cornerRadius: 12))
                    .accessibilityIdentifier("outfitOccasion")
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel([reasons.isEmpty ? nil : "Why this: " + reasons.map(\.text).joined(separator: ", "), occasion?.accessibilityLabel].compactMap { $0 }.joined(separator: ". "))
            .accessibilityIdentifier("findReasons")
    }
}

extension Animation {
    /// r03 `--ease-drawer` cubic-bezier(0.32, 0.72, 0, 1), 420 ms.
    static let drawer = Animation.timingCurve(0.32, 0.72, 0, 1, duration: 0.42)
    /// r03 `--dur-fade` 200 ms ease-out.
    static let fade = Animation.easeOut(duration: 0.2)
}

/// Chelsea 11/4 "never show empty picture content": a card page collects the pictures that failed to load, and every
/// FindPicture under it draws nothing for them (no glyph, no grey box) and reports them so the page drops the slot.
private struct FindsPhotoBrokenKey: EnvironmentKey { static let defaultValue: ((String) -> Void)? = nil }
extension EnvironmentValues {
    var findsPhotoBroken: ((String) -> Void)? {
        get { self[FindsPhotoBrokenKey.self] }
        set { self[FindsPhotoBrokenKey.self] = newValue }
    }
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
    @Environment(\.findsPhotoBroken) private var reportBroken
    var body: some View {
        // motion card 4: the picture replaces its placeholder in a 250 ms fade (flag off / UI tests: as before)
        let fades = MotionFinds.fades
        ZStack {
            FindsInk.skip
            if let image {
                switch image.status {
                case .pending: Shimmer()
                case .failed: failed
                case .ready:
                    if let url = image.url, url.hasPrefix("bundle:"), let pic = BundlePicture.image(String(url.dropFirst(7))) {
                        Self.fill(pic).transition(fades ? .opacity : .identity)
                    } else if let url = image.url.flatMap(resolve) {
                        AsyncImage(url: url, transaction: Transaction(animation: fades ? MotionFinds.photoIn : .fade)) { phase in
                            switch phase {
                            case let .success(pic): Self.fill(pic)
                            case .failure: failed
                            default: Shimmer()
                            }
                        }.id(attempt)
                    } else { failed }
                }
            } else if quietGlyph != nil { failed }
        }
        .findsPhotoFade(image?.status)
        .clipped()
    }
    /// The picture fills the slot it is given and never sizes it: a `scaledToFill` image reports its own (bigger) size,
    /// which let a portrait step photo grow past its frame and slide under the step text (P0, build 13 device shot).
    /// As an overlay on a clear base it takes exactly the proposed size; the caller's clip shape then crops it.
    static func fill(_ pic: Image) -> some View {
        Color.clear.overlay { pic.resizable().scaledToFill() }.clipped()
    }

    @ViewBuilder private var failed: some View {
        if let reportBroken {
            // the page takes the slot away; until then nothing shows (not a placeholder)
            Color.clear.onAppear { reportBroken(image?.url ?? image?.slot ?? "") }
        } else if let quietGlyph {
            // D4: a shop with no readable picture is a warm neutral tile (#F3F1ED) with a 34 pt line glyph (#B9B2A6), not a grey "broken" box
            ZStack {
                FindsInk.photoMissing
                Image(systemName: quietGlyph).font(.system(size: 34, weight: .light)).foregroundStyle(FindsInk.photoMissingGlyph)
            }.accessibilityHidden(true)
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
/// Motion card 4 (flag `motionDetails` on): a white band sweeps left → right every 1.2 s, and the loop stops in UI tests.
struct Shimmer: View {
    /// true while its layer is hidden (the searching layer stays in the tree under the half / full sheet): no 60 fps redraw
    var paused: Bool = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        if MotionDetails.enabled { FindsShimmer(base: FindsInk.skip) } else if reduceMotion || paused { FindsInk.skip } else {
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

/// r01 searching icon: 32 pt soft-blue orb with a magnifier, a 2 pt blue ring turning every 1.1 s. Driven by
/// TimelineView, not an onAppear animation (the layer is built while hidden, so onAppear ran once and froze).
struct SearchOrb: View {
    var paused: Bool = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        ZStack {
            Circle().fill(FindsInk.blueSoft).frame(width: 32, height: 32)
            Image(systemName: "magnifyingglass").font(.system(size: 14, weight: .semibold)).foregroundStyle(FindsInk.blueText)
            if !reduceMotion {
                TimelineView(.animation(minimumInterval: nil, paused: paused)) { context in
                    let t = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.1) / 1.1
                    // CSS: top + left border coloured = a half ring, starting at the top-right corner
                    Circle().trim(from: 0, to: 0.5).stroke(FindsInk.blue, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                        .frame(width: 38, height: 38).rotationEffect(.degrees(135 + 360 * t))
                }
            }
        }.frame(width: 40, height: 40).accessibilityHidden(true)
    }
}

/// r01 stage line: 14 mute, one step every 2 s, pushed up from the bottom (200 ms); stays on the last step.
struct SearchStageLine: View {
    let stages: [String]
    let key: String?
    @State private var start = Date()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.5)) { context in
            let i = min(max(0, Int(context.date.timeIntervalSince(start) / 2)), max(0, stages.count - 1))
            let text = stages.indices.contains(i) ? stages[i] : ""
            ZStack(alignment: .leading) {
                Text(text).font(TypeStyle.body(14)).foregroundStyle(CallInk.mute).lineLimit(1)
                    .id(text).transition(reduceMotion ? AnyTransition.opacity : AnyTransition.push(from: .bottom))
            }
            .frame(maxWidth: .infinity, minHeight: 20, alignment: .leading).clipped()
            .animation(.easeOut(duration: 0.2), value: text)
            .accessibilityElement().accessibilityLabel(text)
        }
        .onChange(of: key, initial: true) { _, _ in start = Date() }
        .onChange(of: stages) { old, new in if old.first != new.first { start = Date() } }
    }
}

/// r01 skeleton row: 64 pt shimmer tile (r12) + three bars 14 / 12 / 10 tall, gap 7.
struct SkeletonRow: View {
    let widths: (CGFloat, CGFloat, CGFloat)
    var paused: Bool = false
    var body: some View {
        HStack(spacing: 12) {
            Shimmer(paused: paused).frame(width: 64, height: 64).clipShape(RoundedRectangle(cornerRadius: 12))
            GeometryReader { g in
                VStack(alignment: .leading, spacing: 7) {
                    Shimmer(paused: paused).frame(width: g.size.width * widths.0, height: 14).clipShape(RoundedRectangle(cornerRadius: 8))
                    Shimmer(paused: paused).frame(width: g.size.width * widths.1, height: 12).clipShape(RoundedRectangle(cornerRadius: 8))
                    Shimmer(paused: paused).frame(width: g.size.width * widths.2, height: 10).clipShape(RoundedRectangle(cornerRadius: 8))
                }.frame(maxHeight: .infinity)
            }.frame(height: 64)
        }
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
    /// b16: peek thumbnails that failed to load (no grey square then)
    @State private var peekBroken: Set<String> = []
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var finds: FindsModel { call.finds }
    /// Motion card 4: the sheet rises on a spring. Full stays on the drawer curve: the 728 pt sheet is exactly the
    /// screen there, so an overshoot would open a gap under it. Flag off, Reduce Motion, UI tests: the drawer curve.
    private var sheetMotion: Animation { MotionDetails.live(reduceMotion: reduceMotion) && finds.state != .full ? MotionFinds.sheetRise : .drawer }
    private var offline: Bool { call.link == .reconnecting || call.finds.offline }
    /// Figma F2 (138:2): a card reopened from Finds is 520 tall (picture 196, CTA 58 above the bottom), not the call's 468.
    static let reopenedHeight: CGFloat = 520
    private var reopenedHalf: Bool { finds.state == .half && finds.current?.reopened == true }

    var body: some View {
        // a failed search has no skeleton rows: the peek height holds its title, reason and Retry / Close (b16)
        let failedSearch = finds.state == .searching && finds.current?.failed != nil
        let visible = reopenedHalf ? Self.reopenedHeight : failedSearch ? SheetState.peek.height : finds.state.height
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
        .animation(sheetMotion, value: finds.state)
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

    // MARK: Finds r01 ① searching (298, b16): the question as the title, a stage line that moves on every 2 s,
    // two shimmering rows where the results will land, Stop as a 36 pt outlined pill. The sheet ends 20 pt under them.

    private var searchLayer: some View {
        let f = finds.current
        // hidden under half / full (opacity 0, still in the tree): 13 TimelineViews redrawing every frame made the drag lag
        let hidden = finds.state != .searching
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                SearchOrb(paused: hidden)
                VStack(alignment: .leading, spacing: 0) {
                    // one line each next to Stop at 390 pt (Chelsea 11/3): never wraps, never cuts a word
                    OneLineText(text: f?.failureLines?.title ?? f?.searchTitle ?? "Looking", font: TypeStyle.body(16, .medium), color: CallInk.ink)
                        .accessibilityIdentifier("findSearchTitle")
                    if let failBody = f?.failureLines?.body, !failBody.isEmpty {
                        OneLineText(text: failBody, font: TypeStyle.body(14), color: CallInk.mute, alternates: OneLineText.afterDot(failBody))
                            .accessibilityIdentifier("findSearchDetail")
                    } else if f?.failed == nil {
                        SearchStageLine(stages: Self.searchStages(f?.searchDetail ?? ""), key: f?.id)
                            .accessibilityIdentifier("findSearchDetail")
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
                Button {
                    withAnimation(.drawer) { f?.failed == nil ? finds.stop() : f?.canRetry == true ? finds.retry() : finds.close() }
                } label: {
                    Text(f?.failed == nil ? "Stop" : f?.canRetry == true ? "Retry" : "Close")
                        .font(TypeStyle.body(14, .medium)).foregroundStyle(CallInk.ink).lineLimit(1)
                        .padding(.horizontal, 14).frame(height: 36)
                        .background(CallInk.sheet, in: Capsule()).overlay(Capsule().strokeBorder(FindsInk.line, lineWidth: 1))
                        .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(PressScale())
                .accessibilityIdentifier(f?.canRetry == true ? "findRetry" : "findStop")
            }.frame(minHeight: 52)
            if f?.failed == nil {
                VStack(spacing: 14) {
                    ForEach(0..<2, id: \.self) { i in SkeletonRow(widths: i == 1 ? (0.60, 0.82, 0.40) : (0.78, 0.94, 0.40), paused: hidden) }
                }.padding(.top, 18).accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 38).padding(.top, 32)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .accessibilityElement(children: .contain).accessibilityIdentifier("findSearching")
    }

    /// r01 stage line: the server's detail first ("Searching the web", "Reading 8 pages", "Picking the best 5"), then
    /// the steps after it, so an older server that only sends "Searching the web" still moves on. Never goes back.
    static func searchStages(_ detail: String) -> [String] {
        let d = detail.trimmingCharacters(in: .whitespacesAndNewlines)
        let l = d.lowercased()
        if l.hasPrefix("picking") { return [d] }
        if l.hasPrefix("reading") { return [d, "Picking the best"] }
        return [d.isEmpty ? "Searching the web" : d, "Reading pages", "Picking the best"]
    }

    // MARK: r03 #9 peek (148)

    private var peekLayer: some View {
        let f = finds.current
        return ZStack(alignment: .topLeading) {
            Button { withAnimation(.drawer) { finds.tapPeek() } } label: {
                HStack(spacing: 12) {
                    // b16: the thumbnail only when the picture is there (no grey square)
                    if let hero = f?.card?.hero, hero.status != .failed, !peekBroken.contains(hero.url ?? hero.slot) {
                        FindPicture(image: hero, resolve: call.findsURL, showFailText: false)
                            .frame(width: 44, height: 44).clipShape(RoundedRectangle(cornerRadius: 12))
                            .environment(\.findsPhotoBroken) { key in Task { @MainActor in _ = peekBroken.insert(key) } }
                    }
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
        // r01 foot: pinned to the VISIBLE bottom: button top = visible − (safe bottom 34 + 8) − 50. While rising
        // (298) it is placed for half (468), so it sits under the visible part and comes up with the sheet.
        let visible: CGFloat = full ? 728 : reopenedHalf ? Self.reopenedHeight : 468
        let buttonTop = visible - (34 + 8) - 50
        // pages end where the foot's 12 pt white bar starts; the 28 pt fade above it lies over the page
        let pageHeight: CGFloat = buttonTop - 12
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
                // r03 `.main::before`: clean top edge under the face window
                CallInk.sheet.frame(height: 64).allowsHitTesting(false)
            }
            // r01 `.foot::before`: 28 pt fade, then a 12 pt white bar, the button, and white down to the visible bottom
            VStack(spacing: 0) {
                LinearGradient(colors: [CallInk.sheet.opacity(0), CallInk.sheet], startPoint: .top, endPoint: .bottom).frame(height: 28).allowsHitTesting(false)
                CallInk.sheet.frame(height: 12).allowsHitTesting(false)
                foot.background(CallInk.sheet)
                CallInk.sheet.frame(height: 34 + 8).allowsHitTesting(false)
            }.offset(y: buttonTop - 12 - 28)
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
                        Image(systemName: call.micOn ? "mic.fill" : "mic").font(.system(size: 22, weight: .medium))   // ~50 % of the 50 pt circle (18 pt read as shrunken, icon sweep 11/4)
                            .foregroundStyle(CallInk.onInk).frame(width: 50, height: 50).background(CallInk.ink, in: Circle())
                    }.buttonStyle(PressScale(scale: 0.96)).accessibilityLabel(call.micOn ? "Mute" : "Unmute")
                }
                let reopened = finds.current?.reopened == true
                if card?.kind == .product, !reopened {
                    // PF-1b/c: one button — Save to Finds, then Open Finds (grey)
                    let saved = finds.current?.saved == true
                    Button { if saved { openFinds?() } else { finds.toggleSave() } } label: {
                        Text(saved ? "Open Finds" : "Save to Finds").font(TypeStyle.body(16, .medium)).foregroundStyle(saved ? CallInk.ink : CallInk.onInk)
                            .frame(maxWidth: .infinity).frame(height: 50).background(GlassCTA(color: saved ? FindsInk.skip : CallInk.ink))
                    }.buttonStyle(PressScale()).accessibilityIdentifier(saved ? "openFinds" : "findCTA").accessibilitySortPriority(-10)
                } else {
                // r03 F2 `.fcta`: on a card reopened from Finds the one button continues the call about it
                // P0 11/4: on a recipe it starts the walkthrough (full sheet on the steps), then reads "Next step"
                let walking = finds.walking != nil && finds.walking == finds.current?.id
                Button {
                    if reopened { finds.talkAboutThis(); talk?() }
                    else if walking { withAnimation(.fade) { finds.nextStep() } }
                    else if let card, card.kind == .recipe, !card.steps.isEmpty { withAnimation(.drawer) { finds.walkThrough() } }
                    else if let card { finds.ask(Self.cta(card.kind)) }
                } label: {
                    Text(reopened ? "Talk about this on a call" : walking ? "Next step" : (card.map { Self.cta($0.kind) } ?? "")).font(TypeStyle.body(16, .medium)).foregroundStyle(CallInk.onInk)
                        .frame(maxWidth: .infinity).frame(height: 50).background(GlassCTA(color: CallInk.ink))
                }.buttonStyle(PressScale()).disabled(!reopened && !finds.canAsk).opacity(reopened || finds.canAsk ? 1 : 0.4).accessibilityIdentifier(reopened ? "findTalk" : "findCTA").accessibilitySortPriority(-10)
                }
            }
        }.frame(width: size.width - 76).padding(.horizontal, 38)
    }

    static func newFindLabel(_ kind: FindKind?) -> String {
        switch kind {
        case .recipe: "New recipe"
        case .outfit: "New outfit"
        case .product: "New pick"
        default: "New find"
        }
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
        let card = finds.entries.first { $0.id == finds.newFind }?.card
        // the kind only, never a cut title ("New: Wear the tren…", pixel QA 11/4); the title is in the VoiceOver label
        let label = Self.newFindLabel(card?.kind)
        return Button { withAnimation(.drawer) { finds.viewNewFind() } } label: {
            HStack(spacing: 8) {
                FindsTalkWave(color: CallInk.onInk)
                Text(label).font(TypeStyle.body(14, .semibold)).foregroundStyle(CallInk.onInk).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                Text("View").font(TypeStyle.body(14, .medium)).underline().foregroundStyle(CallInk.onInk)
            }.padding(.leading, 14).padding(.trailing, 12).frame(width: 228, height: 44).background(GlassCTA(color: CallInk.ink))
        }
        .accessibilityLabel(card.map { "\(label): \($0.title). View" } ?? "\(label). View")
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
    /// The ingredient chip row is scrolled to its end (no right-edge fade then).
    @State private var chipsAtEnd = false
    /// Motion card 5: one selection haptic per chip tap.
    @State private var chipTaps = 0
    /// Motion card 6: counts saves (not unsaves) — the bookmark pops, a shine crosses the card, one success haptic.
    @State private var saveTick = 0
    @Environment(\.openURL) private var openURL
    private var layout: FindCardLayout { card.cardLayout }
    /// Pictures that failed to load on this page (by url): their slots go away (b16, never an empty picture).
    @State private var brokenPhotos: Set<String> = []

    /// The picture to draw, or nil when there is none, it failed, or it failed to load: then no slot at all.
    private func shows(_ img: FindImage?) -> FindImage? {
        guard let img, img.status != .failed else { return nil }
        if brokenPhotos.contains(img.url ?? img.slot) { return nil }
        return img
    }
    private func usable(_ img: FindImage) -> Bool { shows(img) != nil }

    var body: some View {
        ScrollViewReader { reader in
        ScrollView(.vertical) {
            // motion card 4: blocks lift in one after another (header, title → info → photo → the rest), 40 ms apart
            VStack(alignment: .leading, spacing: 8) {
                header.findsRise(0)
                titleRow.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { titleRowHeight = $0 }
                // r02 visual cards: one layout per kind of answer (`card.layout`, else by `kind` as before)
                switch layout {
                case .recipe: recipe
                case .outfit: outfit.findsRise(3)
                case .product: product.findsRise(3)
                case .place: placeList
                case .howTo: howTo.findsRise(3)
                case .general: link.findsRise(3)
                }
                if !card.ask.isEmpty { askSection.findsRise(4).id("ask") }
                // r01: a link / unknown card already lists its results once, as rows (no second "Sources" list)
                if !card.sources.isEmpty, [.recipe, .outfit].contains(layout) { sourcesSection.findsRise(4).id("sources") }
                if !card.how.isEmpty { howSection.findsRise(4).id("how") }
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
        // motion card 6: saving (bookmark or Save to Finds) sends one blue shine across the card + a success haptic
        .onChange(of: finds.savePulse) { _, _ in if finds.current?.id == entry.id { saveTick += 1 } }
        .findsShine(saveTick, color: FindsInk.blue.opacity(0.16))
        .findsHaptic(.success, trigger: saveTick)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Find \(index + 1) of \(finds.cardCount): \(card.title)")
        .accessibilityIdentifier("findPage\(index)")
        .environment(\.findsPhotoBroken) { key in
            guard !brokenPhotos.contains(key) else { return }
            Task { @MainActor in withAnimation(.fade) { _ = brokenPhotos.insert(key) } }
        }
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
                    Image(systemName: entry.saved ? "bookmark.fill" : "bookmark").font(.system(size: 17, weight: .medium)).foregroundStyle(entry.saved ? FindsInk.blueText : CallInk.ink)
                        .findsBounce(saveTick) // motion card 6: pops as it fills
                        .frame(width: 44, height: 44).contentShape(Rectangle())
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
                    .findsRise(1)
                if !card.subtitle.isEmpty {
                    Text(entry.reopened ? Self.reopenedSubtitle(card.subtitle) : card.subtitle)
                        .font(TypeStyle.body(14)).foregroundStyle(CallInk.mute).lineLimit(1).truncationMode(.tail)
                        .findsRise(2)
                }
                // D48 ③: why this fits you — 1–2 chips from the user's own taste lines (not on link cards)
                // CW-02 (춘식이 11/4): an outfit's occasion goes last in the same chip flow (blue taste chips, then grey)
                let reasons = card.kind == .link ? [] : Array((card.reasons ?? []).prefix(2))
                if !reasons.isEmpty || card.occasionChip != nil { FindReasonChips(reasons: reasons, occasion: card.occasionChip).padding(.top, 8).findsRise(2) }
            }.frame(maxWidth: .infinity, alignment: .leading)
            // r02: the 56 pt thumbnail stays where nothing bigger shows the picture (a named dish, place, how-to and web
            // answers already draw it large)
            if layout == .outfit || layout == .product || (layout == .recipe && card.camera != nil), let hero = shows(card.hero) {
                FindPicture(image: hero, resolve: call.findsURL, showFailText: false).frame(width: 56, height: 56).clipShape(RoundedRectangle(cornerRadius: 12))
                    .accessibilityLabel("Illustration of \(card.title)")
                    .findsRise(3)
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

    /// r02 recipe: the camera frame (fridge) or the dish photo (a named dish), the ingredient tiles (one scrolling row in
    /// the half sheet, a 4-column grid in the full one), then the numbered step cards.
    @ViewBuilder private var recipe: some View {
        // a reopened card's half page is 396: 396 − 40 − 44 − 3 × 8 − 94 strip = 194 for title row + picture
        let reopenedCap: CGFloat = card.title.count <= 17 ? 196 : 130
        let reopenedRoom: CGFloat = titleRowHeight > 0 ? 194 - titleRowHeight : 196
        let reopenedHeight: CGFloat = min(reopenedCap, reopenedRoom)
        let reopenedPicture: CGFloat = reopenedHeight >= 72 ? reopenedHeight : 0
        let camHeight: CGFloat = full ? 196 : (entry.reopened ? reopenedPicture : halfCameraHeight)
        if let cam = card.camera, camHeight > 0, entry.frames.indices.contains(cam.frame) {
            // b16: only with the camera frame itself (no black box when the frame isn't on this phone)
            CameraFrame(frame: entry.frames[cam.frame], camera: cam, items: card.items, selected: finds.selectedItem,
                        checking: entry.checking, height: camHeight)
                .findsRise(3)
        } else if card.camera == nil, let photo = shows(card.dishPhoto), camHeight > 0 {
            // r01 top-pick photo language: radius 12, 164 tall in the full sheet
            FindPicture(image: photo, resolve: call.findsURL, showFailText: false)
                .frame(height: full ? 164 : camHeight).frame(maxWidth: .infinity).clipShape(RoundedRectangle(cornerRadius: 12))
                .accessibilityLabel("Photo of \(card.title)").accessibilityIdentifier("findDishPhoto")
                .findsRise(3)
        }
        if full {
            sectionLabel("Ingredients").findsRise(4)
            ingredientGrid.findsRise(4)
        } else {
            ingredientStrip.findsRise(4)
        }
        if let sel = card.items.first(where: { $0.id == finds.selectedItem }), sel.tier == .maybe { confirmRow(sel) }
        // id "steps": "Walk me through it" scrolls here (#767 walkThrough → scrollTarget "steps")
        if !card.steps.isEmpty { stepCards(doneButtons: true).findsRise(4).id("steps") }
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text).font(TypeStyle.body(12, .medium)).foregroundStyle(CallInk.mute).padding(.top, 10)
    }

    /// The half-sheet ingredient strip: 6 (room for the corner chip) + 64 pt tile + 7 + one 17 pt name line.
    static let stripHeight: CGFloat = 94

    /// Half sheet (344 pt page, scrolling off): the picture gives way so the ingredient tiles show whole under a
    /// two-line title. 344 − 40 top − 44 header − 3 × 8 spacing − 94 tile strip = 142 for title row + picture; 132 at
    /// most (r03), 72 at least. With accessibility text sizes the title row alone can take the room (AX-L): then the
    /// half sheet drops the picture (it is in the full sheet) so the ingredient tiles stay whole.
    static func halfCameraHeight(titleRow: CGFloat) -> CGFloat {
        let room: CGFloat = 236 - stripHeight - titleRow   // 236 = 344 − 40 − 44 − 3 × 8 (one literal: the iOS type checker timed out on the sum)
        return room >= 72 ? min(132, room) : 0
    }
    private var halfCameraHeight: CGFloat { titleRowHeight > 0 ? Self.halfCameraHeight(titleRow: titleRowHeight) : 132 }

    // r02 tiles, r03 order: missing first (blue +), then what you have (✓); maybe = faded "?"
    private var ingredientStrip: some View {
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: 12) {
                ForEach(orderedItems) { item in tile(item, strip: true) }
            }.padding(.horizontal, 38).padding(.top, 6)
        }
        .scrollIndicators(.hidden)
        .onScrollGeometryChange(for: Bool.self) { g in g.contentOffset.x + g.containerSize.width >= g.contentSize.width - 1 } action: { _, end in chipsAtEnd = end }
        .padding(.horizontal, -38)
        // the row runs off the sheet's edge: a 24 pt fade says "more", not a hard cut; none once scrolled to the end
        .mask {
            HStack(spacing: 0) {
                Color.black
                LinearGradient(colors: [.black, .black.opacity(chipsAtEnd ? 1 : 0)], startPoint: .leading, endPoint: .trailing).frame(width: 24)
            }
        }
        .findsHaptic(.selection, trigger: chipTaps) // motion card 5: one selection tick per tap
        .accessibilityElement(children: .contain).accessibilityLabel("Ingredients")
    }

    private var ingredientGrid: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12, alignment: .topLeading), count: 4), alignment: .leading, spacing: 16) {
            ForEach(orderedItems) { item in tile(item, strip: false) }
        }
        .padding(.top, 6)
        .findsHaptic(.selection, trigger: chipTaps)
        .accessibilityElement(children: .contain).accessibilityLabel("Ingredients")
    }

    /// One ingredient: 64 pt photo tile (warm tile + serif initial when there is none), the have / need / maybe chip
    /// on its corner, the name (13 medium) and, in the grid, the amount (12 mute). Same taps as the r03 chips.
    private func tile(_ item: FindItem, strip: Bool) -> some View {
        // MO-05: "+" = add it to the recipe's shopping list; ✓ only once it is added, a second tap takes it off.
        // Rides the `motionDetails` flag: off → the old tap (select it, "Not on your camera").
        let addable = item.tier == .buy && MotionDetails.enabled
        let pressed = finds.selectedItem == item.id && !addable
        let added = addable && finds.isAdded(item.id, in: entry.id)
        let miss = item.tier == .buy && !added
        let amount = [item.tileAmount, item.optional == true ? "optional" : nil].compactMap { $0 }.joined(separator: " · ")
        return Button {
            chipTaps += 1
            withAnimation(.fade) { if addable { finds.toggleAdded(item.id, in: entry.id) } else { finds.tapItem(item) } }
        } label: {
            if let pic = shows(item.tilePicture) {
                VStack(alignment: .leading, spacing: 0) {
                    FindPicture(image: pic, resolve: call.findsURL, showFailText: false)
                        .frame(width: 64, height: 64).clipShape(RoundedRectangle(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(pressed ? CallInk.ink : .clear, lineWidth: 2))
                        .opacity(item.tier == .maybe && !pressed ? 0.55 : item.tier == .checking ? 0.5 : 1)
                        .overlay(alignment: .topTrailing) { tileBadge(item, pressed: pressed, added: added, miss: miss).offset(x: 5, y: -5) }
                    Text(item.tileName).font(TypeStyle.body(13, .medium)).foregroundStyle(miss ? FindsInk.blueText : CallInk.ink)
                        .lineLimit(strip ? 1 : 2).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true).padding(.top, 7)
                    if !strip, !amount.isEmpty {
                        Text(amount).font(TypeStyle.body(12)).foregroundStyle(CallInk.mute).lineLimit(1)
                    }
                }
                .frame(width: strip ? 64 : nil, alignment: .leading)
                .frame(maxWidth: strip ? 64 : .infinity, alignment: .leading)
                .contentShape(Rectangle())
            } else {
                // b16: no photo → no tile at all (never a blank or letter square); the chip leads the name
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .center, spacing: 5) {
                        tileBadge(item, pressed: pressed, added: added, miss: miss, size: 18)
                        Text(item.tileName).font(TypeStyle.body(13, .medium)).foregroundStyle(pressed ? CallInk.ink : miss ? FindsInk.blueText : CallInk.ink)
                            .lineLimit(strip ? 1 : 2).multilineTextAlignment(.leading).fixedSize(horizontal: strip, vertical: true)
                    }
                    if !strip, !amount.isEmpty {
                        Text(amount).font(TypeStyle.body(12)).foregroundStyle(CallInk.mute).lineLimit(1).padding(.leading, 23)
                    }
                }
                .opacity(item.tier == .maybe && !pressed ? 0.55 : item.tier == .checking ? 0.5 : 1)
                .padding(.vertical, 4)
                .frame(maxWidth: strip ? nil : .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
        }
        .buttonStyle(FindsChipPress())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(chipLabel(item, added: added) + (item.tileAmount.map { ", \($0)" } ?? ""))
        .accessibilityHint(addable ? (added ? "Takes it off your list" : "Adds it to your list") : "")
        .accessibilityAddTraits(pressed || added ? [.isSelected, .isButton] : .isButton)
        .accessibilityIdentifier("chip-\(item.name)")
    }

    /// 22 pt chip on the tile's corner with a 2 pt sheet ring: + need (blue soft), ✓ added (blue), ✓ have (ink),
    /// ? maybe (white), spinner while checking.
    private func tileBadge(_ item: FindItem, pressed: Bool, added: Bool, miss: Bool, size: CGFloat = 22) -> some View {
        let icon = miss ? "plus" : item.tier == .maybe ? "questionmark" : "checkmark"
        let fg: Color = miss ? FindsInk.blueText : item.tier == .maybe ? CallInk.mute : CallInk.onInk
        let bg: Color = miss ? FindsInk.blueSoft : added ? FindsInk.blueText : item.tier == .maybe || item.tier == .checking ? FindsInk.white : CallInk.ink
        return ZStack {
            Circle().fill(bg)
            if item.tier == .maybe || item.tier == .checking { Circle().strokeBorder(FindsInk.line, lineWidth: 1) }
            if item.tier == .checking { ProgressView().controlSize(.mini).tint(CallInk.mute) }
            else { Image(systemName: icon).font(.system(size: size / 2, weight: .bold)).foregroundStyle(fg).findsSymbolReplace(icon) }
        }
        .frame(width: size, height: size)
        .background(Circle().fill(CallInk.sheet).padding(-2))
        .accessibilityHidden(true)
    }

    private func chipLabel(_ item: FindItem, added: Bool) -> String {
        switch item.tier {
        case .have: "\(item.name), on your camera"
        case .maybe: "\(item.name)? Not sure. Tap to confirm"
        case .buy: "\(item.name), not on your camera\(item.optional == true ? ", optional" : "")\(added ? ", added to your list" : "")"
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

    /// r02 numbered step cards (recipe and how-to): the step's photo 150 tall when one came (none → text only, never an
    /// empty box), serif number, 15/21 text, a hairline between steps; recipes keep the 36 pt Done pill.
    private func stepCards(doneButtons: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            sectionLabel("Steps").padding(.bottom, 2)
            ForEach(Array(card.steps.enumerated()), id: \.offset) { i, step in
                stepCard(i, step, doneButton: doneButtons)
                    .overlay(alignment: .top) { if i > 0 { FindsInk.line.frame(height: 1) } }
            }
        }.accessibilityElement(children: .contain).accessibilityIdentifier("findSteps")
    }

    private func stepCard(_ i: Int, _ step: FindCard.Step, doneButton: Bool) -> some View {
        let done = doneButton && finds.doneSteps[entry.id]?.contains(i) == true
        let now = doneButton && !done && (finds.doneSteps[entry.id] ?? []).count == i && full
        return VStack(alignment: .leading, spacing: 0) {
            Group {
                if let img = shows(step.image) {
                    FindPicture(image: img, resolve: call.findsURL, showFailText: false)
                        .frame(height: 150).frame(maxWidth: .infinity).clipShape(RoundedRectangle(cornerRadius: 12))
                        .accessibilityLabel("Photo of step \(i + 1)")
                        .padding(.bottom, 12)
                }
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("\(i + 1)").font(TypeStyle.title(20)).frame(width: 24, alignment: .leading)
                    Text(step.text).font(TypeStyle.body(15)).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
                }.foregroundStyle(now ? FindsInk.blueText : CallInk.ink)
                if let source = step.source { Text("From \(source)").font(TypeStyle.body(12)).foregroundStyle(CallInk.mute).padding(.leading, 30).padding(.top, 4) }
            }.opacity(done ? 0.5 : 1)
            if doneButton {
                Button { withAnimation(.fade) { finds.toggleStep(i) } } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold))
                        Text("Done").font(TypeStyle.body(13, .medium))
                    }
                    .foregroundStyle(done ? FindsInk.blueText : CallInk.ink).padding(.horizontal, 14).frame(height: 36)
                    .background(done ? FindsInk.blueSoft : CallInk.sheet, in: Capsule())
                    .overlay(Capsule().strokeBorder(done ? FindsInk.blueSoft : FindsInk.line, lineWidth: 1))
                    .padding(.vertical, 4).contentShape(Rectangle())
                }.buttonStyle(PressScale()).padding(.leading, 30).padding(.top, 6)
                .accessibilityLabel("Step \(i + 1) done").accessibilityAddTraits(done ? .isSelected : [])
            }
        }
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: outfit (r03 "Wear the navy one.")

    @ViewBuilder private var outfit: some View {
        HStack(alignment: .top, spacing: 12) {
            ForEach(Array(card.options.enumerated()), id: \.offset) { _, option in
                VStack(alignment: .leading, spacing: 4) {
                    // b16: the crop only when its camera frame is on this phone (no grey box)
                    if entry.frames.indices.contains(option.frame) {
                        OptionCrop(frame: entry.frames[option.frame], box: option.box, height: full ? 220 : 160)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(option.picked ? FindsInk.blueText : .clear, lineWidth: 2).padding(-4))
                    }
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
        if !card.whyLines.isEmpty {
            Text("Why").font(TypeStyle.body(12, .medium)).foregroundStyle(CallInk.mute).padding(.top, 8)
            VStack(alignment: .leading, spacing: 8) {
                ForEach(card.whyLines, id: \.self) { line in
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
        if card.sources.isEmpty, let hero = shows(card.hero) {
            // r02: every answer leads with its picture, r01 top-pick size
            FindPicture(image: hero, resolve: call.findsURL, showFailText: false).frame(height: 164).frame(maxWidth: .infinity).clipShape(RoundedRectangle(cornerRadius: 12))
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
        if card.sources.isEmpty {
            // a single read page (no result list): its points, numbered
            if !card.steps.isEmpty {
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
        } else {
            resultList
        }
    }

    // MARK: Finds r01 ② results: each result once. #1 big with its photo, the rest as 64 pt thumbnail rows.

    /// The rows under the top pick: every result once, in order, without the one shown big.
    private var restRows: [(offset: Int, element: FindCard.Source)] {
        let top = card.topPick(usable: usable)?.index
        return card.sources.enumerated().filter { $0.offset != top }.map { (offset: $0.offset, element: $0.element) }
    }

    @ViewBuilder private var resultList: some View {
        let pick = card.topPick(usable: usable)
        if let pick {
            topPick(card.sources[pick.index], index: pick.index, photo: pick.photo).findsRise(3)
        }
        VStack(spacing: 0) {
            ForEach(Array(restRows.enumerated()), id: \.element.element.url) { n, item in
                resultRow(item.element, index: item.offset, divider: n > 0).findsRise(min(4 + n, 8))
            }
        }.padding(.top, pick == nil ? 4 : 6)
    }

    private func openSource(_ s: FindCard.Source) {
        if !offline { withAnimation(.drawer) { finds.state = .full; finds.browser = s } }
    }

    private func topPick(_ s: FindCard.Source, index: Int, photo: FindImage) -> some View {
        let why = Self.why(s, index: index, steps: card.steps, sourceCount: card.sources.count)
        return Button { openSource(s) } label: {
            VStack(alignment: .leading, spacing: 0) {
                FindPicture(image: photo, resolve: call.findsURL, showFailText: false)
                    .frame(height: 164).frame(maxWidth: .infinity).clipShape(RoundedRectangle(cornerRadius: 12))
                    .overlay(alignment: .topLeading) {
                        Text("Top pick").font(TypeStyle.body(12, .medium)).foregroundStyle(CallInk.ink)
                            .padding(.horizontal, 9).padding(.vertical, 3)
                            .background(CallInk.sheet.opacity(0.92), in: Capsule()).padding(10)
                    }
                Text(Self.title(s)).font(TypeStyle.body(17, .semibold)).foregroundStyle(CallInk.ink).lineLimit(2)
                    .multilineTextAlignment(.leading).padding(.top, 12)
                if let why {
                    Text(why).font(TypeStyle.body(14)).lineSpacing(3).foregroundStyle(Self.whyInk).lineLimit(2)
                        .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true).padding(.top, 3)
                }
                sourceLine(s).padding(.top, 6)
            }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }
        .buttonStyle(PressScale(scale: 0.99)).opacity(offline ? 0.5 : 1).padding(.top, 10)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(["Top pick", Self.title(s), why, s.domain].compactMap { $0 }.joined(separator: ". "))
        .accessibilityIdentifier("source-\(s.domain)")
    }

    private func resultRow(_ s: FindCard.Source, index: Int, divider: Bool) -> some View {
        let why = Self.why(s, index: index, steps: card.steps, sourceCount: card.sources.count)
        return Button { openSource(s) } label: {
            HStack(alignment: .top, spacing: 12) {
                // b16: a row with no picture is a text row (no letter tile, no empty square)
                if let img = shows(s.image) {
                    FindPicture(image: img, resolve: call.findsURL, showFailText: false)
                        .frame(width: 64, height: 64).clipShape(RoundedRectangle(cornerRadius: 12)).accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: 0) {
                    Text(Self.title(s)).font(TypeStyle.body(15.5, .semibold)).foregroundStyle(CallInk.ink).lineLimit(1)
                    if let why {
                        Text(why).font(TypeStyle.body(14)).lineSpacing(3).foregroundStyle(Self.whyInk).lineLimit(2)
                            .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true).padding(.top, 1)
                    }
                    sourceLine(s).padding(.top, 4)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 12).padding(.horizontal, 10)
            .overlay(alignment: .top) {
                if divider { FindsInk.line.frame(height: 1).padding(.leading, shows(s.image) == nil ? 10 : 86).padding(.trailing, 10) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScale(scale: 0.99)).opacity(offline ? 0.5 : 1)
        .padding(.horizontal, -10)
        .accessibilityElement(children: .combine)
        .accessibilityLabel([Self.title(s), why, s.domain].compactMap { $0 }.joined(separator: ". "))
        .accessibilityIdentifier("source-\(s.domain)")
    }

    /// 16 pt favicon when it loads (b16: never a letter tile in its place) + domain, 13 mute.
    private func sourceLine(_ s: FindCard.Source) -> some View {
        HStack(spacing: 0) {
            if let fav = s.favicon, let url = fav.hasPrefix("http") ? URL(string: fav) : call.findsURL(fav) {
                AsyncImage(url: url) { phase in
                    if case let .success(pic) = phase {
                        pic.resizable().scaledToFit().frame(width: 16, height: 16).clipShape(RoundedRectangle(cornerRadius: 4)).padding(.trailing, 6)
                    }
                }
            }
            Text(s.domain).font(TypeStyle.body(13)).foregroundStyle(CallInk.mute).lineLimit(1)
        }
    }

    static let whyInk = Color(red: 74 / 255, green: 74 / 255, blue: 74 / 255)

    /// The title without a " — why" tail (an older server keeps the reason on the title).
    static func title(_ s: FindCard.Source) -> String {
        let t = s.displayTitle
        if s.why == nil, let r = t.range(of: " — ") { return String(t[..<r.lowerBound]) }
        return t
    }

    /// Why this result: `why` from the server; else the " — why" tail on its title; else the matching step
    /// ("Title — why", by url, or by position); nil → no line at all (never an empty label).
    static func why(_ s: FindCard.Source, index: Int, steps: [FindCard.Step], sourceCount: Int) -> String? {
        func clean(_ v: String?) -> String? {
            guard let v = v?.trimmingCharacters(in: .whitespacesAndNewlines), !v.isEmpty else { return nil }
            return v
        }
        if let w = clean(s.why) { return w }
        if let r = s.title.range(of: " — "), let w = clean(String(s.title[r.upperBound...])) { return w }
        // by url, then by title, then by position only when steps and sources line up one to one
        let t = title(s)
        let step = steps.first { $0.source == s.url } ?? steps.first { $0.text.hasPrefix(t + " — ") }
            ?? (steps.count == sourceCount && steps.indices.contains(index) ? steps[index] : nil)
        guard let text = clean(step?.text) else { return nil }
        if let r = text.range(of: " — ") { return clean(String(text[r.upperBound...])) }
        // a step that is only the same title says nothing new
        return text.caseInsensitiveCompare(title(s)) == .orderedSame ? nil : text
    }

    static func initial(_ domain: String) -> String {
        let d = domain.hasPrefix("www.") ? String(domain.dropFirst(4)) : domain
        return String(d.prefix(1)).uppercased()
    }

    /// A steady colour per site (sum of its letters, not `hashValue`, which changes every launch).
    static func siteColor(_ domain: String) -> Color {
        let palette: [Color] = [
            Color(red: 31 / 255, green: 111 / 255, blue: 178 / 255), Color(red: 232 / 255, green: 89 / 255, blue: 12 / 255),
            Color(red: 0, green: 170 / 255, blue: 108 / 255), Color(red: 112 / 255, green: 72 / 255, blue: 232 / 255),
            Color(red: 201 / 255, green: 42 / 255, blue: 42 / 255), Color(red: 11 / 255, green: 114 / 255, blue: 133 / 255),
        ]
        let sum = domain.unicodeScalars.reduce(0) { $0 + Int($1.value) }
        return palette[sum % palette.count]
    }

    // MARK: r02 place: #1 photo 164 + name + ★ rating (reviews) · hours + address + Map / Website pills; the rest as r01
    // rows with the rating line and the address instead of the reason

    @ViewBuilder private var placeList: some View {
        let pick = card.topPick(usable: usable)
        if let pick {
            placeTop(card.sources[pick.index], index: pick.index, photo: pick.photo).findsRise(3)
        }
        VStack(spacing: 0) {
            ForEach(Array(restRows.enumerated()), id: \.element.element.url) { n, item in
                placeRow(item.element, index: item.offset, divider: n > 0).findsRise(min(4 + n, 8))
            }
        }.padding(.top, pick == nil ? 4 : 10)
        .accessibilityElement(children: .contain).accessibilityIdentifier("placeList")
    }

    private func placeTop(_ s: FindCard.Source, index: Int, photo: FindImage) -> some View {
        let place = s.place
        return VStack(alignment: .leading, spacing: 0) {
            Button { openSource(s) } label: {
                VStack(alignment: .leading, spacing: 0) {
                    FindPicture(image: photo, resolve: call.findsURL, showFailText: false)
                        .frame(height: 164).frame(maxWidth: .infinity).clipShape(RoundedRectangle(cornerRadius: 12))
                        .overlay(alignment: .topLeading) {
                            Text("Top pick").font(TypeStyle.body(12, .medium)).foregroundStyle(CallInk.ink)
                                .padding(.horizontal, 9).padding(.vertical, 3)
                                .background(CallInk.sheet.opacity(0.92), in: Capsule()).padding(10)
                        }
                    Text(s.placeName).font(TypeStyle.body(17, .semibold)).foregroundStyle(CallInk.ink).lineLimit(2)
                        .multilineTextAlignment(.leading).padding(.top, 12)
                    if let place { placeMeta(place).padding(.top, 3) }
                    if let address = place?.address, !address.isEmpty {
                        Text(address).font(TypeStyle.body(14)).foregroundStyle(CallInk.mute).lineLimit(2).multilineTextAlignment(.leading).padding(.top, 2)
                    } else if let why = Self.why(s, index: index, steps: card.steps, sourceCount: card.sources.count) {
                        Text(why).font(TypeStyle.body(14)).foregroundStyle(Self.whyInk).lineLimit(2).multilineTextAlignment(.leading).padding(.top, 3)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(PressScale(scale: 0.99)).opacity(offline ? 0.5 : 1)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(["Top pick", s.placeName, place?.accessibilityText].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ". "))
            .accessibilityIdentifier("placeTop")
            HStack(spacing: 8) {
                if let map = place?.mapLink {
                    Button { openURL(map) } label: { pillLabel("Map", icon: "mappin.and.ellipse", filled: true) }
                        .buttonStyle(PressScale()).accessibilityLabel("Open \(s.placeName) in Maps").accessibilityIdentifier("placeMap")
                }
                Button { openSource(s) } label: { pillLabel("Website", icon: "arrow.up.right", filled: place?.mapLink == nil, trailingIcon: true) }
                    .buttonStyle(PressScale()).opacity(offline ? 0.5 : 1).accessibilityIdentifier("placeWebsite")
            }.padding(.top, 8)
        }.padding(.top, 10)
    }

    /// r01 36 pt pill (ink filled or outlined) inside a 44 pt target.
    private func pillLabel(_ text: String, icon: String, filled: Bool, trailingIcon: Bool = false) -> some View {
        HStack(spacing: 5) {
            if !trailingIcon { Image(systemName: icon).font(.system(size: 12, weight: .medium)) }
            Text(text).font(TypeStyle.body(13, .medium)).lineLimit(1)
            if trailingIcon { Image(systemName: icon).font(.system(size: 11, weight: .medium)) }
        }
        .foregroundStyle(filled ? CallInk.onInk : CallInk.ink).padding(.horizontal, 16).frame(height: 36)
        .background(filled ? CallInk.ink : CallInk.sheet, in: Capsule())
        .overlay { if !filled { Capsule().strokeBorder(FindsInk.line, lineWidth: 1) } }
        .padding(.vertical, 4).contentShape(Rectangle())
    }

    /// "★ 4.6 (1,203) · Open until 10 PM" on one line; only the parts the server sent.
    @ViewBuilder private func placeMeta(_ p: FindCard.Source.Place) -> some View {
        let hours = p.hours?.trimmingCharacters(in: .whitespaces) ?? ""
        if p.ratingText != nil || !hours.isEmpty {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                if let r = p.ratingText {
                    Text("★ " + r).font(TypeStyle.body(14, .semibold)).foregroundStyle(CallInk.ink)
                    if let n = p.reviewsText { Text(n).font(TypeStyle.body(14)).foregroundStyle(Self.whyInk) }
                }
                if p.ratingText != nil, !hours.isEmpty { Text("·").font(TypeStyle.body(14)).foregroundStyle(Self.whyInk) }
                if !hours.isEmpty { Text(hours).font(TypeStyle.body(14, p.hoursSayOpen ? .medium : .regular)).foregroundStyle(p.hoursSayOpen ? CallInk.ink : Self.whyInk).lineLimit(1) }
            }.lineLimit(1)
        }
    }

    private func placeRow(_ s: FindCard.Source, index: Int, divider: Bool) -> some View {
        let place = s.place
        let why = Self.why(s, index: index, steps: card.steps, sourceCount: card.sources.count)
        return Button { openSource(s) } label: {
            HStack(alignment: .top, spacing: 12) {
                // b16: a row with no picture is a text row (no letter tile, no empty square)
                if let img = shows(s.image) {
                    FindPicture(image: img, resolve: call.findsURL, showFailText: false)
                        .frame(width: 64, height: 64).clipShape(RoundedRectangle(cornerRadius: 12)).accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: 0) {
                    Text(s.placeName).font(TypeStyle.body(15.5, .semibold)).foregroundStyle(CallInk.ink).lineLimit(1)
                    if let place { placeMeta(place).padding(.top, 1) }
                    if let address = place?.address, !address.isEmpty {
                        Text(address).font(TypeStyle.body(13)).foregroundStyle(CallInk.mute).lineLimit(1).padding(.top, 2)
                    } else if let why {
                        Text(why).font(TypeStyle.body(14)).lineSpacing(3).foregroundStyle(Self.whyInk).lineLimit(2)
                            .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true).padding(.top, 1)
                    }
                    if place == nil { sourceLine(s).padding(.top, 4) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 12).padding(.horizontal, 10)
            .overlay(alignment: .top) {
                if divider { FindsInk.line.frame(height: 1).padding(.leading, shows(s.image) == nil ? 10 : 86).padding(.trailing, 10) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScale(scale: 0.99)).opacity(offline ? 0.5 : 1)
        .padding(.horizontal, -10)
        .accessibilityElement(children: .combine)
        .accessibilityLabel([s.placeName, place?.accessibilityText, place == nil ? why : nil].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ". "))
        .accessibilityIdentifier("source-\(s.domain)")
    }

    // MARK: r02 how-to: the same step cards (no Done), then the sources once as r01 rows

    @ViewBuilder private var howTo: some View {
        stepCards(doneButtons: false)
        if !card.sources.isEmpty {
            sectionLabel("Sources")
            VStack(spacing: 0) {
                ForEach(Array(card.sources.enumerated()), id: \.element.url) { i, s in
                    resultRow(s, index: i, divider: i > 0)
                }
            }
        }
    }

    // MARK: product (PF-1b: two columns; r02: Open in browser goes straight to the shop page in the browser)

    @ViewBuilder private var product: some View {
        // b16: a shop with no picture is left out while another one has one; with none, both show as text
        let all = Array((card.products ?? []).prefix(2))
        let pictured = all.filter { shows($0.image) != nil }
        let items = pictured.isEmpty ? all : pictured
        HStack(alignment: .top, spacing: 12) {
            ForEach(Array(items.enumerated()), id: \.element.id) { i, p in productColumn(p, primary: i == 0) }
            if items.count == 1 { Color.clear.frame(maxWidth: .infinity) }
        }.padding(.top, 8)
        .accessibilityElement(children: .contain).accessibilityIdentifier("productView")
    }

    /// Half sheet (364 pt page, no scrolling): the picture gives way so Open in browser shows above Save to Finds
    /// (Chelsea 11/4: the pill sat under the CTA). 364 − 40 top − 44 header − 8 − title row − 8 − 8 − (8 + 20 + 4 + 20)
    /// name + store − 8 − 44 pill = 152 − title row; 56 at least, the square (151) at most.
    static func halfProductPicture(titleRow: CGFloat) -> CGFloat {
        let room: CGFloat = 152 - titleRow
        return max(56, min(151, room))
    }

    private func openProduct(_ p: FindCard.Product) {
        // r02: straight to the shop's page in the browser (not the in-sheet one)
        if !offline, let url = ExternalLink.web(p.url) { openURL(url) }
    }

    private func productColumn(_ p: FindCard.Product, primary: Bool) -> some View {
        let pictureHeight: CGFloat? = full ? nil : Self.halfProductPicture(titleRow: titleRowHeight > 0 ? titleRowHeight : 54)
        return VStack(alignment: .leading, spacing: 8) {
            // b16: the picture, the name and the store open the shop too (tapping them did nothing)
            Button { openProduct(p) } label: {
                VStack(alignment: .leading, spacing: 8) {
                    // b16: no picture → no picture box (the hanger tile is gone); the text and the pill stay
                    if let img = shows(p.image) {
                        Group {
                            if let h = pictureHeight {
                                FindPicture(image: img, resolve: call.findsURL, showFailText: false)
                                    .frame(maxWidth: .infinity).frame(height: h)
                            } else {
                                FindPicture(image: img, resolve: call.findsURL, showFailText: false)
                                    .aspectRatio(1, contentMode: .fit)
                            }
                        }.clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(p.name).font(TypeStyle.body(14, .medium)).foregroundStyle(CallInk.ink).lineLimit(full ? 2 : 1).multilineTextAlignment(.leading)
                        Text(p.store + " · " + (p.price ?? "Price on site")).font(TypeStyle.body(14)).foregroundStyle(CallInk.mute).lineLimit(1)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(PressScale(scale: 0.98)).opacity(offline ? 0.5 : 1)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(p.name), \(p.store), \(p.price ?? "price on site")")
            .accessibilityHint("Opens it in the browser")
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("productCard-\(p.id)")
            // the reason chips show in the full sheet; at half the pill comes first (it has to clear the CTA)
            if full {
                // D4: ✦ = your style, “ = what you said (no colour legend)
                if !p.taste.isEmpty { productChip(p.taste, mark: ProductPicks.styleMark, fg: FindsInk.blueText, bg: FindsInk.blueSoft) }
                if !p.situation.isEmpty { productChip(p.situation, mark: ProductPicks.saidMark, fg: CallInk.ink, bg: FindsInk.skip) }
            }
            Button { openProduct(p) } label: {
                // r01: a 36 pt pill, the first card ink, the other outlined; 13 pt so it stays one line in a column
                HStack(spacing: 4) {
                    Text("Open in browser").font(TypeStyle.body(13, .medium)).lineLimit(1).minimumScaleFactor(0.85)
                    Image(systemName: "arrow.up.right").font(.system(size: 11, weight: .medium))
                }.foregroundStyle(primary ? CallInk.onInk : CallInk.ink).padding(.horizontal, 10).frame(maxWidth: .infinity).frame(height: 36)
                .background(primary ? CallInk.ink : CallInk.sheet, in: Capsule())
                .overlay { if !primary { Capsule().strokeBorder(FindsInk.line, lineWidth: 1) } }
                .padding(.vertical, 4).contentShape(Rectangle())
            }.buttonStyle(PressScale()).opacity(offline ? 0.5 : 1)
            .accessibilityLabel("Open \(p.name) at \(p.store) in the browser").accessibilityIdentifier("productLink-\(p.id)")
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private func productChip(_ text: String, mark: String, fg: Color, bg: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(mark).font(TypeStyle.body(13, .medium)).accessibilityHidden(true)
            Text(text).font(TypeStyle.body(12, .medium)).fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(fg)
        .padding(.horizontal, 12).padding(.vertical, 4).background(bg, in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(mark == ProductPicks.styleMark ? "Your style: \(text)" : "You said: \(text)")
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

    // r03 #19 "How I found this"; D4: a product card says it in one line instead of a colour legend
    @ViewBuilder private var howSection: some View {
        if card.kind == .product && card.evidence != nil {
            // one line when it fits; else the sites on their own line (3x check: "…what you said ·" ended a line)
            let parts = ProductPicks.sourceParts(card)
            ViewThatFits(in: .horizontal) {
                Text(ProductPicks.sourceLine(card)).lineLimit(1)
                VStack(alignment: .leading, spacing: 5) {
                    Text(parts.from)
                    if let sites = parts.sites { Text(sites) }
                }
            }
            .font(TypeStyle.body(13)).foregroundStyle(FindsInk.sourceLine)
            .padding(.top, 8).accessibilityElement(children: .combine).accessibilityIdentifier("findHow")
        } else {
            howList
        }
    }
    @ViewBuilder private var howList: some View {
        // D4: never the old colour legend (cards saved before the marks, or an older server); r01: no label without lines
        let lines = card.how.filter { !ProductPicks.isLegend($0) }
        if !lines.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
            Text("How I found this").font(TypeStyle.body(12, .medium)).foregroundStyle(CallInk.mute)
            ForEach(lines, id: \.self) { line in
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
        // the label sits at the box's bottom-left, pulled back inside the window when the box is at its edge
        // (a box at the top of the frame cut "Egg" in half, pixel QA 11/4)
        let labelX = min(max(rect.minX + 4, 4), w - 4 - Self.labelWidth(label))
        let labelY = min(max(rect.maxY - 4 - Self.labelHeight, 4), height - 4 - Self.labelHeight)
        return ZStack(alignment: .topLeading) {
            ZStack {
                RoundedRectangle(cornerRadius: 3).fill(on ? FindsInk.blueTint : .clear)
                RoundedRectangle(cornerRadius: 3).strokeBorder(on ? FindsInk.blue : FindsInk.boxLine, style: StrokeStyle(lineWidth: on ? 2 : 1.5, dash: dashed ? [5, 4] : []))
            }
            .frame(width: max(8, rect.width), height: max(8, rect.height))
            .offset(x: rect.minX, y: rect.minY)
            if on {
                Text(label).font(TypeStyle.body(12, .medium)).foregroundStyle(CallInk.onInk).padding(.horizontal, 6).padding(.vertical, 2)
                    .background(CallInk.pill, in: RoundedRectangle(cornerRadius: 3)).fixedSize()
                    .offset(x: labelX, y: labelY)
            }
        }
    }
    /// The box label pill: 12 pt medium + 2 pt top/bottom padding.
    static let labelHeight: CGFloat = 20
    private static func labelWidth(_ label: String) -> CGFloat {
        #if canImport(UIKit)
        let font = UIFont(name: "PretendardVariable-Medium", size: 12) ?? .systemFont(ofSize: 12, weight: .medium)
        return ceil((label as NSString).size(withAttributes: [.font: font]).width) + 12
        #else
        return CGFloat(label.count) * 7 + 12
        #endif
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
            Text("In Finds").font(TypeStyle.body(14, .medium)).foregroundStyle(CallInk.onInk).lineLimit(1).fixedSize(horizontal: true, vertical: false)
            Button("Undo") { withAnimation(.drawer) { finds.undo() } }.font(TypeStyle.body(14, .medium)).underline().foregroundStyle(CallInk.onInk).lineLimit(1).fixedSize(horizontal: true, vertical: false)
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
                    .frame(maxWidth: .infinity).frame(height: 44).background(GlassCTA(color: CallInk.onInk))
            }.buttonStyle(PressScale()).padding(.top, 8).accessibilityIdentifier("findLookAgain")
        }
        .padding(16).frame(width: 342, alignment: .leading)
        .background(Color(red: 17 / 255, green: 17 / 255, blue: 17 / 255).opacity(0.84), in: RoundedRectangle(cornerRadius: 16))
        .accessibilityElement(children: .contain).accessibilityIdentifier("findUnclear")
    }
}
