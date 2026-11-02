import SwiftUI
import UIKit

// Screens the server wiring adds between the reference screens (PRD v12 F2–F4):
// V03 / V02-T / V02-F (Figma rp1wR9pxV0IsgyjvOcwo92 150:123, 30:2, 31:2), NM01 (152:2 / 153:2 / 154:2),
// N1–N3 (PRD F2 table), PREP-1 (D38, functional until DS-7 #129 is approved — see `PrepStyle`).
// Same frame as the reference screens: 390 × 844 design points, title at y 98, primary button 108 pt from the bottom.

/// The reference screens' scaffold: back chevron, serif title, grey subtitle, black primary button.
struct WirePage<Content: View>: View {
    var title: String
    /// UI-test handle on the title (a page-level identifier would override every child's identifier)
    var pageID: String? = nil
    var subtitle: String?
    var back: (() -> Void)?
    var primary: String?
    var primaryEnabled = true
    var primaryBusy = false
    var primaryID = "primaryCTA"
    var action: () -> Void = {}
    @ViewBuilder var content: (_ width: CGFloat, _ top: CGFloat, _ bottom: CGFloat) -> Content

    var body: some View {
        GeometryReader { safe in
            GeometryReader { full in
                let top = safe.safeAreaInsets.top - 44
                let footerY = full.size.height - 108
                ZStack(alignment: .topLeading) {
                    Color("Canvas")
                    if let back {
                        Button(action: back) { Image(resource: "reference-back").resizable().frame(width: 8.8, height: 15.8).frame(width: 44, height: 44) }
                            .buttonStyle(.plain).position(x: 38, y: 74 + top).accessibilityLabel("Back").accessibilityIdentifier("back")
                    }
                    // title top at y 98, subtitle 10 pt under it (Figma NM01 152:2 / V02 30:2); a multi-line title pushes the subtitle down
                    VStack(alignment: .leading, spacing: 10) {
                        Text(title).font(TypeStyle.title(35)).kerning(-0.35).foregroundStyle(CallInk.ink)
                            .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                            .accessibilityIdentifier(pageID ?? "pageTitle")
                        if let subtitle { Text(subtitle).font(TypeStyle.body(16)).foregroundStyle(CallInk.mute).fixedSize(horizontal: false, vertical: true) }
                    }.frame(width: full.size.width - 62, alignment: .leading).offset(x: 31, y: 98 + top)
                    content(full.size.width, top, footerY)
                    if let primary {
                        Button(action: action) {
                            ZStack {
                                RoundedRectangle(cornerRadius: 12).fill(primaryEnabled ? CallInk.ink : Color(white: 0.8))
                                if primaryBusy { ProgressView().tint(CallInk.onInk) }
                                else { Text(primary).font(TypeStyle.body(16, .medium)).foregroundStyle(primaryEnabled ? CallInk.onInk : Color(white: 0.65)) }
                            }
                        }.buttonStyle(.plain).disabled(!primaryEnabled || primaryBusy)
                            .frame(width: full.size.width - 77, height: 50).position(x: (full.size.width - 1) / 2, y: footerY + 25)
                            .accessibilityLabel(primary).accessibilityIdentifier(primaryID)
                    }
                }.frame(width: full.size.width, height: full.size.height)
            }.ignoresSafeArea(.container)
        }
    }
}

// MARK: V03 analyzing → V02-T passed / V02-F failed

struct ImageCheckView: View {
    @Bindable var model: AppState
    @State private var scan = 0.0
    @State private var progress = 0.08
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var result: ImageCheck? { model.imageCheck }
    private var analyzing: Bool { result == nil && model.imageCheckError == nil }
    private var passed: Bool { result?.passed == true }

    var body: some View {
        if analyzing { analyzingPage } else { resultPage }
    }

