import SwiftUI

struct ConversationView: View {
    @Bindable var model: AppState
    var connecting = false
    var handoffEnabled = true
    @ObservedObject private var handoff = PhoneHandoff.shared
    private let call = CallController.shared
    @State private var moreOpen = false
    @State private var loopURL: URL?
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        GeometryReader { safe in
            GeometryReader { full in
                let top = safe.safeAreaInsets.top - 44
                let bottom = full.size.height - 844
                let panelWidth = min(CGFloat(299), full.size.width - 60)
                // F8 INT-1~6: the face stays, the rail and self view give way to the interpretation overlay
                let interpreting = call.mode == .interpret && !connecting
                let sheet = call.finds.state
                // F10 sheet during interpretation (11/2 decision): the sheet can open; while it is up the
                // interpretation bubbles and hold rail are hidden, and they come back when it closes.
                let findsOpen = !connecting && sheet != .idle && sheet != .dismissed
                ZStack(alignment: .topLeading) {
                    ZStack(alignment: .topLeading) {
                        // F10-U-SHEET r03: the face steps back as the sheet rises (half .814, rising .895) and
                        // becomes a 96 × 128 window when the sheet is full.
                        CompanionFaceView(still: companionImage, loop: loopURL).frame(width: full.size.width, height: full.size.height).clipped()
                            .grayscale(sheetOffline ? 1 : 0).brightness(sheetOffline ? -0.25 : 0)
                            .scaleEffect(faceScale(sheet), anchor: .topLeading).offset(faceOffset(sheet, top: top))
                            .opacity(sheet == .full ? 0 : 1)
                            .contentShape(Rectangle()).onTapGesture { faceTapped() }.accessibilityAction(named: "Interrupt") { call.interrupt() }
                            .animation(.drawer, value: sheet)
                        Button { withAnimation(.easeInOut(duration: 0.22)) { model.menuOpen.toggle() } } label: {
                            CallGlassControl(icon: "glass-menu-icon", size: 47)
                        }.buttonStyle(.plain).disabled(connecting).position(x: 47.5, y: 86.5 + top)
                            .accessibilityLabel(connecting ? "Menu unavailable while connecting" : "Open menu").accessibilityIdentifier(connecting ? "openMenuConnecting" : "openMenu")
                            .opacity(sheet == .full ? 0 : 1).accessibilityHidden(sheet == .full)
                        if interpreting {
                            if !findsOpen {
                                InterpretOverlay(board: call.interpretBoard, top: top, onClose: { call.setInterpreting(false) }, onHold: { call.setHold($0) })
                                    .frame(width: full.size.width, height: full.size.height)
                                    .transition(.opacity)
                            }
                        } else {
                        selfView.scaleEffect(sheet == .half || sheet == .rising ? 0.5 : 1)
                            .position(x: sheet == .half || sheet == .rising ? 52.25 : 87.5, y: selfY(sheet) + bottom)
                            .opacity(sheet == .full ? 0 : 1).animation(.drawer, value: sheet)
                        Button { call.toggleCamera() } label: { CallToggleGlass(icon: "glass-camera-icon", on: call.cameraOn) }
                            .buttonStyle(PreviewControlStyle()).disabled(connecting).accessibilityLabel(call.cameraOn ? "Turn camera off" : "Turn camera on").accessibilityIdentifier("cameraToggle").position(x: full.size.width - 56, y: 665 + bottom + railShift(sheet))
                            .opacity(sheet == .full ? 0 : 1).accessibilityHidden(sheet == .full).animation(.drawer, value: sheet)
                        Button { call.toggleMic() } label: { CallToggleGlass(icon: "glass-mic-icon", on: call.micOn) }
                            .buttonStyle(PreviewControlStyle()).disabled(connecting).accessibilityLabel(call.micOn ? "Turn microphone off" : "Turn microphone on").accessibilityIdentifier("micToggle").position(x: full.size.width - 56, y: 724 + bottom + railShift(sheet))
                            .opacity(sheet == .full ? 0 : 1).accessibilityHidden(sheet == .full).animation(.drawer, value: sheet)
                        Button { withAnimation(.easeOut(duration: 0.22)) { moreOpen = true } } label: { CallGlassControl(icon: "glass-more-icon", size: 46) }
                            .buttonStyle(PreviewControlStyle()).disabled(connecting).accessibilityLabel("More").accessibilityIdentifier("more").position(x: full.size.width - 56, y: 783 + bottom + railShift(sheet))
                            .opacity(sheet == .full ? 0 : 1).accessibilityHidden(sheet == .full).animation(.drawer, value: sheet)
                        }
                        if findsOpen {
                            FindsSheet(call: call, size: full.size).frame(width: full.size.width, height: full.size.height, alignment: .top)
                                .transition(.move(edge: .bottom))
                        }
                        if sheet == .full {
                            // r03 `.pip`: the face as a 96 × 128 window; tap → back to half
                            Button { withAnimation(.drawer) { call.finds.pipTapped() } } label: {
                                CompanionFaceView(still: companionImage, loop: loopURL).frame(width: 96, height: 128).clipShape(RoundedRectangle(cornerRadius: 16))
                                    .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(CallInk.onInk, lineWidth: 2)).shadow(color: CallInk.ink.opacity(0.18), radius: 12, y: 8)
                            }.buttonStyle(PressScale()).position(x: full.size.width - 64, y: 112 + top)
                                .accessibilityLabel("Back to half height").accessibilityIdentifier("findsPip").transition(.opacity)
                        }
                        if sheet == .dismissed {
                            FindsToast(finds: call.finds).position(x: full.size.width / 2, y: 210 + top).transition(.opacity.combined(with: .offset(y: -8)))
                        }
                        if !connecting && !interpreting {
                            CallCueView(cue: call.cue, name: call.companionName, retry: call.retryAnswer, openSettings: openAppSettings)
                                .frame(width: sheet == .full ? 250 : full.size.width, alignment: sheet == .full ? .leading : .center)
                                .position(x: sheet == .full ? 16 + 125 : full.size.width / 2, y: (sheet == .full ? 82 : 142) + top)
                        }
                        if connecting {
                            ZStack {
                                connectingSurface
                                let label = DesignLibrary.nodes("connecting").first { $0.type == "text" && ($0.characters ?? "").hasPrefix("Connecting") }!
                                DesignText(node: label, text: "Connecting to \(model.companionDisplayName)…").frame(width: lineWidth(for: label), height: label.h)
                            }.frame(width: max(175, lineWidth(for: label) + 40), height: 36).shadow(color: .black.opacity(0.15), radius: 4, y: 4).position(x: full.size.width / 2 + 0.5, y: 142 + top).accessibilityIdentifier("connectingPill")
                        }
                        if moreOpen {
                            CallInk.dim.frame(width: full.size.width, height: full.size.height).onTapGesture { withAnimation(.easeOut(duration: 0.22)) { moreOpen = false } }
                                .accessibilityLabel("Close More").accessibilityAddTraits(.isButton).accessibilityIdentifier("closeMore")
                            VStack(spacing: 0) {
                                Spacer(minLength: 0)
                                CallMoreSheet(call: call, moveToMacSubtitle: handoff.link.connected ? "Connected to your Mac" : "Pair with your Mac", moveToMac: { handoff.settings = true },
                                              openFinds: call.finds.cardCount > 0 ? { withAnimation(.drawer) { call.finds.reopenLatest() } } : nil) {
                                    withAnimation(.easeOut(duration: 0.22)) { moreOpen = false }
                                }
                            }.frame(width: full.size.width, height: full.size.height).transition(.move(edge: .bottom))
                        }
                    }.frame(width: full.size.width, height: full.size.height).offset(x: model.menuOpen ? panelWidth : 0)
                    if model.menuOpen {
                        Color(white: 0.996).frame(width: panelWidth, height: full.size.height)
                        let title = DesignLibrary.nodes("menu").first { $0.characters == "Genita" }!
                        DesignText(node: title).frame(width: title.w, height: title.h).position(x: title.x + title.w / 2, y: title.y + top + title.h / 2)
                        menuRow("Chat", icon: "reference-menu-chat", y: 118, width: panelWidth, top: top) { withAnimation { model.menuOpen = false } }.accessibilityIdentifier("returnConversation")
                        menuRow("Setting", icon: "reference-menu-settings", y: 165, width: panelWidth, top: top) { model.menuOpen = false; model.settingsOpen = true }.accessibilityIdentifier("settings")
                        Button { withAnimation { model.menuOpen = false } } label: { Color.clear.contentShape(Rectangle()) }
                            .frame(width: full.size.width - panelWidth, height: full.size.height).position(x: panelWidth + (full.size.width - panelWidth) / 2, y: full.size.height / 2).buttonStyle(.plain).accessibilityLabel("Close menu")
                    }
                }.frame(width: full.size.width, height: full.size.height).clipped()
            }.ignoresSafeArea()
        }.opacity(handoffEnabled && (handoff.desktop || handoff.motionVisible) ? 0 : 1)
        .overlay { if handoffEnabled && !connecting { PhoneHandoffOverlay(model:model) } }
        .sheet(isPresented: $model.settingsOpen) { SettingsView(model: model) }
        .task(id: model.setup.imageData) { loopURL = model.companionLoopURL }
        .onAppear {
            if !connecting {
                call.companionName = model.companionDisplayName
                call.onCompanionNamed = { [model] name in model.setup.companionName = name }
                call.begin(model.callStart)
                model.setup.firstCallPending = false
                #if DEBUG
                call.installFindsFixture()
                #endif
            }
        }
        .onDisappear { if !connecting { call.end() } }
        .onChange(of: scenePhase) { _, phase in if phase != .active { call.suspend() } }
        .onChange(of: handoff.desktop) { _, onMac in if onMac { call.suspend() } }
        // F1-L7: 4401 → A02 sign in, 4403 → CS01 consent (CallController.stopped)
        .onChange(of: call.stopped) { _, stop in model.route(stop) }
    }
    /// S07 pill grows for a long {name} (NM01 allows 20 characters); "Connecting to Jin…" keeps the board's 175 pt.
    private func lineWidth(for label: DesignNode) -> CGFloat {
        let line = "Connecting to \(model.companionDisplayName)…"
        return max(label.w, ceil((line as NSString).size(withAttributes: [.font: label.font]).width) + 2)
    }
    private var sheetOffline: Bool { call.finds.state != .idle && (call.link == .reconnecting || call.finds.offline) }

    /// Face tap: with the sheet up it folds the sheet (r03 "얼굴 누르기 → 접힘"); otherwise it interrupts.
    private func faceTapped() {
        if withAnimation(.drawer, { call.finds.faceTapped() }) { return }
        call.interrupt()
    }
    private func faceScale(_ s: SheetState) -> CGFloat { s == .half ? 0.814 : s == .rising ? 0.895 : 1 }
    private func faceOffset(_ s: SheetState, top: CGFloat) -> CGSize {
        s == .half ? CGSize(width: 43.1, height: -66) : s == .rising ? CGSize(width: 24.2, height: -37.1) : .zero
    }
    /// r03 `.self`: half → translate(-7,-400) scale .5 (centre 52.25, 247.75); peek/searching → up 122.
    private func selfY(_ s: SheetState) -> CGFloat {
        switch s {
        case .half, .rising: 247.75
        case .peek, .searching: 700.5 - 122
        default: 700.5
        }
    }
    /// r03 `.rail`: half → up 440, peek/searching → up 122, full → hidden behind the sheet.
    private func railShift(_ s: SheetState) -> CGFloat {
        switch s {
        case .half, .rising, .full: -440
        case .peek, .searching: -122
        default: 0
        }
    }

    /// Self view: the live front camera when on, the design's placeholder when off.
    @ViewBuilder var selfView: some View {
        if call.cameraOn {
            SelfCameraView(session: call.cameraSession).frame(width: 113, height: 211).background(CallInk.ink).clipShape(RoundedRectangle(cornerRadius: 16))
                .accessibilityElement().accessibilityLabel("Your camera")
        } else {
            Image(resource: "selfPreview").resizable().frame(width: 113, height: 211).accessibilityElement().accessibilityLabel("Your camera is off")
        }
    }
    func openAppSettings() {
        call.dismissMicBlocked()
        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
    }
    @ViewBuilder var connectingSurface: some View {
        if #available(iOS 26.0, *) {
            RoundedRectangle(cornerRadius: 16).fill(.black.opacity(0.05)).glassEffect(.regular, in: RoundedRectangle(cornerRadius: 16)).environment(\.colorScheme, .dark)
        } else {
            RoundedRectangle(cornerRadius: 16).fill(.ultraThinMaterial).overlay(RoundedRectangle(cornerRadius: 16).fill(.black.opacity(0.05))).environment(\.colorScheme, .dark)
        }
    }
    func menuRow(_ title: String, icon: String, y: CGFloat, width: CGFloat, top: CGFloat, action: @escaping () -> Void) -> some View {
        let label = DesignLibrary.nodes("menu").first { $0.characters == title }!
        return Button(action: action) {
            ZStack(alignment: .topLeading) {
                Color.clear
                Image(resource: icon).resizable().frame(width: title == "Chat" ? 20.7 : 21.7007, height: 20.7).position(x: 20, y: 22)
                DesignText(node: label).frame(width: label.w, height: label.h).position(x: label.x - 24 + label.w / 2, y: 22)
            }.frame(width: width - 48, height: 44).contentShape(Rectangle())
        }.buttonStyle(.plain).position(x: width / 2, y: y + 22 + top).accessibilityLabel(title)
    }
    var companionImage: Image {
        if let data = model.setup.imageData, let image = UIImage(data: data) { return Image(uiImage: image) }
        return Image(resource: "companion")
    }
}

private struct PreviewControlStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { configuration.label }
}

struct CallGlassControl: View {
    let icon: String
    var size: CGFloat
    var body: some View {
        ZStack {
            if #available(iOS 26.0, *) {
                Circle().fill(.black.opacity(0.15)).glassEffect(.clear, in: Circle()).environment(\.colorScheme, .dark).overlay(Circle().strokeBorder(LinearGradient(colors: [.white.opacity(0.65), .white.opacity(0.06), .white.opacity(0.32)], startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 0.7))
            } else {
                Circle().fill(.ultraThinMaterial).environment(\.colorScheme, .dark)
                    .overlay(Circle().fill(.black.opacity(0.15)))
                    .overlay(Circle().strokeBorder(LinearGradient(colors: [.white.opacity(0.65), .white.opacity(0.06), .white.opacity(0.32)], startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 0.7))
            }
            if let url = Bundle.main.url(forResource: icon, withExtension: "png"), let image = UIImage(contentsOfFile: url.path) {
                Image(uiImage: image).resizable().frame(width: image.size.width / 4, height: image.size.height / 4)
            }
        }.frame(width: size, height: size).contentShape(Circle())
    }
}
