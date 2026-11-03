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
                                GlassCTA(color: primaryEnabled ? CallInk.ink : Color(white: 0.8))
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
    @State private var progress = 0.08
    /// V03 face scan: the low-poly net, laid on top-down over 0.4 s when the check answer brings SAM's face points
    @State private var mesh: FaceMesh?
    /// the sparse net for a face too small on the card (FaceMesh.fitted)
    @State private var smallMesh: FaceMesh?
    @State private var reveal = 0.0
    /// the uploaded photo's size (orientation applied), for mapping the points onto the `scaledToFill` frame
    @State private var photoSize = CGSize.zero
    /// the face the photo is cropped to (the net's bounds, image fractions): V03 pans to it with the answer, V02-T keeps it
    @State private var focus: CGRect?
    /// when the bar reached 100 % (the overlay's hold, breathing and fade count from here)
    @State private var doneAt: Date?
    /// one .success haptic when a passed scan reaches 100 %
    @State private var successTick = 0
    /// V03 stays up after the answer for the finish (bar to 100 %, hold, fade) before V02-T / V02-F
    @State private var finished = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var result: ImageCheck? { model.imageCheck }
    /// photo polish: the server polishes this upload and V02-T confirms the polished picture
    private var polishFlow: Bool { result?.polish == true }
    private var analyzing: Bool { model.imageCheckError == nil && (result == nil || (polishFlow && model.polishing)) }
    /// V02-T: the upload passed (today) or the polished picture passed its check (polish flow)
    private var passed: Bool { polishFlow ? model.polished?.passed == true && model.polishedImage != nil : result?.passed == true }
    /// "Try again" on the polished picture (two at most)
    private var canRetry: Bool {
        polishFlow && model.canRetryPolish && (model.polishRetriesLeft > 0 || (model.polished != nil && model.polishedImage == nil))
    }

    var body: some View {
        Group {
            if analyzing || !finished || model.reviewScan != nil { analyzingPage } else { resultPage }
        }
        .onAppear { if !analyzing { finished = true } }   // reopened on V02 (back, review): no replay
        .sensoryFeedback(.success, trigger: successTick)
        .onChange(of: analyzing) { was, now in
            if !was && now { finished = false; doneAt = nil; reveal = mesh == nil ? 0 : 1 }   // "Try again": scan again (polish keeps the mesh)
            if was && !now { Task { await finish() } }
        }
        .onChange(of: result?.imageId, initial: true) { _, _ in showMesh() }
        // the photo's size from the start, so the net's crop and the photo's crop begin at the same place (Codex P2)
        .onChange(of: model.setup.imageData?.count, initial: true) { _, _ in
            photoSize = model.setup.imageData.flatMap { UIImage(data: $0)?.size } ?? .zero
        }
    }

    /// The check answer's face points → the net, swept on from the top over 0.4 s.
    private func showMesh() {
        guard let r = result else { mesh = nil; smallMesh = nil; reveal = 0; focus = nil; return }
        mesh = FaceMesh.make(outline: r.faceOutline, points: r.facePoints, headBox: r.headBox)
        smallMesh = FaceMesh.make(outline: r.faceOutline, points: r.facePoints, headBox: r.headBox, layout: .r02Small)
        guard let mesh else { focus = nil; return }
        // the photo pans to the face with the same 0.4 s curve as the reveal, so the net lands on it
        if reduceMotion { reveal = 1; focus = mesh.bounds } else { withAnimation(Self.finishCurve) { reveal = 1; focus = mesh.bounds } }
    }

    /// r01: the answer takes the bar from where it is to 100 % in 0.4 s on an ease-in-out
    static let finishCurve = Animation.timingCurve(0.65, 0, 0.35, 1, duration: 0.4)

    /// Answer in: the line runs to the bottom (0.4 s); a scan with a net holds it 1 s (the faces breathe) and fades
    /// (0.3 s), with one .success haptic when the check passed; then V02-T / V02-F. No net: straight on; an error too.
    private func finish() async {
        guard model.imageCheckError == nil else { finished = true; return }
        withAnimation(Self.finishCurve) { progress = 1; reveal = 1 }
        try? await Task.sleep(for: .milliseconds(400))
        guard !analyzing else { return }
        doneAt = Date()
        if passed { successTick += 1 }
        // every scan that drew a net holds it (lead 11/4 05:3x: polish and V02-F photos get the net too); the haptic stays for passes
        try? await Task.sleep(for: .milliseconds(mesh != nil ? 1300 : 150))
        guard !analyzing else { return }
        finished = true
    }

    /// V03 "Finding the details that make them recognizable." — a scan line over the photo and the real wait.
    private var analyzingPage: some View {
        WirePage(title: polishFlow ? "Getting your photo\nready for the call." : "Finding the details\nthat make them\nrecognizable.", pageID: "V03", back: { model.back() }) { width, top, _ in
            photo(width: width, height: 240)
                .overlay {
                    // V03 face scan: the line follows the bar; the net comes with the check answer
                    FaceScanOverlay(progress: reduceMotion ? (reveal > 0 ? 1 : 0) : progress, reveal: reveal,
                                    mesh: mesh.map { FaceMesh.fitted(full: $0, small: smallMesh, image: photoSize, in: CGSize(width: width - 48, height: 240)) },
                                    imageSize: photoSize, origin: photoOrigin(CGSize(width: width - 48, height: 240)), doneAt: doneAt,
                                    reduceMotion: reduceMotion || model.reviewScan != nil, showLine: !reduceMotion)
                        .accessibilityIdentifier("faceScan")
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
            if let held = model.reviewScan { progress = held; reveal = held > 0 ? 1 : 0; return }   // screen review
            progress = 0   // a "Try again" starts the bar over
            // r01: p = 0.92 (1 − e^(−t / 3.2 s)) while the check runs (2–5 s, PREP_API.md); the answer finishes it.
            // Photo polish adds ~15–20 s (Muse Image edit + the same check): a slower τ (9 s) so it doesn't sit at 92 %.
            let start = Date()
            while analyzing && !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(120))
                guard analyzing, !Task.isCancelled else { break }   // the answer came in during the sleep: finish() owns the bar now
                let tau = polishFlow ? 9.0 : 3.2
                let target = 0.92 * (1 - exp(-Date().timeIntervalSince(start) / tau))
                withAnimation(.linear(duration: 0.12)) { progress = max(progress, target) }
            }
        }
    }

    /// V02-T (type chips, three green checks, rights line, Use this image) or V02-F (the failed rows, Choose another image).
    private var resultPage: some View {
        WirePage(title: "Bring an image", pageID: passed ? "V02-T" : "V02-F",
                 subtitle: polishFlow && passed ? "We tidied it up for the call." : "One clear front-facing image works best.", back: { model.returnTo(.image) },
                 primary: passed ? "Use this image" : canRetry ? "Try again" : "Choose another image", primaryBusy: model.creatingCompanion,
                 action: {
                     if passed { model.useCheckedImage() }
                     else if canRetry { model.retryPolish() }
                     else { model.setup.imageData = nil; model.rightsAcked = false; model.returnTo(.image) }
                 }) { width, top, _ in
            photo(width: width, height: 289)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                // one polish path, no type: the chips stay on today's V02-T only
                .overlay(alignment: .topLeading) { if passed && !polishFlow { typeChips.padding(12) } }
                .position(x: width / 2, y: 226 + 144.5 + top)
            if passed && canRetry && model.polishRetriesLeft > 0 {
                // V02-T: the polished picture can be made again (same text-link style as NM01 "Use Jin")
                Button { model.retryPolish() } label: {
                    Text("Try again (\(model.polishRetriesLeft) left)").font(TypeStyle.body(14, .medium)).underline().foregroundStyle(CallInk.ink).frame(height: 44)
                }.buttonStyle(.plain).frame(width: width - 62, alignment: .leading).position(x: 31 + (width - 62) / 2, y: 646 + top)
                    .accessibilityIdentifier("polishTryAgain")
            }
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
        if let error = model.polishError { return [(error, false)] }
        guard let r = result else { return [] }
        // Chelsea 11/4: a photo without any face gets one plain line
        if r.reasons.contains(where: { $0.code == "no_face" }) && r.polish != true { return [(Self.noFace, false)] }
        if polishFlow, let p = model.polished {
            if !p.passed { return p.reasons.prefix(2).map { ($0.label, false) } }
            let c = p.checks
            return [("One face, front-facing", c?.oneFaceFrontFacing ?? true), ("Sharp and well lit", c?.sharpAndLit ?? true), ("No text on the image", c?.noText ?? true)]
        }
        // D26: a well-known person is refused whatever the photo quality; one red row with the server's reason
        if let famous = publicFigure { return [(famous, false)] }
        let reason = { (codes: [String], fallback: String) in r.reasons.first { codes.contains($0.code) }?.label ?? fallback }
        let c = r.checks
        return [
            (c?.oneFaceFrontFacing == false ? reason(["no_face", "multiple_faces", "face_covered", "side_view"], "One face, front-facing") : "One face, front-facing", c?.oneFaceFrontFacing ?? r.passed),
            (c?.sharpAndLit == false ? reason(["too_blurry"], "Sharp and well lit") : "Sharp and well lit", c?.sharpAndLit ?? r.passed),
            (c?.noText == false ? reason(["text_on_image"], "No text on the image") : "No text on the image", c?.noText ?? r.passed),
        ]
    }
    private var publicFigure: String? { result?.reasons.first { $0.code == "public_figure" }?.label }
    static let noFace = "We couldn't find a clear face. Try another photo."
    private var note: String {
        if passed { return "Use an image you have the right to use." }
        if model.polishError == nil, result?.reasons.contains(where: { $0.code == "no_face" }) == true { return "" }
        if polishFlow && canRetry { return "Polishing again often fixes this." }
        // PRD v12 D26 V02-F: "This looks like a well-known person. Genita can't bring public figures to life."
        return publicFigure != nil ? "Genita can't bring public figures to life." : "Try one taken in good light, facing the camera."
    }

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

    /// where the uploaded photo's top-left sits in a card of `card` size: centred on the face once the net is known
    private func photoOrigin(_ card: CGSize) -> CGPoint {
        FaceMesh.fillOrigin(image: photoSize, in: card, focus: focus, topMargin: 12)
    }

    /// the photo card: every branch is held to the card's size (Codex P1: the polished picture must not grow the page)
    private func photo(width: CGFloat, height: CGFloat) -> some View {
        photoContent(width: width, height: height).frame(width: width - 48, height: height).clipped()
    }

    @ViewBuilder private func photoContent(width: CGFloat, height: CGFloat) -> some View {
        // the polished picture only on V02-T: V03's finish keeps the original under its face net
        if !analyzing, finished, polishFlow, let data = model.polishedImage, let image = UIImage(data: data) {
            // the whole polished 9:16 picture, as the call will show it, over a soft blur of itself (no grey bars)
            // the fitted picture sets the size; the blurred copy is only a background (it must not grow the frame)
            Image(uiImage: image).resizable().scaledToFit()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background { Image(uiImage: image).resizable().scaledToFill().blur(radius: 24).opacity(0.55) }
                .clipped().accessibilityIdentifier("polishedImage")
        } else if let data = model.setup.imageData, let image = UIImage(data: data) {
            // fills the card like scaledToFill, but cropped to the face (FaceMesh.fillOrigin) in both V03 and V02-T
            let card = CGSize(width: width - 48, height: height)
            let s = max(card.width / max(image.size.width, 1), card.height / max(image.size.height, 1))
            let o = FaceMesh.fillOrigin(image: image.size, in: card, focus: focus, topMargin: 12)
            Image(uiImage: image).resizable()
                .frame(width: image.size.width * s, height: image.size.height * s)
                .offset(x: o.x, y: o.y)
                .frame(width: card.width, height: card.height, alignment: .topLeading)
                .clipped()
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
                // NM01-E / NM01-0 (153:2, 154:2): the field gets a 1.5 pt ink border while typing
                RoundedRectangle(cornerRadius: 12).fill(Color(white: 0.9333))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(CallInk.ink, lineWidth: focused ? 1.5 : 0))
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
            if model.nameError == nil, (model.setup.companionName ?? "").isEmpty, let suggested = model.suggestedCompanionName {
                // NM01-0 (154:2): "Use Jin" puts the suggestion back
                Button { model.setup.companionName = suggested } label: {
                    Text("Use \(suggested)").font(TypeStyle.body(14, .medium)).underline().foregroundStyle(CallInk.ink).frame(height: 44)
                }.buttonStyle(.plain).frame(width: width - 62, alignment: .leading).position(x: 31 + (width - 62) / 2, y: 378 + top)
                    .accessibilityIdentifier("useSuggestedName")
            } else {
                Text(model.nameError ?? "Keep it, or type a new one.").font(TypeStyle.body(14))
                    .foregroundStyle(model.nameError == nil ? CallInk.mute : Color(red: 0.85, green: 0.2, blue: 0.2))
                    .frame(width: width - 62, alignment: .leading).position(x: 31 + (width - 62) / 2, y: 378 + top).accessibilityIdentifier("nameHint")
            }
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
        // the "Add your own" alert's keyboard must not lift Continue over the tiles (UI sweep 11/3: it sat on Design / Food)
        .ignoresSafeArea(.keyboard)
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
            // one left edge with the title (x 31) and the same margin on the right (QA build 5: labels and chips sat at 24)
            let w = Self.tasteColumn(width)
            Text("Tap once if you like it, twice if it\u{2019}s a no.").font(TypeStyle.body(14)).foregroundStyle(SkipInk.mute)
                .frame(width: w, height: 20, alignment: .leading).position(x: 31 + w / 2, y: 186 + 10 + top)
            group("Clothes you reach for", Self.clothes, columns: 3, y: 228, top: top, width: w, state: state)
            group("Food", Self.foods, columns: 3, y: 376, top: top, width: w, state: state)
            group("In our chats", Self.chats, columns: 2, y: 524, top: top, width: w, state: state)
            if let e = model.flowError {   // the import failed (offline / 5xx): say so, Continue retries
                Text(e).font(TypeStyle.body(13)).foregroundStyle(Color(red: 0.85, green: 0.2, blue: 0.2))
                    .frame(width: w, alignment: .leading).position(x: 31 + w / 2, y: 690 + top).accessibilityIdentifier("skipError")
            }
        }
    }
    /// N3's column: the title's left edge (31) to the same margin on the right
    static func tasteColumn(_ width: CGFloat) -> CGFloat { width - 62 }
    private func group(_ label: String, _ items: [String], columns: Int, y: CGFloat, top: CGFloat, width: CGFloat, state: @escaping (String) -> TasteState) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label).font(TypeStyle.body(14, .semibold)).foregroundStyle(CallInk.ink).frame(height: 20).padding(.bottom, 0)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: columns == 3 ? 7.5 : 8), count: columns), spacing: 8) {
                ForEach(items, id: \.self) { tasteChip($0, state: state($0)) { cycleTaste($0) } }
            }.padding(.top, 0)
        }.frame(width: width, height: 124, alignment: .topLeading).position(x: 31 + width / 2, y: y + 62 + top)
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