    /// V03 "Finding the details that make them recognizable." — a scan line over the photo and the real wait.
    private var analyzingPage: some View {
        WirePage(title: "Finding the details\nthat make them\nrecognizable.", pageID: "V03", back: { model.back() }) { width, top, _ in
            photo(width: width).frame(width: width - 48, height: 240)
                .overlay(alignment: .top) {
                    Rectangle().fill(Color(red: 0, green: 0.635, blue: 1)).frame(height: 2).shadow(color: Color(red: 0, green: 0.635, blue: 1).opacity(0.6), radius: 6)
                        .offset(y: 240 * CGFloat(scan)).opacity(reduceMotion ? 0 : 1)
                }
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(white: 0.89), lineWidth: 1))
                .position(x: width / 2, y: 280 + 120 + top)
            ZStack(alignment: .leading) {
                Capsule().fill(Color(white: 0.89))
                Capsule().fill(Color(red: 0, green: 0.635, blue: 1)).frame(width: (width - 117) * CGFloat(progress))
            }.frame(width: width - 117, height: 8).position(x: width / 2, y: 625 + top)
            Text("\(Int(progress * 100))%").font(TypeStyle.body(16, .medium)).foregroundStyle(CallInk.ink).position(x: width / 2, y: 660 + top)
                .accessibilityIdentifier("imageCheckProgress")
        }
        .task {
            if !reduceMotion { withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) { scan = 1 } }
            // The check takes 2–5 s (PREP_API.md); the bar eases toward 90 % and the answer finishes it.
            while analyzing && !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(120))
                withAnimation(.linear(duration: 0.12)) { progress = min(0.9, progress + (0.92 - progress) * 0.05) }
            }
        }
    }

    /// V02-T (type chips, three green checks, rights line, Use this image) or V02-F (the failed rows, Choose another image).
    private var resultPage: some View {
        WirePage(title: "Bring an image", pageID: passed ? "V02-T" : "V02-F", subtitle: "One clear front-facing image works best.", back: { model.returnTo(.image) },
                 primary: passed ? "Use this image" : "Choose another image", primaryBusy: model.creatingCompanion,
                 action: { if passed { model.useCheckedImage() } else { model.setup.imageData = nil; model.returnTo(.image) } }) { width, top, _ in
            photo(width: width).frame(width: width - 48, height: 289)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(alignment: .topLeading) { if passed { typeChips.padding(12) } }
                .position(x: width / 2, y: 226 + 144.5 + top)
            VStack(alignment: .leading, spacing: 8) {
                ForEach(rows, id: \.0) { row in
                    HStack(spacing: 8) {
                        Image(systemName: row.1 ? "checkmark" : "xmark").font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(row.1 ? Color(red: 0, green: 0.42, blue: 0.75) : Color(red: 0.85, green: 0.2, blue: 0.2)).frame(width: 20, height: 20)
                        Text(row.0).font(TypeStyle.body(15)).foregroundStyle(CallInk.ink)
                    }.accessibilityElement(children: .combine).accessibilityLabel((row.1 ? "Passed: " : "Failed: ") + row.0)
                }
            }.frame(width: width - 62, alignment: .leading).position(x: 31 + (width - 62) / 2, y: 536 + 41 + top)
            Text(note).font(TypeStyle.body(13)).foregroundStyle(CallInk.mute).frame(width: width - 62, alignment: .leading)
                .position(x: 31 + (width - 62) / 2, y: 686 + top).accessibilityIdentifier(passed ? "rightsLine" : "failHint")
        }
    }

    /// The three V02 rows; a failed check shows the server's own reason text (V02-F).
    private var rows: [(String, Bool)] {
        if let error = model.imageCheckError { return [(error, false)] }
        guard let r = result else { return [] }
        let reason = { (codes: [String], fallback: String) in r.reasons.first { codes.contains($0.code) }?.label ?? fallback }
        let c = r.checks
        return [
            (c?.oneFaceFrontFacing == false ? reason(["no_face", "multiple_faces", "face_covered", "side_view"], "One face, front-facing") : "One face, front-facing", c?.oneFaceFrontFacing ?? r.passed),
            (c?.sharpAndLit == false ? reason(["too_blurry"], "Sharp and well lit") : "Sharp and well lit", c?.sharpAndLit ?? r.passed),
            (c?.noText == false ? reason(["text_on_image"], "No text on the image") : "No text on the image", c?.noText ?? r.passed),
        ]
    }
    private var note: String { passed ? "Use an image you have the right to use." : "Try one taken in good light, facing the camera." }

    private var typeChips: some View {
        HStack(spacing: 4) {
            ForEach([("human", "Person"), ("animal", "Animal"), ("character", "Character")], id: \.0) { kind, label in
                let on = (result?.type ?? "human") == kind
                HStack(spacing: 4) {
                    if on { Image(systemName: "checkmark").font(.system(size: 12, weight: .semibold)) }
                    Text(label).font(TypeStyle.body(14, .medium))
                }.foregroundStyle(on ? CallInk.onInk : CallInk.ink).padding(.horizontal, 12).frame(height: 28)
                    .background(on ? CallInk.ink.opacity(0.84) : Color.white.opacity(0.8), in: Capsule())
                    .accessibilityAddTraits(on ? .isSelected : [])
            }
        }.accessibilityElement(children: .contain).accessibilityIdentifier("typeChips")
    }

    @ViewBuilder private func photo(width: CGFloat) -> some View {
        if let data = model.setup.imageData, let image = UIImage(data: data) {
            Image(uiImage: image).resizable().scaledToFill()
        } else { Color(white: 0.93) }
    }
}

