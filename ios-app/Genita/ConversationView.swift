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
                ZStack(alignment: .topLeading) {
                    ZStack(alignment: .topLeading) {
                        CompanionFaceView(still: companionImage, loop: loopURL).frame(width: full.size.width, height: full.size.height).clipped()
                            .contentShape(Rectangle()).onTapGesture { call.interrupt() }.accessibilityAction(named: "Interrupt") { call.interrupt() }
                        Button { withAnimation(.easeInOut(duration: 0.22)) { model.menuOpen.toggle() } } label: {
                            CallGlassControl(icon: "glass-menu-icon", size: 47)
                        }.buttonStyle(.plain).disabled(connecting).position(x: 47.5, y: 86.5 + top)
                            .accessibilityLabel(connecting ? "Menu unavailable while connecting" : "Open menu").accessibilityIdentifier(connecting ? "openMenuConnecting" : "openMenu")
                        if interpreting {
                            InterpretOverlay(board: call.interpretBoard, top: top, onClose: { call.setInterpreting(false) }, onHold: { call.setHold($0) })
                                .frame(width: full.size.width, height: full.size.height)
                                .transition(.opacity)
                        } else {
                        selfView.position(x: 87.5, y: 700.5 + bottom)
                        Button { call.toggleCamera() } label: { CallToggleGlass(icon: "glass-camera-icon", on: call.cameraOn) }
                            .buttonStyle(PreviewControlStyle()).disabled(connecting).accessibilityLabel(call.cameraOn ? "Turn camera off" : "Turn camera on").accessibilityIdentifier("cameraToggle").position(x: full.size.width - 56, y: 665 + bottom)
                        Button { call.toggleMic() } label: { CallToggleGlass(icon: "glass-mic-icon", on: call.micOn) }
                            .buttonStyle(PreviewControlStyle()).disabled(connecting).accessibilityLabel(call.micOn ? "Turn microphone off" : "Turn microphone on").accessibilityIdentifier("micToggle").position(x: full.size.width - 56, y: 724 + bottom)
                        Button { withAnimation(.easeOut(duration: 0.22)) { moreOpen = true } } label: { CallGlassControl(icon: "glass-more-icon", size: 46) }
                            .buttonStyle(PreviewControlStyle()).disabled(connecting).accessibilityLabel("More").accessibilityIdentifier("more").position(x: full.size.width - 56, y: 783 + bottom)
                        }
                        if !connecting && !interpreting {
                            CallCueView(cue: call.cue, name: call.companionName, retry: call.retryAnswer, openSettings: openAppSettings)
                                .position(x: full.size.width / 2, y: 142 + top)
                        }
                        if connecting {
                            ZStack {
                                connectingSurface
                                let label = DesignLibrary.nodes("connecting").first { $0.type == "text" && ($0.characters ?? "").hasPrefix("Connecting") }!
                                DesignText(node: label, text: "Connecting…").frame(width: label.w, height: label.h)
                            }.frame(width: 175, height: 36).shadow(color: .black.opacity(0.15), radius: 4, y: 4).position(x: full.size.width / 2 + 0.5, y: 142 + top).accessibilityIdentifier("connectingPill")
                        }
                        if moreOpen {
                            CallInk.dim.frame(width: full.size.width, height: full.size.height).onTapGesture { withAnimation(.easeOut(duration: 0.22)) { moreOpen = false } }
                                .accessibilityLabel("Close More").accessibilityAddTraits(.isButton).accessibilityIdentifier("closeMore")
                            VStack(spacing: 0) {
                                Spacer(minLength: 0)
                                CallMoreSheet(call: call, moveToMacSubtitle: handoff.link.connected ? "Connected to your Mac" : "Pair with your Mac", moveToMac: { handoff.settings = true }) {
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
        .onAppear { if !connecting { call.begin(model.callStart) } }
        .onDisappear { if !connecting { call.end() } }
        .onChange(of: scenePhase) { _, phase in if phase != .active { call.suspend() } }
        .onChange(of: handoff.desktop) { _, onMac in if onMac { call.suspend() } }
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
