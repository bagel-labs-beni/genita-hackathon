import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

@MainActor struct ReferenceOnboardingView: View {
    @Bindable var model: AppState
    var referenceViewport = false
    @State private var keyboardTop = CGFloat.greatestFiniteMagnitude
    @State private var copied = false
    /// I01 "Open ChatGPT / Open Claude": the prompt was copied and the AI app was opened; coming back lands on I02
    @State private var openedAI = false
    @State private var leftApp = false
    @State private var copiedToast = false
    @State private var pasteHighlight = false
    @Environment(\.scenePhase) private var scenePhase
    @AccessibilityFocusState private var pasteFocused: Bool
    @State private var progress = 0.0
    @State private var importing = false
    @State private var pickingPhoto = false
    /// V01 "Use a test photo" sheet (device QA accounts only, QASamplePhotos.swift)
    @State private var pickingSample = false
    @State private var imageError: String?
    @State private var player = VoicePlayer()
    @FocusState private var nameFocused: Bool
    let stage: Stage
    init(model: AppState, stage: Stage? = nil, referenceViewport: Bool = false) {
        self.model = model; self.stage = stage ?? model.stage; self.referenceViewport = referenceViewport
    }
    var screen: String { stage == .summary ? model.setup.depth == .quick ? "summaryQuick" : model.setup.depth == .deep ? "summaryDeep" : "summary" : stage.rawValue }
    var nodes: [DesignNode] { DesignLibrary.nodes(screen) }
    var texts: [DesignNode] { nodes.filter { $0.type == "text" } }
    var title: DesignNode { texts.first { $0.fontFamily == "KMU80 TTF" }! }
    var orb: DesignNode? { nodes.first { $0.name.hasPrefix("soul-orb") } }
    var primaryTitle: String {
        switch stage { case .name: "Next"; case .prompt: "Paste response"; case .paste: "Use this response"; case .preparing: "Continue in the background"; case .preferences: "Continue setup"; case .image: "Use this image"; default: "Continue" }
    }
    var enabled: Bool {
        switch stage {
        case .name: model.validName
        case .paste: model.validResponse && !model.importing
        case .image: model.setup.imageData != nil && (model.rightsAcked || model.setup.companionCreated == true)
        case .voice: !player.loading && model.setup.voice != nil && player.playing == nil && player.fetching == nil && !model.savingVoice
        case .help, .relationship: model.setup.answers[stage.rawValue] != nil
        case .presence: !model.setup.presence.isEmpty
        case .summary: !model.savingPrefs
        default: true
        }
    }
    var body: some View {
        GeometryReader { safe in
            GeometryReader { full in
                let viewport = referenceViewport ? CGSize(width: 390, height: stage == .name ? 519 : 844) : full.size
                let top = referenceViewport ? CGFloat(0) : safe.safeAreaInsets.top - 44
                // SUM: room for Cancel under Continue, same footer as I02's Cancel processing
                let footerY = stage == .name ? viewport.height - 65 : viewport.height - (stage == .preparing || stage == .summary ? 140 : 108)
                let stretch = max(0, viewport.height - 844 - top)
                ZStack(alignment: .topLeading) {
                    Color("Canvas")
                    ScrollView {
                        content(width: viewport.width, top: top, stretch: stretch, contentBottom: footerY - 24)
                            .frame(width: viewport.width, height: max(footerY - 24, (stage == .summary ? 680 : 704) + top + stretch + headingExtra(width: viewport.width)), alignment: .topLeading)
                    }.frame(height: max(1, footerY - 16)).scrollDismissesKeyboard(.interactively)
                        .scrollDisabled(stage == .prompt)
                    if stage != .paste || keyboardTop == .greatestFiniteMagnitude { primary(width: viewport.width).frame(width: viewport.width - 77, height: 50).position(x: (viewport.width - 1) / 2, y: footerY + 25) }
                    if stage == .preparing {
                        Button { model.cancelImport() } label: {
                            let label = texts.first { $0.characters == "Cancel processing" }!
                            ZStack(alignment: .topLeading) {
                                Color.clear
                                DesignText(node: label).frame(width: viewport.width - 77, height: label.h).position(x: (viewport.width - 77) / 2, y: label.h / 2)
                            }.frame(width: viewport.width - 77, height: 36).contentShape(Rectangle())
                        }.buttonStyle(.plain).position(x: (viewport.width - 1) / 2, y: footerY + 81).accessibilityLabel("Cancel processing")
                    }
                    if stage == .summary {
                        // PRD F4: SUM Cancel = back to the first question, answers kept (Figma summary* "Cancel", Pretendard
                        // Medium 16; ink on the light sheet — the Figma layer is white under the button)
                        Button { model.cancelSummary() } label: {
                            let label = texts.first { $0.characters == "Cancel" }!
                            ZStack(alignment: .topLeading) {
                                Color.clear
                                DesignText(node: label, color: UIColor(red: 17 / 255, green: 17 / 255, blue: 17 / 255, alpha: 1))
                                    .frame(width: viewport.width - 77, height: label.h).position(x: (viewport.width - 77) / 2, y: label.h / 2)
                            }.frame(width: viewport.width - 77, height: 44).contentShape(Rectangle())   // 44 pt touch, text where I02's is
                        }.buttonStyle(.plain).disabled(model.savingPrefs).opacity(model.savingPrefs ? 0.4 : 1)
                            .position(x: (viewport.width - 1) / 2, y: footerY + 85).accessibilityLabel("Cancel").accessibilityIdentifier("summaryCancel")
                    }
                }.frame(width: viewport.width, height: viewport.height).clipped()
            }.ignoresSafeArea(.container)
        }
        .ignoresSafeArea(.keyboard, edges: stage == .paste ? .bottom : [])
        .background(OutsideEditorKeyboardDismissal(enabled: stage == .paste))
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { note in
            if stage == .paste, let rect = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect {
                keyboardTop = rect.minY >= UIScreen.main.bounds.maxY ? .greatestFiniteMagnitude : rect.minY
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidHideNotification)) { _ in keyboardTop = .greatestFiniteMagnitude }
        .id(stage)
        .onAppear { if stage == .name && !referenceViewport { nameFocused = true }; if referenceViewport { progress = 0.62 } }
        .onDisappear { player.stop() }
        .task(id: stage) {
            if stage == .voice && !referenceViewport { await loadVoices() }
            guard stage == .preparing && !referenceViewport else { return }
            #if DEBUG
            if ProcessInfo.processInfo.environment["GENITA_REVIEW_STAGE"] == "preparing" { progress = 0.62; return }
            #endif
            if model.serverWired {
                // I03: Spark takes 4–8 s; the bar eases toward 90 % and the answer (AppState.startImport) moves on
                while !Task.isCancelled && model.stage == .preparing {
                    do { try await Task.sleep(for: .milliseconds(120)) } catch { return }
                    if !model.readingDone { progress = min(0.9, progress + (0.92 - progress) * 0.03) }
                }
                return
            }
            for step in 1...20 {
                do { try await Task.sleep(for: .milliseconds(70)) } catch { return }
                progress = Double(step) / 20
            }
            // 100 %: the orb's short pulse, then the next screen
            do { try await Task.sleep(for: .milliseconds(AppState.readingPulseMs)) } catch { return }
            if model.stage == .preparing { model.go(.preferences) }
        }
        // I03: the answer is in: the bar fills to 100 % while the orb pulses
        .onChange(of: model.readingDone) { _, done in if done { withAnimation(.easeOut(duration: 0.2)) { progress = 1 } } }
        .sheet(isPresented: $pickingPhoto) {
            ReferencePhotoPicker(isPresented: $pickingPhoto) { data in if let data { accept(data) } else { imageError = "This image could not be opened." } }
        }
        .sheet(isPresented: $pickingSample) {
            QASamplePhotoSheet { data in pickingSample = false; if let data { accept(data) } else { imageError = "This image could not be opened." } }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.image]) { result in
            do { let url = try result.get(); let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }; accept(try Data(contentsOf: url)) } catch { imageError = "This image could not be opened." }
        }
        .alert("Try another image", isPresented: Binding(get: { imageError != nil }, set: { if !$0 { imageError = nil } })) { Button("OK") { imageError = nil } } message: { Text(imageError ?? "") }
    }
    @ViewBuilder func content(width: CGFloat, top: CGFloat, stretch: CGFloat, contentBottom: CGFloat) -> some View {
        let extra = headingExtra(width: width)
        let bodyTop = top + extra
        ZStack(alignment: .topLeading) {
            if let orb {
                let resource = orb.name.contains("(2)") ? "reference-orb-wide" : "reference-orb-round"
                if stage == .preparing {
                    // I03: the orb moves while the profile is read (Chelsea 11/4); it sits 24 pt under the subtitle
                    // and shrinks on short screens instead of running into the CTA (I03 spacing, Chelsea 11/4)
                    let fit = Self.readingFit(orb: orb, nodes: nodes, limit: contentBottom - bodyTop)
                    ReadingOrb(node: fit.orb, resource: resource, progress: progress, finished: progress >= 1 || model.readingDone).designSlot(fit.orb, width: width, top: bodyTop)
                } else {
                    SoulOrbSlot(node: orb, resource: resource).designSlot(orb, width: width, top: bodyTop)
                }
            }
            ZStack {
                DesignText(node: title, text: stage == .image ? "Bring an image" : nil)
                    .motionBandLineReveal(pitch: title.lineHeight ?? title.font.lineHeight, key: stage)   // motion details card 8
                if stage == .paste && keyboardTop != .greatestFiniteMagnitude {
                    Button {
                        for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) { scene.windows.forEach { $0.endEditing(true) } }
                        keyboardTop = .greatestFiniteMagnitude
                    } label: { Color.clear.contentShape(Rectangle()) }.buttonStyle(.plain).accessibilityLabel("Dismiss keyboard")
                }
            }.frame(width: titleWidth(width), height: title.h + extra)
                .position(x: title.x + titleWidth(width) / 2, y: title.y + top + (title.h + extra) / 2)
            if let back = nodes.first(where: { $0.name == "Group" && $0.y == 67 }) {
                Button { model.back() } label: { Image(resource: "reference-back").resizable().frame(width: 8.8, height: 15.8).frame(width: 44, height: 44) }
                    .buttonStyle(.plain).position(x: back.x + 3.5, y: back.y + top + 7).accessibilityLabel("Back").accessibilityIdentifier("back")
            }
            switch stage {
            case .name:
                nameInput(width: width, top: bodyTop)
                // A03 has no back: a way out to another account, in the page's secondary-link style (QA build 5)
                Button { nameFocused = false; Task { await model.signOutFromName() } } label: {
                    Text("Not you? Sign out").font(TypeStyle.body(14)).underline().foregroundStyle(CallInk.mute).frame(height: 44)
                }.buttonStyle(.plain).frame(width: width - 62, alignment: .trailing).position(x: width / 2, y: 74 + top)
                    .accessibilityIdentifier("nameSignOut")
            case .prompt, .paste, .preferences:
                profileContent(width: width, top: bodyTop, contentBottom: contentBottom)
                    .onChange(of: scenePhase) { _, phase in
                        // I01 → AI app → back: open I02 with the paste button ready (only after the app really left)
                        guard stage == .prompt, openedAI else { return }
                        if phase == .background { leftApp = true }
                        else if phase == .active, leftApp { backFromAI() }
                    }
            case .preparing: processing(width: width, top: bodyTop, shift: orb.map { Self.readingFit(orb: $0, nodes: nodes, limit: contentBottom - bodyTop).shift } ?? 0)
            case .image: imageContent(width: width, top: bodyTop)
            case .voice: voiceContent(width: width, top: bodyTop, stretch: stretch)
            case .summary: summaryContent(width: width, top: bodyTop, stretch: stretch)
            case .depth, .help, .relationship, .boundaries: choices(width: width, top: bodyTop, stretch: stretch)
            case .presence: presence(width: width, top: bodyTop, stretch: stretch)
            case .challenge, .tempo, .initiative: slider(width: width, top: bodyTop, stretch: stretch)
            default: EmptyView()
            }
        }
    }
    func titleWidth(_ width: CGFloat) -> CGFloat { stage == .name ? min(title.w, width - 78) : width - 62 }
    func headingExtra(width: CGFloat) -> CGFloat {
        guard width < 390 else { return 0 }
        let text = title.attributed()
        let reference = text.boundingRect(with: CGSize(width: titleWidth(390) + 0.5, height: 1000), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil).height
        let actual = text.boundingRect(with: CGSize(width: titleWidth(width) + 0.5, height: 1000), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil).height
        return max(0, ceil(actual - reference))
    }
    func primary(width: CGFloat) -> some View {
        let source = texts.first { $0.characters == primaryTitle && $0.y > 400 }!
        let sourceY: CGFloat = stage == .name ? 454 : stage == .preparing ? 704 : 736
        // SUM while the card is written (up to ~8 s): the #111 CTA stays lit with a white spinner (R1 #543 / D105: SUM's CTA
        // is #111 like every onboarding CTA, no longer blue), instead of a dead grey button; Cancel stays under it
        let busy = stage == .summary && model.savingPrefs
        let lit = enabled || busy
        return Button(action: advance) {
            ZStack(alignment: .topLeading) {
                GlassCTA(color: lit ? Color("Ink") : Color(white: 0.8))
                if busy {
                    ProgressView().tint(.white).frame(width: width - 77, height: source.h).position(x: (width - 77) / 2, y: source.y - sourceY + source.h / 2)
                        .accessibilityIdentifier("primaryCTABusy")
                } else {
                    DesignText(node: source, color: enabled ? UIColor(white: 0.99215686, alpha: 1) : UIColor(white: 0.65, alpha: 1))
                        .frame(width: source.w, height: source.h).position(x: (width - 77) / 2 + 1, y: source.y - sourceY + source.h / 2)
                }
            }
        }.buttonStyle(ReferenceButtonStyle()).disabled(!enabled).allowsHitTesting(!busy)
            .accessibilityLabel(primaryTitle).accessibilityIdentifier("primaryCTA")
    }
    func advance() {
        switch stage {
        case .name:
            // the session went away while A03 was up: A02 first, not the whole of onboarding (QA build 5)
            if model.needsSignInFirst { nameFocused = false; model.signedOut(); return }
            model.setup.name = model.setup.name.trimmingCharacters(in: .whitespacesAndNewlines); nameFocused = false; model.saveDisplayName(); model.go(.prompt)
        case .prompt: model.go(.paste)
        case .paste: UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil); model.go(.preparing); model.startImport()
        // "Continue in the background": the import keeps running and fills I04 when it lands
        case .preparing, .preferences: model.go(.image)
        case .image: model.checkImage()
        case .voice: player.stop(); model.saveVoiceAndContinue()
        case .summary: model.saveSetupAndPrepare()
        default: model.nextPreference()
        }
    }
    func nameInput(width: CGFloat, top: CGFloat) -> some View {
        let box = nodes.first { $0.type == "box" && $0.y == 287 }!
        return TextField("Name", text: $model.setup.name).font(TypeStyle.body(20, .medium)).multilineTextAlignment(.center).textContentType(.givenName).submitLabel(.next).focused($nameFocused)
            .frame(height: 56).background(Color(white: 0.9333), in: RoundedRectangle(cornerRadius: 12)).designSlot(box, width: width, top: top).accessibilityIdentifier("nameInput").onSubmit { if model.validName { advance() } }
    }
    @ViewBuilder func profileContent(width: CGFloat, top: CGFloat, contentBottom: CGFloat) -> some View {
        let card: DesignNode = {
            var node = nodes.first { $0.name == (stage == .prompt ? "Your prompt" : stage == .paste ? "Your AI’s response" : "Your preferences") && $0.type != "text" }!
            // I01: room under the card for Open ChatGPT / Open Claude and the N1–N3 link (PRD v12 B-defaults, D33)
            if stage == .prompt { node.h = min(node.h, max(100, contentBottom - 96 - node.y - top)) }
            return node
        }()
        DesignShape(node: card).designSlot(card, width: width, top: top)
        ForEach(texts.filter { $0.id != title.id && $0.y < 700 && ($0.y < 319 || $0.y >= 617) }) { n in
            DesignText(node: n).designSlot(n, width: width, top: top)
        }
        let body = texts.first { $0.y == 319 }!
        if stage == .prompt {
            // ui-deferred: the prompt fades at both scroll edges (20 pt under the header, 32 pt at the bottom), never a hard cut.
            // The reader starts 20 pt above the first line (inset, so the text sits where it did), and the card's 44 pt
            // header is opaque over it, so a scrolled line never shows through next to "Your prompt" / the copy icon.
            let fadeTop = ScrollEdgeFade.top
            let readerTop = body.y - fadeTop
            let readerHeight = max(1, card.y + card.h - readerTop - 20)
            ReferenceEditor(text: .constant(AppState.prompt), node: body, editable: false, placeholder: "", identifier: "promptReader", topInset: fadeTop, bottomInset: ScrollEdgeFade.height)
                .frame(width: body.w + width - 390, height: readerHeight)
                .scrollEdgeFade(top: fadeTop)
                .position(x: body.x + (body.w + width - 390) / 2, y: readerTop + top + readerHeight / 2)
            let header = ScrollEdgeFade.header
            UnevenRoundedRectangle(topLeadingRadius: (card.radius ?? 16) - 1, topTrailingRadius: (card.radius ?? 16) - 1).fill(card.fill?.color ?? .white)
                .frame(width: card.w + width - 390 - 2, height: header - 1)
                .position(x: card.x + (card.w + width - 390) / 2, y: card.y + top + 1 + (header - 1) / 2)
                .allowsHitTesting(false).accessibilityHidden(true)
            if let label = texts.first(where: { $0.characters == "Your prompt" }) { DesignText(node: label).designSlot(label, width: width, top: top).accessibilityHidden(true) }
            Button { UIPasteboard.general.string = AppState.prompt; copied = true } label: {
                Group { if copied { Image(systemName: "checkmark").foregroundStyle(Color("Ink")) } else { Image(resource: "copy").resizable().frame(width: 19.4526, height: 20.4) } }.frame(width: 44, height: 44)
            }.buttonStyle(.plain).position(x: width - 65.8737, y: 296.4 + top).accessibilityLabel(copied ? "Prompt copied" : "Copy prompt").accessibilityIdentifier("copyPrompt")
            let cardBottom = card.y + card.h + top
            HStack(spacing: 8) {
                appButton("Open ChatGPT", app: "chatgpt://", web: "https://chatgpt.com/")
                appButton("Open Claude", app: "claude://", web: "https://claude.ai/new")
            }.frame(width: width - 48).position(x: width / 2, y: cardBottom + 32)
            if copiedToast {
                Text("Prompt copied").font(TypeStyle.body(13, .medium)).foregroundStyle(CallInk.onInk).padding(.horizontal, 14).frame(height: 30)
                    .background(CallInk.ink.opacity(0.84), in: Capsule()).transition(.opacity)
                    .position(x: width / 2, y: cardBottom + 32 - 38).accessibilityIdentifier("promptCopiedToast")
            }
            Button { model.go(.skipTopics) } label: {
                Text("I don’t use an AI assistant").font(TypeStyle.body(14)).underline().foregroundStyle(CallInk.mute).frame(height: 44)
            }.buttonStyle(.plain).position(x: width / 2, y: cardBottom + 78).accessibilityIdentifier("skipImport")
        } else {
            let editorHeight = max(1, min(card.h - 76, keyboardTop - body.y - top - 8))
            ReferenceEditor(text: stage == .preferences ? .constant(model.styleText) : $model.setup.response, node: body, editable: stage == .paste, placeholder: "Paste the profile your AI wrote for you...")
                .frame(width: body.w + width - 390, height: editorHeight).position(x: body.x + (body.w + width - 390) / 2, y: body.y + top + editorHeight / 2).accessibilityIdentifier(stage == .paste ? "responseInput" : "profileResult")
            if stage == .paste {
                // I02 one tap: paste the reply straight from the clipboard (system paste button, no permission prompt)
                PasteButton(payloadType: String.self) { strings in
                    if let text = strings.first { Task { @MainActor in model.setup.response = text; model.importError = nil; pasteHighlight = false } }
                }.buttonBorderShape(.capsule).labelStyle(.titleAndIcon).tint(CallInk.ink).controlSize(.small)
                    .overlay { if pasteHighlight { Capsule().strokeBorder(Color(red: 0, green: 0.635, blue: 1), lineWidth: 2).padding(-4).allowsHitTesting(false) } }
                    .accessibilityFocused($pasteFocused)
                    .position(x: width - 88, y: card.y + top + 22).accessibilityIdentifier("pasteReply")
                    .onAppear {
                        // back from ChatGPT / Claude: the paste button is the one thing to do (no permission prompt, system paste control)
                        guard model.pasteFocusRequested else { return }
                        model.pasteFocusRequested = false; pasteHighlight = true
                        Task { @MainActor in try? await Task.sleep(for: .milliseconds(300)); pasteFocused = true }
                    }
                if let e = model.importError {
                    // I02-E: one line, the text stays
                    Text(e).font(TypeStyle.body(13)).foregroundStyle(Color(red: 0.85, green: 0.2, blue: 0.2))
                        .frame(width: width - 62, alignment: .leading).position(x: 31 + (width - 62) / 2, y: card.y + card.h + top + 18)
                        .accessibilityIdentifier("importError")
                }
            }
        }
    }
    /// Back from the AI app: I02 with the paste button ready.
    func backFromAI() { openedAI = false; leftApp = false; copiedToast = false; model.pasteFocusRequested = true; model.go(.paste) }
    /// I01: opens the AI app, or its website when the app isn't installed.
    func appButton(_ title: String, app: String, web: String) -> some View {
        Button {
            guard let a = URL(string: app), let w = URL(string: web) else { return }
            // one tap: copy the prompt, say so, open the AI app (or its site); coming back opens I02
            UIPasteboard.general.string = AppState.prompt
            copied = true; openedAI = true; leftApp = false
            model.setup.importAI = title == "Open ChatGPT" ? "ChatGPT" : "Claude"
            withAnimation(.easeOut(duration: 0.2)) { copiedToast = true }
            #if DEBUG
            // UI tests (`--stub-external-apps`): nothing opens (no Safari round trip on a loaded CI runner) and the
            // toast stays until the test leaves and comes back (Home → activate), so neither depends on timing; the
            // return goes through the real scene-phase path below
            if ProcessInfo.processInfo.arguments.contains("--stub-external-apps") { return }
            #endif
            Task { @MainActor in try? await Task.sleep(for: .seconds(2)); withAnimation(.easeOut(duration: 0.2)) { copiedToast = false } }
            UIApplication.shared.open(a) { ok in if !ok { UIApplication.shared.open(w) } }
        } label: {
            Text(title).font(TypeStyle.body(14, .medium)).foregroundStyle(CallInk.ink).frame(maxWidth: .infinity).frame(height: 40)
                .background(.white, in: RoundedRectangle(cornerRadius: 12)).overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(white: 0.89), lineWidth: 1))
        }.buttonStyle(.plain).accessibilityIdentifier(title == "Open ChatGPT" ? "openChatGPT" : "openClaude")
    }
    @ViewBuilder func processing(width: CGFloat, top: CGFloat, shift: CGFloat = 0) -> some View {
        // the reading block (title, line, bar, %) follows the orb down by `shift`; the heading stays
        ForEach(texts.filter { $0.id != title.id && $0.y < 650 }) { n in
            DesignText(node: n, text: n.characters == "62%" ? "\(Int(progress * 100))%" : nil).designSlot(n, width: width, top: top + (n.y >= Self.readingBlockTop ? shift : 0))
        }
        let track = nodes.first { $0.name == "Rectangle 305" }!
        let fill = nodes.first { $0.name == "Rectangle 306" }!
        let trackWidth = width - 117
        DesignShape(node: track).frame(width: trackWidth, height: track.h).position(x: (width + 1) / 2, y: track.y + top + shift + track.h / 2)
        let fillWidth = referenceViewport ? fill.w : trackWidth * CGFloat(progress)
        DesignShape(node: fill).frame(width: fillWidth, height: fill.h).position(x: 59 + fillWidth / 2, y: fill.y + top + shift + fill.h / 2)
    }

    /// I03 spacing (Chelsea 11/4, deviates from the Figma soul-orb node): the orb's frame starts 24 pt under the subtitle
    /// ("Using the profile you chose to share."), the reading block keeps its Figma distance below the orb, and when
    /// the block would pass `limit` (the content bottom above the CTA, in body coordinates) the orb shrinks evenly
    /// about its centre line instead of overlapping. Returns the placed orb node and how far the reading block moves.
    static let orbGapBelowSubtitle: CGFloat = 24
    static let readingBlockTop: CGFloat = 400
    nonisolated(unsafe) static var orbSpacing = true
    static func readingFit(orb: DesignNode, nodes: [DesignNode], limit: CGFloat) -> (orb: DesignNode, shift: CGFloat, scale: CGFloat) {
        guard orbSpacing,
              let subtitle = nodes.first(where: { $0.type == "text" && $0.y > 150 && $0.y < orb.y + 40 && $0.fontFamily != "KMU80 TTF" }),
              let reading = nodes.filter({ $0.type == "text" && $0.y >= readingBlockTop && $0.y < 650 }).min(by: { $0.y < $1.y }),
              let blockBottom = nodes.filter({ $0.type == "text" && $0.y >= readingBlockTop && $0.y < 650 }).map({ $0.y + $0.h }).max()
        else { return (orb, 0, 1) }
        let orbTop = subtitle.y + subtitle.h + orbGapBelowSubtitle
        let toReading = reading.y - orb.y            // Figma: the reading title sits this far below the orb's top
        let block = blockBottom - reading.y           // title … % label
        let scale = max(0.05, min(1, (limit - orbTop - block) / toReading))
        var placed = orb
        placed.w = orb.w * scale; placed.h = orb.h * scale
        placed.x = orb.x + (orb.w - placed.w) / 2
        placed.y = orbTop
        return (placed, orbTop + toReading * scale - reading.y, scale)
    }
    func accept(_ data: Data) {
        // B7: one companion, the face can't change once it's made
        // … nor while it is being made (AU-37: a photo picked then left the call face on the first one)
        guard model.setup.companionCreated != true, !model.creatingCompanion else { imageError = "Their face is already set."; return }
        guard let jpeg = AppState.uploadJPEG(data) else { imageError = "Please select a supported image."; return }
        // a new photo needs a new check (V03); the old result and suggestion don't apply
        model.setup.imageData = jpeg; model.setup.imageId = nil; model.imageCheck = nil; model.rightsAcked = false
        if model.setup.companionCreated != true { model.setup.companionName = nil }
    }
    @ViewBuilder func imageContent(width: CGFloat, top: CGFloat) -> some View {
        ForEach(texts.filter { $0.id != title.id && $0.y < 200 }) { n in DesignText(node: n).designSlot(n, width: width, top: top) }
        Button { pickingPhoto = true } label: {
            ZStack {
                RoundedRectangle(cornerRadius: 12).fill(.white).overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(white: 0.89), lineWidth: 1))
                if let data = model.setup.imageData, let image = UIImage(data: data) {
                    // the whole photo, never cropped; the bands beside a portrait photo are the photo itself, soft
                    // (UI sweep 11/3: a portrait sat in wide white bands inside the white card)
                    ZStack {
                        Image(uiImage: image).resizable().scaledToFill().frame(width: width - 48, height: 289).clipped().blur(radius: 24).opacity(0.55)
                        Image(uiImage: image).resizable().scaledToFit()
                    }.frame(width: width - 48, height: 289).clipShape(RoundedRectangle(cornerRadius: 12))
                } else {
                    let icon = nodes.first { $0.name == "Subtract" }!
                    let label = texts.first { $0.characters == "Upload Image" }!
                    ZStack(alignment: .topLeading) {
                        Image(resource: "reference-upload").resizable().frame(width: icon.w, height: icon.h).position(x: (width - 48) / 2, y: icon.y - 226 + icon.h / 2)
                        DesignText(node: label).frame(width: label.w, height: label.h).position(x: (width - 48) / 2, y: label.y - 226 + label.h / 2)
                    }
                }
            }
        }.buttonStyle(.plain).frame(width: width - 48, height: 289).position(x: width / 2, y: 370.5 + top).accessibilityLabel(model.setup.imageData == nil ? "Upload Image" : "Change image").accessibilityIdentifier("uploadImage").contextMenu { Button("Choose from Files") { pickingPhoto = false; importing = true } }
        if model.setup.imageData != nil {
            Button { model.setup.imageData = nil; model.rightsAcked = false } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.black, .white).font(.system(size: 24)) }
                .position(x: width - 48, y: 250 + top).accessibilityLabel("Remove image").accessibilityIdentifier("removeImage")
        }
        rightsRow(width: width, top: top)
        // device QA only (server-listed accounts): bundled sample pictures, so QA never opens a real photo library.
        // Same accept() → V03 check → polish path as a library pick. Never in the reference / screenshot viewport.
        if QASamplePhotos.visible(for: model) && !referenceViewport {
            Button { pickingSample = true } label: {
                Text("Use a test photo").font(TypeStyle.body(14, .medium)).foregroundStyle(CallInk.ink.opacity(0.55)).underline()
                    .frame(width: width - 48, height: 36).contentShape(Rectangle())
            }.buttonStyle(.plain).position(x: width / 2, y: 590 + top)
                .accessibilityLabel("Use a test photo").accessibilityIdentifier(QASamplePhotos.entryID)
        }
        // Alternate import uses the same upload surface; no extra product button is invented.
        Color.clear.frame(width: 1, height: 1).accessibilityHidden(true)
    }
    /// V01 rights line (D26): a check mark and one line under the picture; "Use this image" stays off until it is on.
    @ViewBuilder func rightsRow(width: CGFloat, top: CGFloat) -> some View {
        Button { model.rightsAcked.toggle() } label: {
            HStack(spacing: 12) {
                ZStack {
                    if model.rightsAcked { SelectionMark() } else { Circle().strokeBorder(Color(white: 0.8902), lineWidth: 2) }
                }.frame(width: 22, height: 22)
                Text("I have the right to use this image").font(TypeStyle.body(15)).foregroundStyle(CallInk.ink)
                Spacer(minLength: 0)
            }.frame(width: width - 48, height: 44, alignment: .leading).contentShape(Rectangle())
        }.buttonStyle(.plain).position(x: width / 2, y: 539 + top)
            .accessibilityElement(children: .ignore).accessibilityLabel("I have the right to use this image")
            .accessibilityValue(model.rightsAcked ? "On" : "Off").accessibilityAddTraits(.isButton).accessibilityIdentifier("rightsAck")
    }
    var cardFrames: [DesignNode] { nodes.filter { $0.type == "frame" && $0.x == 24 && $0.w == 342 && $0.h == 68 }.sorted { $0.y < $1.y } }
    func cardTexts(_ card: DesignNode) -> [DesignNode] { texts.filter { $0.y >= card.y && $0.y < card.y + card.h }.sorted { $0.y < $1.y } }
    @ViewBuilder func card(_ frame: DesignNode, selected: Bool, width: CGFloat, action: @escaping () -> Void) -> some View {
        let labels = cardTexts(frame)
        Button(action: action) {
            ZStack(alignment: .topLeading) {
                RoundedRectangle(cornerRadius: 12).fill(selected ? Color(red: 0.8431, green: 0.9451, blue: 1) : .white)
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(selected ? Color.clear : Color(white: 0.8902), lineWidth: 1))
                ForEach(Array(labels.enumerated()), id: \.element.id) { i, n in
                    DesignText(node: n, color: selected ? UIColor(red: i == 0 ? 0 : 0.3294, green: i == 0 ? 0.6353 : 0.7569, blue: 1, alpha: 1) : i == 0 ? UIColor(white: 0.067, alpha: 1) : UIColor(white: 0.7176, alpha: 1))
                        .frame(width: n.w, height: n.h).position(x: n.x - frame.x + n.w / 2, y: n.y - frame.y + n.h / 2)
                }
                if selected { SelectionMark().frame(width: 26, height: 26).position(x: width - 36, y: 34) }
            }
        }.buttonStyle(.plain).accessibilityLabel(labels.map { $0.characters ?? "" }.joined(separator: ", ")).accessibilityAddTraits(selected ? .isSelected : [])
    }
    @ViewBuilder func choices(width: CGFloat, top: CGFloat, stretch: CGFloat) -> some View {
        ForEach(Array(cardFrames.enumerated()), id: \.element.id) { i, n in
            let value = cardTexts(n).first?.characters ?? ""
            let selected = stage == .depth ? model.setup.depth == SetupDepth.allCases[i] : stage == .boundaries ? model.setup.boundaries.contains(value) : model.setup.answers[stage.rawValue] == value
            card(n, selected: selected, width: width - 48) {
                if stage == .depth { model.setup.depth = SetupDepth.allCases[i] }
                else if stage == .boundaries { model.toggleBoundary(value) }
                else { model.answer(stage.rawValue, value) }
            }.designSlot(n, width: width, top: top, stretch: stretch)
        }
    }
    /// V04 (Figma F2 "voice model" frames): four server voices, a black ring on the picked one, a black round
    /// play button that turns into pause while the clip plays. Greyed with "Voice preview is waking up" when
    /// the voice service is down; the first voice (the recommended default) stays picked so Continue works.
    @ViewBuilder func voiceContent(width: CGFloat, top: CGFloat, stretch: CGFloat) -> some View {
        let waking = !player.loading && !player.available
        HStack(spacing: 8) {
            Text(waking ? "Voice preview is waking up" : "Tap play to hear each one.")
                .font(.custom("PretendardVariable-Regular", fixedSize: 14)).foregroundStyle(Color(white: 0.45))
                .accessibilityIdentifier(waking ? "voiceWaking" : "voiceHint")
            if waking { ProgressView().controlSize(.small).tint(Color(white: 0.45)).accessibilityIdentifier("voiceWakingSpinner") }
        }.frame(width: width - 62, alignment: .leading).position(x: 31 + (width - 62) / 2, y: 187 + top + 9)
        ForEach(Array(cardFrames.enumerated()), id: \.element.id) { i, n in
            if i < voiceList.count {
                voiceCard(voiceList[i], index: i, waking: waking || (player.loading && !referenceViewport) || model.savingVoice).designSlot(n, width: width, top: top, stretch: stretch)
            }
        }
    }
    /// until the server answers (and in the reference snapshot) the curated four per look are drawn greyed
    var voiceList: [OnboardingClient.CompanionVoice] { player.voices.isEmpty ? VoicePlayer.fallback(kind: model.setup.imageType) : player.voices }
    func voiceCard(_ v: OnboardingClient.CompanionVoice, index i: Int, waking: Bool) -> some View {
        let playing = player.playing == v.id
        let picked = model.setup.voice == i
        let detail = playing ? "Playing · \(v.blurb)" : picked ? "Selected · \(v.blurb)" : v.blurb
        let detailColor = playing ? Color(red: 0, green: 99.0 / 255, blue: 159.0 / 255) : picked ? Color(white: 115.0 / 255) : Color(white: 183.0 / 255)
        return ZStack {
            RoundedRectangle(cornerRadius: 12).fill(.white)
                // Figma voice.json: 1 pt #E3E3E3 edge (white card on #FDFDFD had no visible edge on device, design review 11/4)
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(picked || playing ? Color("Ink") : Color(red: 0xE3 / 255, green: 0xE3 / 255, blue: 0xE3 / 255), lineWidth: picked || playing ? 1.5 : 1))
            Button { player.stop(); selectVoice(i) } label: { Color.clear.contentShape(Rectangle()) }.disabled(waking)
                .accessibilityLabel("\(v.name), \(detail)").accessibilityAddTraits(picked ? .isSelected : []).accessibilityIdentifier("voice\(i)")
            VStack(alignment: .leading, spacing: 4) {
                Text(v.name).font(.custom("PretendardVariable-SemiBold", fixedSize: 18)).foregroundStyle(Color("Ink"))
                Text(detail).font(.custom("PretendardVariable-Medium", fixedSize: 12)).foregroundStyle(detailColor)
            }.padding(.leading, 21).padding(.top, 13).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).allowsHitTesting(false)
            Button { selectVoice(i); player.preview(v, client: model.onboarding) } label: {
                ZStack {
                    Circle().fill(Color("Ink")).frame(width: 32, height: 32)
                    if playing { HStack(spacing: 4) { RoundedRectangle(cornerRadius: 1).frame(width: 3, height: 11); RoundedRectangle(cornerRadius: 1).frame(width: 3, height: 11) }.foregroundStyle(.white) }
                    else if player.fetching == v.id { ProgressView().controlSize(.small).tint(.white) }
                    else { Image(systemName: "play.fill").font(.system(size: 11)).foregroundStyle(.white).offset(x: 1) }
                }.frame(width: 44, height: 44)
            }.disabled(waking).accessibilityLabel(playing ? "Stop \(v.name)" : "Play \(v.name)").accessibilityIdentifier("play\(i)")
                .frame(maxWidth: .infinity, alignment: .trailing).padding(.trailing, 14)
        }.opacity(waking ? 0.5 : 1).buttonStyle(.plain)
    }
    func selectVoice(_ i: Int) {
        guard i < player.voices.count else { return }   // greyed placeholders are never picked
        model.setup.voice = i
        model.setup.voiceId = player.voices[i].id
        model.setup.voiceName = player.voices[i].name
    }
    /// Opens V04: the server's list, then the earlier pick (or the default while the voice service wakes).
    func loadVoices() async {
        await player.load(client: model.onboarding, imageId: model.setup.imageId, kind: model.setup.imageType)
        // 11/4: no earlier pick → the server's top match for the face (the list comes ordered by the photo's voice_fit)
        // is pre-selected, so Continue saves the voice the user sees ticked; they can still change it
        // the pre-selection is ours until the user taps a card: a list that comes back ordered for the face moves it
        var autoPick: String?
        if let id = model.setup.voiceId, let i = player.voices.firstIndex(where: { $0.id == id }) { selectVoice(i) }
        else { selectVoice(0); autoPick = model.setup.voiceId }
        // voice service cold: ask again every 4 s for up to 60 s, then the normal list replaces the greyed one
        var waited = 0
        while !player.available && waited < 60 && !Task.isCancelled {
            do { try await Task.sleep(for: .seconds(4)) } catch { return }
            waited += 4
            await player.refresh(client: model.onboarding, imageId: model.setup.imageId)
            // Continue already took the pick (saving or gone): the list must not move it any more (Codex re-review P2)
            guard !Task.isCancelled, !model.savingVoice, model.stage == .voice else { return }
            // the tick follows the voice id, never the row (Codex review P2: a refreshed list put Leo in row 0 while Tara was saved)
            if player.available, autoPick != nil, model.setup.voiceId == autoPick { selectVoice(0); autoPick = model.setup.voiceId }
            else if let id = model.setup.voiceId, let i = player.voices.firstIndex(where: { $0.id == id }) { model.setup.voice = i }
        }
    }
    @ViewBuilder func presence(width: CGFloat, top: CGFloat, stretch: CGFloat) -> some View {
        // The reference frame has "Calm" twice; the fourth chip is "Warm" (PRD v12 F4, B10)
        let labels: [DesignNode] = {
            var l = texts.filter { $0.y >= 579 && $0.y < 720 }.sorted { $0.y == $1.y ? $0.x < $1.x : $0.y < $1.y }
            if let i = l.indices.last(where: { l[$0].characters == "Calm" }), l.filter({ $0.characters == "Calm" }).count > 1 { l[i].characters = "Warm" }
            return l
        }()
        ForEach(labels) { label in
            let value = label.characters ?? ""
            let key = "\(label.x)-\(label.y)"
            let inferred = Set(model.setup.presence.compactMap { word in labels.first(where: { $0.characters == word }).map { "\($0.x)-\($0.y)" } })
            let selectedIDs = model.setup.presenceCardIDs ?? inferred
            let selected = selectedIDs.contains(key)
            let cardWidth = (width - 90) / 2
            let left = label.x < 200 ? CGFloat(38) : 51 + cardWidth
            Button {
                let updated = PresenceChips.toggle(selectedIDs, key)
                guard updated != selectedIDs else { return }
                model.setup.presenceCardIDs = updated
                model.setup.presence = Set(labels.filter { updated.contains("\($0.x)-\($0.y)") }.compactMap(\.characters))
            } label: {
                ZStack {
                    RoundedRectangle(cornerRadius: 12).fill(selected ? Color("Selection") : .white).overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(selected ? Color.clear : Color(white: 0.89)))
                    DesignText(node: label, color: selected ? UIColor(red: 0, green: 0.6353, blue: 1, alpha: 1) : UIColor(white: 0.067, alpha: 1)).frame(width: 100, height: label.h)
                    if selected { SelectionMark().frame(width: 16, height: 16).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing).padding(6) }
                }
            }.buttonStyle(.plain).frame(width: cardWidth, height: 65).position(x: left + cardWidth / 2, y: label.y - 22 + 32.5 + top + stretch)
                .accessibilityLabel(value).accessibilityAddTraits(selected ? .isSelected : [])
        }
    }
    @ViewBuilder func slider(width: CGFloat, top: CGFloat, stretch: CGFloat) -> some View {
        let endpoint = texts.filter { $0.y == 562 }
        ForEach(endpoint) { n in DesignText(node: n).designSlot(n, width: width, top: top, stretch: stretch) }
        let bubble = nodes.first { $0.name == "Rectangle 297" }!
        DesignShape(node: bubble).designSlot(bubble, width: width, top: top, stretch: stretch)
        let example = texts.first { $0.y == 478 }!
        DesignText(node: example, text: referenceViewport ? nil : preview).designSlot(example, width: width, top: top, stretch: stretch)
        Image(resource: "reference-avatar").resizable().frame(width: 50, height: 89).offset(x: -4, y: -16).frame(width: 45, height: 45, alignment: .topLeading).clipped().clipShape(Circle()).position(x: 67.5, y: 487.5 + top + stretch)
        ReferenceSlider(value: Binding(get: { Double(model.setup.answers[stage.rawValue] ?? "2") ?? 2 }, set: { model.answer(stage.rawValue, String(Int($0))) }))
            .frame(width: width - 62, height: 24).position(x: (width + 8) / 2, y: 599 + top + stretch).accessibilityLabel(endpoint.map { $0.characters ?? "" }.joined(separator: " to "))
    }
    var preview: String {
        let index = min(4, max(0, Int(model.setup.answers[stage.rawValue] ?? "2") ?? 2))
        let samples = stage == .challenge ? ["Let’s gently explore what works for you.", "Would you like to try another approach?", "Let’s see what works and what we can rethink.", "Tell me when my plan doesn’t make sense.", "Be direct. Challenge my assumptions."] : stage == .tempo ? ["Take your time. Let’s think this through.", "Let’s pause and look at what matters most.", "A little reflection, then a clear next step.", "Give me the main point and the next step.", "Keep it quick. Just the answer and next step."] : ["Wait for me to ask before reaching out.", "Check in only when I invite you to.", "A gentle check-in now and then is welcome.", "Check in when a deadline is at risk.", "Anticipate what I need. Suggest a next step."]
        return samples[index]
    }
    @ViewBuilder func summaryContent(width: CGFloat, top: CGFloat, stretch: CGFloat) -> some View {
        UnevenRoundedRectangle(topLeadingRadius: 30, topTrailingRadius: 30).fill(Color(white: 0.996)).shadow(color: .black.opacity(0.04), radius: 25.9)
            .frame(width: width, height: 551 + stretch).position(x: width / 2, y: 291 + top + (551 + stretch) / 2)
        RoundedRectangle(cornerRadius: 3.5).fill(Color(white: 0.859)).frame(width: 47, height: 5).position(x: width / 2, y: 305.5 + top)
        ForEach(summaryRows(width: width), id: \.node.id) { row in
            DesignText(node: row.node, text: row.text).designSlot(row.node, width: width, top: top)
                .accessibilityIdentifier(row.key)
        }
    }
    /// SUM rows at the Figma spacing (label → value 8 pt, value → next label 26 pt) for the real answers: Figma
    /// reserves 2 lines for Why and Never, so a 1-line answer used to leave a 21 pt hole (and a long one overlapped).
    func summaryRows(width: CGFloat) -> [(node: DesignNode, text: String?, key: String)] {
        var shift: CGFloat = 0
        return texts.filter { $0.y >= 345 && $0.y < 700 }.sorted { $0.y < $1.y }.map { n in
            var placed = n
            placed.y += shift
            let key = n.characters ?? ""
            guard n.fontSize == 18, !referenceViewport else { return (placed, nil, key) }
            // the last two words stay together: never a one-word last line ("… without / approval"); DesignLabel draws
            // its own lines, so the paragraph's push-out strategy alone didn't do it (CI onb-SUM after #525 r1)
            var value = summaryValue(y: n.y)
            if let r = value.range(of: " ", options: .backwards), value.split(separator: " ").count > 2 { value.replaceSubrange(r, with: "\u{00A0}") }
            let margin = 390 - n.x - n.w
            let w = n.w >= 240 && margin >= 20 && n.x >= 20 ? max(1, width - n.x - margin) : n.w   // DesignPlacement's width
            let used = ceil(n.attributed(value).boundingRect(with: CGSize(width: w + 0.5, height: 1000), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil).height)
            placed.h = used
            shift += used - n.h
            return (placed, value, key)
        }
    }
    func summaryValue(y: CGFloat) -> String {
        if y < 438 { return model.setup.answers["help"] ?? "Think with me" }
        if y < 510 { return model.setup.presence.sorted().joined(separator: ", ") }
        if y < 582 { return model.setup.answers["initiative"].map { ["Only when asked", "By invitation", "Occasional check-ins", "When a deadline is at risk", "Anticipate"][min(4, max(0, Int($0) ?? 0))] } ?? "Only when asked" }
        return model.setup.boundaries.isEmpty ? "No messages or actions without approval" : model.setup.boundaries.sorted().joined(separator: ", ")
    }
}
private struct SelectionMark: View {
    var body: some View { GeometryReader { g in ZStack { Image(resource: "reference-selected").resizable(); Image(resource: "reference-check").resizable().frame(width: g.size.width < 20 ? 10 : 14, height: g.size.width < 20 ? 7 : 10).offset(y: g.size.width < 20 ? 0.5 : 1) } } }
}
struct ReferenceEditor: UIViewRepresentable {
    @Binding var text: String
    var node: DesignNode
    var editable: Bool
    var placeholder: String
    var identifier: String? = nil
    /// Room above the first / under the last line (a read-only card whose edges fade, see `scrollEdgeFade`).
    var topInset: CGFloat = 0
    var bottomInset: CGFloat = 0
    func makeUIView(context: Context) -> UITextView {
        let view = UITextView(); view.backgroundColor = .clear; view.delegate = context.coordinator
        view.textContainerInset = UIEdgeInsets(top: topInset, left: 0, bottom: bottomInset, right: 0); view.textContainer.lineFragmentPadding = 0
        view.isEditable = editable; view.isSelectable = true
        view.typingAttributes = node.attributed(" ").attributes(at: 0, effectiveRange: nil)
        let hint = UILabel(); hint.tag = 19; hint.numberOfLines = 0
        hint.attributedText = node.attributed(placeholder, color: UIColor(white: 0.55, alpha: 1)); hint.isUserInteractionEnabled = false
        hint.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(hint)
        NSLayoutConstraint.activate([hint.leadingAnchor.constraint(equalTo: view.leadingAnchor), hint.topAnchor.constraint(equalTo: view.topAnchor), hint.widthAnchor.constraint(equalTo: view.widthAnchor)])
        view.keyboardDismissMode = .onDrag
        view.alwaysBounceVertical = true
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.parent = self
        view.viewWithTag(19)?.isHidden = !text.isEmpty || !editable
        if view.text != text { view.attributedText = node.attributed(text) }
        view.accessibilityIdentifier = identifier ?? (editable ? "responseInput" : "profileResult")
    }
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ReferenceEditor; weak var view: UITextView?
        init(_ parent: ReferenceEditor) { self.parent = parent }
        func scrollViewWillBeginDragging(_ scrollView: UIScrollView) { if parent.editable { scrollView.endEditing(true) } }
        func textViewDidChange(_ textView: UITextView) { parent.text = textView.text; textView.viewWithTag(19)?.isHidden = !textView.text.isEmpty }
    }
}
private struct OutsideEditorKeyboardDismissal: UIViewRepresentable {
    var enabled: Bool
    func makeUIView(context: Context) -> DismissalView { DismissalView() }
    func updateUIView(_ view: DismissalView, context: Context) { view.tap.isEnabled = enabled }
    static func dismantleUIView(_ view: DismissalView, coordinator: ()) { view.detach() }