// MARK: NM01 "Give them a name."

struct CompanionNameView: View {
    @Bindable var model: AppState
    @FocusState private var focused: Bool

    private var name: Binding<String> {
        Binding(get: { model.setup.companionName ?? "" },
                set: { model.setup.companionName = String($0.prefix(CompanionName.maxLength)) })   // 21st character can't be typed
    }

    var body: some View {
        WirePage(title: "Give them a name.", pageID: "NM01", subtitle: "Suggested from your chats and photo.", back: { model.back() },
                 primary: "Continue", primaryEnabled: model.validCompanionName, primaryBusy: model.savingName,
                 action: { focused = false; model.saveCompanionName() }) { width, top, _ in
            avatar.frame(width: 72, height: 72).clipShape(Circle()).position(x: 31 + 36, y: 200 + 36 + top)
            ZStack {
                RoundedRectangle(cornerRadius: 12).fill(Color(white: 0.9333))
                if model.suggestingName && (model.setup.companionName ?? "").isEmpty {
                    ProgressView().accessibilityLabel("Suggesting a name")
                } else {
                    TextField("Their name", text: name).font(TypeStyle.body(20, .medium)).multilineTextAlignment(.center)
                        .textContentType(.name).autocorrectionDisabled().submitLabel(.done).focused($focused)
                        .frame(width: 220).accessibilityIdentifier("companionNameInput")
                        .onSubmit { if model.validCompanionName { model.saveCompanionName() } }
                }
                if !(model.setup.companionName ?? "").isEmpty {
                    Button { model.setup.companionName = ""; focused = true } label: {
                        Image(systemName: "xmark.circle").font(.system(size: 18)).foregroundStyle(CallInk.mute).frame(width: 44, height: 44)
                    }.buttonStyle(.plain).frame(maxWidth: .infinity, alignment: .trailing).padding(.trailing, 6)
                        .accessibilityLabel("Clear name").accessibilityIdentifier("clearName")
                }
            }.frame(width: width - 64, height: 56).position(x: width / 2, y: 300 + 28 + top)
            Text(model.nameError ?? "Keep it, or type a new one.").font(TypeStyle.body(13))
                .foregroundStyle(model.nameError == nil ? CallInk.mute : Color(red: 0.85, green: 0.2, blue: 0.2))
                .frame(width: width - 62, alignment: .leading).position(x: 31 + (width - 62) / 2, y: 378 + top).accessibilityIdentifier("nameHint")
        }
        .onAppear { model.suggestName() }
    }

    @ViewBuilder private var avatar: some View {
        if let data = model.setup.imageData, let image = UIImage(data: data) { Image(uiImage: image).resizable().scaledToFill() }
        else { Color(white: 0.9) }
    }
}

// MARK: N1–N3 (no AI assistant, D33)

/// Shared look of N1 / N2 / N3 (Figma 142:2 / 143:2 / 144:2).
private enum SkipInk {
    static let blue = Color(red: 0xd7 / 255, green: 0xf1 / 255, blue: 1)
    static let blueText = Color(red: 0, green: 0x63 / 255, blue: 0x9f / 255)
    static let line = Color(white: 0xe3 / 255)
    static let mute = Color(white: 0x73 / 255)
    static let skipped = Color(white: 0xef / 255)
}