/// PREP-1 motion and colours (Figma rp1wR9pxV0IsgyjvOcwo92 182:51 / 182:3 / 182:96 / 182:142 notes):
/// photo breathes 1.00 → 1.03 over 8 s, a light band sweeps top → bottom every 2.8 s, a finished stage's check
/// scales 0.8 → 1 in 200 ms, ready = 400 ms crossfade then S07 0.8 s later. Reduce Motion: no breathing, no sweep.
enum PrepStyle {
    static let breathScale: CGFloat = 1.03
    static let breathSeconds: Double = 8
    static let sweepSeconds: Double = 2.8
    static let checkSeconds: Double = 0.2
    static let crossfadeSeconds: Double = 0.4
    static var readyHoldSeconds: Double {
        #if DEBUG
        // UI tests: long enough for XCUITest to see and capture PREP-1c before S07
        if ProcessInfo.processInfo.arguments.contains("--uitesting") { return 3 }
        #endif
        return 0.8
    }
    static let photoHeight: CGFloat = 560
    static let background = Color(red: 17 / 255, green: 17 / 255, blue: 17 / 255)
    static let sub = Color.white.opacity(0.78)
    static let dim = Color.white.opacity(0.46)
    static let disabledFill = Color.white.opacity(0.12)
}

struct BringingView: View {
    @Bindable var model: AppState
    @State private var breathe = false
    @State private var sweep = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var screen: PrepScreen {
        var s = PrepScreen(model.prep, name: model.companionDisplayName)
        // unwired review builds (no server) can always go on
        if !model.serverWired, s.phase == .working { s.primaryEnabled = true }
        return s
    }
    private var still: Bool { reduceMotion || CallMotion.reviewStill }