    final class DismissalView: UIView, UIGestureRecognizerDelegate {
        weak var attachedWindow: UIWindow?
        lazy var tap: UITapGestureRecognizer = {
            let gesture = UITapGestureRecognizer(target: self, action: #selector(dismissKeyboard))
            gesture.cancelsTouchesInView = false
            gesture.delegate = self
            return gesture
        }()
        override func didMoveToWindow() {
            super.didMoveToWindow()
            detach()
            attachedWindow = window
            window?.addGestureRecognizer(tap)
        }
        func detach() { attachedWindow?.removeGestureRecognizer(tap); attachedWindow = nil }
        @objc private func dismissKeyboard() { attachedWindow?.endEditing(true) }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            var view = touch.view
            while let current = view {
                if current is UITextView || current is UITextField { return false }
                view = current.superview
            }
            return true
        }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool { true }
    }
}
private final class ReferenceNativeSlider: UISlider {
    let stops = (0..<5).map { _ in UIImageView() }
    override init(frame: CGRect) {
        super.init(frame: frame)
        let url = Bundle.main.url(forResource: "reference-slider-dot", withExtension: "png")!
        let image = UIImage(contentsOfFile: url.path)!
        for stop in stops { stop.image = image; stop.isUserInteractionEnabled = false; addSubview(stop) }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func trackRect(forBounds bounds: CGRect) -> CGRect { CGRect(x: 12, y: bounds.midY - 0.5, width: bounds.width - 24, height: 1) }
    override func thumbRect(forBounds bounds: CGRect, trackRect rect: CGRect, value: Float) -> CGRect {
        CGRect(x: CGFloat(value / 4) * (bounds.width - 24), y: bounds.midY - 12, width: 24, height: 24)
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        let selected = Int(value.rounded())
        let gap = (bounds.width - 88) / 4
        for (i, stop) in stops.enumerated() {
            stop.isHidden = i == selected
            stop.frame = CGRect(x: CGFloat(i) * (16 + gap) + (selected < i ? 8 : 0), y: bounds.midY - 8, width: 16, height: 16)
            bringSubviewToFront(stop)
        }
    }
}
struct ReferenceSlider: UIViewRepresentable {
    @Binding var value: Double
    func makeUIView(context: Context) -> UISlider {
        let slider = ReferenceNativeSlider(); slider.minimumValue = 0; slider.maximumValue = 4
        slider.minimumTrackTintColor = UIColor(white: 0.89, alpha: 1); slider.maximumTrackTintColor = UIColor(white: 0.89, alpha: 1)
        slider.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .valueChanged)
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 24))
        let halo = UIImage(contentsOfFile: Bundle.main.url(forResource: "reference-slider-halo", withExtension: "png")!.path)!
        let fill = UIImage(contentsOfFile: Bundle.main.url(forResource: "reference-slider-selected", withExtension: "png")!.path)!
        slider.setThumbImage(renderer.image { _ in halo.draw(in: CGRect(x: 0, y: 0, width: 24, height: 24)); fill.draw(in: CGRect(x: 4, y: 4, width: 16, height: 16)) }, for: .normal)
        return slider
    }
    func updateUIView(_ view: UISlider, context: Context) { context.coordinator.parent = self; view.value = Float(value); view.setNeedsLayout() }
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    final class Coordinator: NSObject { var parent: ReferenceSlider; init(_ parent: ReferenceSlider) { self.parent = parent }; @objc func changed(_ slider: UISlider) { parent.value = Double(slider.value.rounded()); slider.value = Float(parent.value); slider.setNeedsLayout() } }
}

