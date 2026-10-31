import SwiftUI

struct ConversationView: View {
    @Bindable var model: AppState
    var connecting = false
    var body: some View {
        GeometryReader { safe in
            GeometryReader { full in
                let top = safe.safeAreaInsets.top - 44
                let bottom = full.size.height - 844
                let panelWidth = min(CGFloat(299), full.size.width - 60)
                ZStack(alignment: .topLeading) {
                    ZStack(alignment: .topLeading) {
                        companionImage.resizable().scaledToFill().frame(width: full.size.width, height: full.size.height).clipped()
                        Button { withAnimation(.easeInOut(duration: 0.22)) { model.menuOpen.toggle() } } label: {
                            CallGlassControl(icon: "glass-menu-icon", size: 47)
                        }.buttonStyle(.plain).disabled(connecting).position(x: 47.5, y: 86.5 + top)
                            .accessibilityLabel(connecting ? "Menu unavailable while connecting" : "Open menu").accessibilityIdentifier(connecting ? "openMenuConnecting" : "openMenu")
                        Image(resource: "selfPreview").resizable().frame(width: 113, height: 211).position(x: 87.5, y: 700.5 + bottom).accessibilityElement().accessibilityLabel("Your camera is off")
                        demoControl("camera", label: "Camera — unavailable in demo").position(x: full.size.width - 56, y: 665 + bottom)
                        demoControl("microphone", label: "Microphone — unavailable in demo").position(x: full.size.width - 56, y: 724 + bottom)
                        demoControl("more", label: "More — unavailable in demo").position(x: full.size.width - 56, y: 783 + bottom)
                        if connecting {
                            ZStack {
                                connectingSurface
                                let label = DesignLibrary.nodes("connecting").first { $0.type == "text" && ($0.characters ?? "").hasPrefix("Connecting") }!
                                DesignText(node: label, text: "Connecting…").frame(width: label.w, height: label.h)
                            }.frame(width: 175, height: 36).shadow(color: .black.opacity(0.15), radius: 4, y: 4).position(x: full.size.width / 2 + 0.5, y: 142 + top).accessibilityIdentifier("connectingPill")
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
        }.sheet(isPresented: $model.settingsOpen) { SettingsView(model: model) }
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
    func demoControl(_ name: String, label: String) -> some View {
        // Camera, microphone and more are explicitly excluded from the hackathon interaction scope.
        Button(action: {}) { CallGlassControl(icon: name == "camera" ? "glass-camera-icon" : name == "microphone" ? "glass-mic-icon" : "glass-more-icon", size: 46) }
            .buttonStyle(PreviewControlStyle()).disabled(true).accessibilityLabel(label).accessibilityIdentifier("excluded_\(name)")
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