    var body: some View {
        let s = screen
        GeometryReader { full in
            ZStack(alignment: .top) {
                PrepStyle.background
                photoLayer(width: full.size.width)
                VStack(alignment: .leading, spacing: 0) {
                    Spacer(minLength: 0)
                    Text(s.title).font(TypeStyle.title(35)).kerning(-0.35).foregroundStyle(.white)
                        .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader).accessibilityIdentifier("PREP-1")
                    Text(s.subtitle).font(TypeStyle.body(15)).foregroundStyle(PrepStyle.sub).lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true).padding(.top, 8).accessibilityIdentifier("prepNote")
                    VStack(spacing: 4) { ForEach(s.rows, id: \.stage) { stageRow($0) } }.padding(.top, 20)
                    buttons(s).padding(.top, 20)
                }
                .padding(.horizontal, 24).padding(.bottom, s.phase == .ready ? 168 : 58)
                .frame(width: full.size.width, height: full.size.height)
            }
            .frame(width: full.size.width, height: full.size.height)
        }
        .ignoresSafeArea()
        .task(id: model.prep?.status) { await model.followPrep() }
        .task {
            guard !still else { return }
            withAnimation(.easeInOut(duration: PrepStyle.breathSeconds / 2).repeatForever(autoreverses: true)) { breathe = true }
            withAnimation(.linear(duration: PrepStyle.sweepSeconds).repeatForever(autoreverses: false)) { sweep = true }
        }
        .task(id: s.phase == .ready) {
            // PREP-1c: no button, "Saying hi…", then S07 by itself
            guard s.phase == .ready else { return }
            try? await Task.sleep(for: .seconds(PrepStyle.crossfadeSeconds + PrepStyle.readyHoldSeconds))
            if !Task.isCancelled { model.startFirstCall() }
        }
    }

    /// The uploaded photo, crossfading (400 ms) to the server's call scene once it exists; it fades into the
    /// background over its lower half and a soft light band passes over it while the face is being made.
    private func photoLayer(width: CGFloat) -> some View {
        ZStack {
            uploaded.frame(width: width, height: PrepStyle.photoHeight).clipped()
            if let data = model.sceneImageData, let image = UIImage(data: data) {
                Image(uiImage: image).resizable().scaledToFill().frame(width: width, height: PrepStyle.photoHeight).clipped()
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: PrepStyle.crossfadeSeconds), value: model.sceneImageData != nil)
        .task(id: model.prep?.sceneURL) { await model.loadScene() }
        .scaleEffect(breathe ? PrepStyle.breathScale : 1)
        .frame(width: width, height: PrepStyle.photoHeight).clipped()
        .overlay(alignment: .top) {
            if screen.phase == .working && !still {
                LinearGradient(colors: [.clear, .white.opacity(0.16), .clear], startPoint: .top, endPoint: .bottom)
                    .frame(width: width * 1.6, height: 300).rotationEffect(.degrees(-8))
                    .offset(y: sweep ? PrepStyle.photoHeight : -300).blendMode(.plusLighter).allowsHitTesting(false)
            }
        }
        .overlay(alignment: .bottom) {
            LinearGradient(colors: [PrepStyle.background.opacity(0), PrepStyle.background], startPoint: .top, endPoint: .bottom)
                .frame(height: 300)
        }
        .frame(width: width, height: PrepStyle.photoHeight).clipped()
        .accessibilityLabel("\(model.companionDisplayName)'s photo")
    }

    @ViewBuilder private func buttons(_ s: PrepScreen) -> some View {
        if let primary = s.primary {
            VStack(spacing: 14) {
                Button {
                    if case .failed = s.phase { model.retryPrep() } else { model.startFirstCall() }
                } label: {
                    ZStack {
                        RoundedRectangle(cornerRadius: 12).fill(s.primaryEnabled ? Color.white : PrepStyle.disabledFill)
                        if model.retryingPrep { ProgressView().tint(PrepStyle.background) }
                        else { Text(primary).font(TypeStyle.body(16, .medium)).foregroundStyle(s.primaryEnabled ? CallInk.ink : PrepStyle.dim) }
                    }.frame(height: 50)
                }.buttonStyle(.plain).disabled(!s.primaryEnabled || model.retryingPrep)
                    .accessibilityLabel(primary).accessibilityIdentifier(s.secondary == nil ? "prepContinue" : "prepRetry")
                if let secondary = s.secondary {
                    // off while Try again is in flight: its answer restarts the polling the call relies on
                    Button(secondary) { model.startFirstCall() }.buttonStyle(.plain).disabled(model.retryingPrep)
                        .font(TypeStyle.body(15, .medium)).foregroundStyle(.white.opacity(model.retryingPrep ? 0.46 : 1)).frame(height: 18)
                        .accessibilityIdentifier("prepContinuePhoto")
                }
                if let error = model.prepError, s.secondary != nil {
                    Text(error).font(TypeStyle.body(13)).foregroundStyle(PrepStyle.sub).accessibilityIdentifier("prepError")
                }
            }
        }
    }

    private func stageRow(_ row: PrepScreen.Row) -> some View {
        HStack(spacing: 12) {
            PrepIndicator(status: row.status, still: still).frame(width: 20, height: 20)
            Text(row.title).font(TypeStyle.body(16, .medium)).foregroundStyle(row.status == .pending ? PrepStyle.dim : .white)
            Spacer(minLength: 8)
            Text(row.detail).font(TypeStyle.body(13)).foregroundStyle(PrepStyle.dim)
        }
        .frame(height: 36)
        .accessibilityElement(children: .combine).accessibilityIdentifier("prepStage-\(row.stage.rawValue)")
        .accessibilityValue(row.status.rawValue)
    }

    @ViewBuilder private var uploaded: some View {
        if let data = model.setup.imageData, let image = UIImage(data: data) { Image(uiImage: image).resizable().scaledToFill() }
        else { Image(resource: "companion").resizable().scaledToFill() }
    }
}