/// The dark-blue check badge on a selected tile / card.
private struct SkipBadge: View {
    var size: CGFloat
    var body: some View {
        ZStack {
            Circle().fill(SkipInk.blueText)
            Image(systemName: "checkmark").font(.system(size: size * 0.5, weight: .bold)).foregroundStyle(.white)
        }.frame(width: size, height: size).accessibilityHidden(true)
    }
}

struct SkipImportView: View {
    @Bindable var model: AppState
    @State private var customOpen = false
    @State private var custom = ""
    @FocusState private var typing: Bool

    private var step: Stage { model.stage }
    /// Merged Dyno + PRD spec (Figma section 267:2, 11/3): N1 267:4, N2 267:57, N3 269:2.
    private var title: String {
        switch step {
        case .skipTopics: "What do you keep\ncoming back to?"
        case .skipReplies: "How do you like to\nthink it through?"
        default: "A little about\nyour taste"
        }
    }
    static let topics = ["Design", "Building things", "Food", "Style", "Film & TV", "Travel"]
    static let replies: [(String, String)] = [("Talk it out", "Think out loud and land somewhere together"), ("Show me options", "Two or three paths to compare"),
                                              ("Start with the answer", "Then walk me through why"), ("Ask me questions", "Help me find it myself")]
    static let clothes = ["Minimal", "Classic", "Street", "Colorful", "Comfy", "Dressy"]
    static let foods = ["Spicy", "Noodles", "Rice dishes", "Seafood", "Cheese", "Sweet"]
    static let chats = ["Jokes", "Unasked advice", "Lots of questions", "Talk about looks"]

    // MARK: answers
    private var selected: [String] {
        switch step {
        case .skipTopics: model.setup.skipInterests ?? []
        case .skipReplies: model.setup.skipReplies.map { [$0] } ?? []
        default: []
        }
    }
    private func toggle(_ v: String) {
        switch step {
        case .skipTopics: var s = model.setup.skipInterests ?? []; if let i = s.firstIndex(of: v) { s.remove(at: i) } else if s.count < 8 { s.append(v) }; model.setup.skipInterests = s
        case .skipReplies: model.setup.skipReplies = model.setup.skipReplies == v ? nil : v
        default: break
        }
    }
    /// N3 chips: tap once = like, twice = avoid, three times = clear (Chelsea 11/3: likes and things to avoid).
    private func cycleTaste(_ v: String) {
        var like = model.setup.skipLikes ?? [], avoid = model.setup.skipAvoid ?? []
        if let i = like.firstIndex(of: v) { like.remove(at: i); avoid.append(v) }
        else if let i = avoid.firstIndex(of: v) { avoid.remove(at: i) }
        else { like.append(v) }
        model.setup.skipLikes = like; model.setup.skipAvoid = avoid
    }
    private func addCustom() {
        let t = custom.trimmingCharacters(in: .whitespacesAndNewlines)
        custom = ""; customOpen = false
        guard !t.isEmpty, !selected.contains(t) else { return }
        toggle(String(t.prefix(step == .skipTopics ? 40 : 60)))
    }

    // MARK: body
    var body: some View {
        WirePage(title: title, pageID: step.rawValue, subtitle: nil, back: { model.back() },
                 primary: "Continue", primaryBusy: model.importing,
                 action: {
                     switch step {
                     case .skipTopics: model.go(.skipReplies)
                     case .skipReplies: model.go(.skipAvoid)
                     default: model.finishSkip()
                     }
                 }) { width, top, _ in
            switch step {
            case .skipTopics: topicsPage(width: width, top: top)
            case .skipReplies: repliesPage(width: width, top: top)
            default: tastePage(width: width, top: top)
            }
        }
        .alert("Add your own", isPresented: $customOpen) {
            TextField("Add your own", text: $custom)
            Button("Add") { addCustom() }
            Button("Cancel", role: .cancel) { custom = "" }
        }
    }

    /// The particle picture behind the content (Figma "Image" node: x, y, w, h in the 390 × 844 frame).
    private func blob(_ name: String, x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat, top: CGFloat) -> some View {
        Image(resource: name).resizable().scaledToFit().frame(width: w, height: h)
            .position(x: x + w / 2, y: y + h / 2 + top).allowsHitTesting(false).accessibilityHidden(true)
    }