private struct ReferenceButtonStyle: ButtonStyle { func makeBody(configuration: Configuration) -> some View { configuration.label } }

struct ReferencePhotoPicker: UIViewControllerRepresentable {
    @Binding var isPresented: Bool
    var received: (Data?) -> Void
    func makeUIViewController(context: Context) -> PHPickerViewController {
        var config = PHPickerConfiguration(); config.filter = .images; config.selectionLimit = 1
        let controller = PHPickerViewController(configuration: config); controller.delegate = context.coordinator
        return controller
    }
    func updateUIViewController(_ controller: PHPickerViewController, context: Context) { context.coordinator.parent = self }
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        var parent: ReferencePhotoPicker
        init(_ parent: ReferencePhotoPicker) { self.parent = parent }
        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            picker.dismiss(animated: true)
            parent.isPresented = false
            guard let provider = results.first?.itemProvider else { return }
            provider.loadObject(ofClass: UIImage.self) { image, _ in
                let data = (image as? UIImage)?.jpegData(compressionQuality: 0.9)
                DispatchQueue.main.async { self.parent.received(data) }
            }
        }
    }
}

/// P "Describe their presence" (PRD B10): at most two chips. A third tap while two are on does nothing (AU-31: the
/// server kept only two, so SUM listed a third that the persona never got).
enum PresenceChips {
    static let max = 2
    static func toggle(_ selected: Set<String>, _ key: String) -> Set<String> {
        var updated = selected
        if updated.contains(key) { updated.remove(key) } else if updated.count < max { updated.insert(key) }
        return updated
    }
}