/// PREP-1 stage mark (20 pt): done = white disc + black check (scales in), working = blue arc turning,
/// pending = grey ring, failed = white ring with "!" (no warning colour, Figma 182:142).
private struct PrepIndicator: View {
    let status: PrepProgress.Status
    let still: Bool
    @State private var turn = false
    @State private var shown = false

    var body: some View {
        ZStack {
            switch status {
            case .done:
                Circle().fill(.white)
                Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(CallInk.ink)
            case .running:
                Circle().stroke(Color.white.opacity(0.22), lineWidth: 1.5)
                Circle().trim(from: 0, to: 0.3).stroke(CallInk.blueOnInk, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                    .rotationEffect(.degrees(turn ? 360 : 0))
                    .onAppear { if !still { withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) { turn = true } } }
            case .failed:
                Circle().stroke(Color.white, lineWidth: 1.5)
                Text("!").font(TypeStyle.body(12, .semibold)).foregroundStyle(.white)
            case .pending:
                Circle().stroke(PrepStyle.dim, lineWidth: 1.5)
            }
        }
        .scaleEffect(status == .done && !shown ? 0.8 : 1)
        .onChange(of: status) { _, s in
            guard s == .done else { return }
            shown = false
            withAnimation(.easeOut(duration: PrepStyle.checkSeconds)) { shown = true }
        }
        .onAppear { shown = true }
    }
}