    // N1 · 267:4 — 2 × 3 tiles of 150 × 65 at (38, 431), then "Add your own" 313 × 65; picture 0.9 behind
    private func topicsPage(width: CGFloat, top: CGFloat) -> some View {
        let extras = (model.setup.skipInterests ?? []).filter { !Self.topics.contains($0) }
        let items = Self.topics + extras
        return ZStack(alignment: .topLeading) {
            blob("skip-blob-n1", x: -93, y: -70, w: 576, h: 751, top: top)
            ScrollView(showsIndicators: false) {
                VStack(spacing: 9) {
                    LazyVGrid(columns: [GridItem(.fixed(150), spacing: 13), GridItem(.fixed(150))], spacing: 9) {
                        ForEach(items, id: \.self) { item in topicTile(item) }
                    }
                    Button { customOpen = true } label: {
                        Text("Add your own").font(TypeStyle.body(16, .medium)).foregroundStyle(SkipInk.mute)
                            .frame(width: 313, height: 65)
                            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(SkipInk.line, style: StrokeStyle(lineWidth: 1, dash: [2, 1])))
                            .background(.white, in: RoundedRectangle(cornerRadius: 12))
                    }.buttonStyle(.plain).accessibilityIdentifier("skipCustom")
                }.frame(width: 313)
            }.frame(width: 313, height: 287).position(x: 38 + 313 / 2, y: 431 + 287 / 2 + top)
        }
    }
    private func topicTile(_ item: String) -> some View {
        let on = selected.contains(item)
        return Button { toggle(item) } label: {
            Text(item).font(TypeStyle.body(18, .semibold)).foregroundStyle(on ? SkipInk.blueText : CallInk.ink)
                .lineLimit(1).minimumScaleFactor(0.7).padding(.horizontal, 8)
                .frame(maxWidth: .infinity).frame(height: 65)
                .background(on ? SkipInk.blue : .white, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(on ? SkipInk.blue : SkipInk.line, lineWidth: 1))
                .overlay(alignment: .topLeading) { if on { SkipBadge(size: 16).offset(x: 126, y: 6) } }
        }.buttonStyle(.plain).accessibilityAddTraits(on ? .isSelected : []).accessibilityIdentifier("skipChip-\(item)")
    }

    // N2 · 143:2 — four 342 × 68 cards with a one-line hint, one choice
    private func repliesPage(width: CGFloat, top: CGFloat) -> some View {
        ZStack(alignment: .topLeading) {
            blob("skip-blob-n2", x: -61, y: -50, w: 512, h: 667, top: top)
            VStack(spacing: 16) {
                ForEach(Self.replies, id: \.0) { r in
                    let on = model.setup.skipReplies == r.0
                    Button { toggle(r.0) } label: {
                        HStack(spacing: 0) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(r.0).font(TypeStyle.body(18, .semibold)).foregroundStyle(on ? SkipInk.blueText : CallInk.ink).frame(height: 22)
                                Text(r.1).font(TypeStyle.body(13, .medium)).foregroundStyle(on ? SkipInk.blueText : SkipInk.mute).frame(height: 16)
                            }
                            Spacer(minLength: 0)
                            if on { SkipBadge(size: 26).padding(.trailing, 2) }
                        }.padding(.horizontal, 21).frame(width: 342, height: 68)
                            .background(on ? SkipInk.blue : .white, in: RoundedRectangle(cornerRadius: 12))
                            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(on ? SkipInk.blue : SkipInk.line, lineWidth: 1))
                    }.buttonStyle(.plain).accessibilityElement(children: .ignore).accessibilityLabel(r.0 + ", " + r.1)
                        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton).accessibilityIdentifier("skipChip-\(r.0)")
                }
            }.frame(width: 342).position(x: 24 + 171, y: 384 + 320 / 2 + top)
        }
    }

    // N3 · 269:2 — three groups, every chip has three states (off → like → no → off); no picture
    private func tastePage(width: CGFloat, top: CGFloat) -> some View {
        let like = Set(model.setup.skipLikes ?? []), no = Set(model.setup.skipAvoid ?? [])
        func state(_ v: String) -> TasteState { like.contains(v) ? .on : no.contains(v) ? .skipped : .off }
        return ZStack(alignment: .topLeading) {
            Text("Tap once if you like it, twice if it\u{2019}s a no.").font(TypeStyle.body(14)).foregroundStyle(SkipInk.mute)
                .frame(width: 342, height: 20, alignment: .leading).position(x: 31 + 171, y: 186 + 10 + top)
            group("Clothes you reach for", Self.clothes, columns: 3, y: 228, top: top, state: state)
            group("Food", Self.foods, columns: 3, y: 376, top: top, state: state)
            group("In our chats", Self.chats, columns: 2, y: 524, top: top, state: state)
        }
    }
    private func group(_ label: String, _ items: [String], columns: Int, y: CGFloat, top: CGFloat, state: @escaping (String) -> TasteState) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label).font(TypeStyle.body(14, .semibold)).foregroundStyle(CallInk.ink).frame(height: 20).padding(.bottom, 0)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: columns == 3 ? 7.5 : 8), count: columns), spacing: 8) {
                ForEach(items, id: \.self) { tasteChip($0, state: state($0)) { cycleTaste($0) } }
            }.padding(.top, 0)
        }.frame(width: 342, height: 124, alignment: .topLeading).position(x: 24 + 171, y: y + 62 + top)
    }
    private enum TasteState { case off, on, skipped }
    private func tasteChip(_ item: String, state: TasteState, action: @escaping (String) -> Void) -> some View {
        Button { UISelectionFeedbackGenerator().selectionChanged(); action(item) } label: {
            HStack(spacing: 5) {
                if state == .skipped { Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)).frame(width: 12, height: 12) }
                Text(item).font(TypeStyle.body(16, .medium)).lineLimit(1).minimumScaleFactor(0.7)
            }.padding(.horizontal, 4)
                .foregroundStyle(state == .on ? SkipInk.blueText : state == .skipped ? Color(white: 0x94 / 255) : CallInk.ink)
                .frame(maxWidth: .infinity).frame(height: 44)
                .background(state == .on ? SkipInk.blue : .white, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(state == .on ? SkipInk.blue : SkipInk.line,
                                                                       style: StrokeStyle(lineWidth: 1, dash: state == .skipped ? [4, 3] : [])))
        }.buttonStyle(.plain).accessibilityAddTraits(state == .on ? .isSelected : []).accessibilityHint("Double-tap to change")
            .accessibilityValue(state == .skipped ? "Not for me" : state == .on ? "Liked" : "Not selected")
            .accessibilityIdentifier("skipChip-\(item)")
    }
}

/// Wrapping chip rows (N1–N3).
struct FlowChips: View {
    var items: [String]
    var selected: Set<String>
    var toggle: (String) -> Void
    var body: some View {
        ChipLayout(spacing: 8) {
            ForEach(items, id: \.self) { item in
                let on = selected.contains(item)
                Button { toggle(item) } label: {
                    Text(item).font(TypeStyle.body(15, .medium)).foregroundStyle(on ? Color(red: 0, green: 0.635, blue: 1) : CallInk.ink)
                        .padding(.horizontal, 16).frame(height: 44)
                        .background(on ? Color("Selection") : .white, in: RoundedRectangle(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(on ? Color.clear : Color(white: 0.89), lineWidth: 1))
                }.buttonStyle(.plain).accessibilityAddTraits(on ? .isSelected : [])
            }
        }
    }
}

struct ChipLayout: Layout {
    var spacing: CGFloat
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 342
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width { x = 0; y += row + spacing; row = 0 }
            x += size.width + spacing; row = max(row, size.height)
        }
        return CGSize(width: width, height: y + row)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, row: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX { x = bounds.minX; y += row + spacing; row = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing; row = max(row, size.height)
        }
    }
}

// MARK: PREP-1 "Bringing {name} to life" (D38)

/// Styling hooks for PREP-1. DS-7 (#129) is the approved look once it lands; until then this is the
/// functional version in the reference screens' language (photo, slow breathing, a light sweep, three stages).
enum PrepStyle {
    static var breathScale: CGFloat = 1.012
    static var breathSeconds: Double = 3.2
    static var sweepSeconds: Double = 2.4
    static let stageTitles: [PrepProgress.Stage: String] = [.scene: "Scene", .expressions: "Expressions", .mouth: "Mouth"]
    static let stageDetails: [PrepProgress.Stage: String] = [
        .scene: "Framing them for a video call",
        .expressions: "Smiles, blinks and warmth",
        .mouth: "How they move when they talk",
    ]
}

struct BringingView: View {
    @Bindable var model: AppState
    @State private var breathe = false
    @State private var sweep = -1.0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var prep: PrepProgress? { model.prep }
    /// Continue as soon as the call can start (the scene exists, or prep is done/failed); unwired review builds always can.
    private var canContinue: Bool { !model.serverWired || (prep?.canStartCall ?? false) }

    var body: some View {
        WirePage(title: "Bringing \(model.companionDisplayName)\nto life", pageID: "PREP-1", subtitle: nil, back: nil,
                 primary: "Continue", primaryEnabled: canContinue, primaryID: "prepContinue", action: { model.startFirstCall() }) { width, top, bottom in
            photo.frame(width: width - 48, height: 300)
                .scaleEffect(breathe ? PrepStyle.breathScale : 1)
                .overlay {
                    LinearGradient(colors: [.clear, .white.opacity(0.35), .clear], startPoint: .leading, endPoint: .trailing)
                        .frame(width: 120).offset(x: (width - 48) * CGFloat(sweep) / 2).blendMode(.plusLighter).opacity(reduceMotion ? 0 : 1)
                }
                .clipShape(RoundedRectangle(cornerRadius: 16))
                .position(x: width / 2, y: 210 + 150 + top)
                .accessibilityLabel("\(model.companionDisplayName)'s photo")
            VStack(alignment: .leading, spacing: 14) {
                ForEach(PrepProgress.Stage.allCases, id: \.self) { stage in stageRow(stage) }
            }.frame(width: width - 62, alignment: .leading).position(x: 31 + (width - 62) / 2, y: 540 + 60 + top)
            Text(footnote).font(TypeStyle.body(13)).foregroundStyle(CallInk.mute).multilineTextAlignment(.center)
                .frame(width: width - 62).position(x: width / 2, y: bottom - 24).accessibilityIdentifier("prepNote")
        }
        .task { await model.followPrep() }
        .task {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: PrepStyle.breathSeconds).repeatForever(autoreverses: true)) { breathe = true }
            withAnimation(.linear(duration: PrepStyle.sweepSeconds).repeatForever(autoreverses: false)) { sweep = 1 }
        }
        .onChange(of: prep?.isReady) { _, ready in if ready == true { model.startFirstCall() } }
    }

    private var footnote: String {
        if prep?.isFailed == true { return "\(model.companionDisplayName) will use this photo for now." }
        return canContinue ? "You can start now. Their face comes alive during the call." : "This takes a minute or two."
    }

    private func status(_ stage: PrepProgress.Stage) -> PrepProgress.Status {
        guard let prep else { return stage == .scene ? .running : .pending }
        return prep.stages[stage] ?? .pending
    }

    private func stageRow(_ stage: PrepProgress.Stage) -> some View {
        let s = status(stage)
        return HStack(spacing: 12) {
            ZStack {
                Circle().fill(s == .done ? CallInk.ink : Color(white: 0.92)).frame(width: 24, height: 24)
                switch s {
                case .done: Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(CallInk.onInk)
                case .running: ProgressView().controlSize(.mini)
                case .failed: Image(systemName: "minus").font(.system(size: 11, weight: .bold)).foregroundStyle(CallInk.mute)
                case .pending: EmptyView()
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(PrepStyle.stageTitles[stage] ?? "").font(TypeStyle.body(16, .medium)).foregroundStyle(s == .pending ? CallInk.mute : CallInk.ink)
                Text(PrepStyle.stageDetails[stage] ?? "").font(TypeStyle.body(13)).foregroundStyle(CallInk.mute)
            }
        }.accessibilityElement(children: .combine).accessibilityIdentifier("prepStage-\(stage.rawValue)")
            .accessibilityValue(s.rawValue)
    }

    @ViewBuilder private var photo: some View {
        if let data = model.setup.imageData, let image = UIImage(data: data) { Image(uiImage: image).resizable().scaledToFill() }
        else { Image(resource: "companion").resizable().scaledToFill() }
    }
}
