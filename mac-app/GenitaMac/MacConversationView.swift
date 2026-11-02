import SwiftUI

struct MacConversationView: View {
    @ObservedObject private var handoff = MacHandoff.shared
    @State private var model = AppState()
    @StateObject private var sharing = ScreenSharingController()
    @State private var menuOpen = false
    @State private var settingsOpen = false
    @State private var hoverShare = false
    private var reviewState: String {
        #if DEBUG
        ProcessInfo.processInfo.environment["GENITA_MAC_REVIEW"] ?? ""
        #else
        ""
        #endif
    }
    private var displaySharing: Bool { sharing.isSharing || ["sharing", "reacting", "black", "speaker"].contains(reviewState) }
    private var permissionVisible: Bool { sharing.permissionRequired }
    private let blue = Color(red: 0, green: 162.0 / 255, blue: 1)
    private let ink = Color(white: 17.0 / 255)
    private func font(_ size: CGFloat, medium: Bool = false) -> Font { .custom(medium ? "PretendardVariable-Medium" : "PretendardVariable-Regular", size: size) }
    var body: some View {
        ZStack(alignment: .topLeading) {
            ZStack(alignment: .topLeading) {
                companionImage.resizable().frame(width: 479, height: 852).offset(x: -53, y: -4).frame(width: 390, height: 844, alignment: .topLeading).clipped()
                Button { withAnimation { menuOpen.toggle() } } label: { MacGlassControl(icon: "glass-menu-icon") }
                    .buttonStyle(.plain).position(x: 47.5, y: 86.5).accessibilityIdentifier("macOpenMenu")
                resourceImage("selfPreview").resizable().frame(width: 113, height: 211).position(x: 87.5, y: 700.5).accessibilityLabel("Your camera is off")
                VStack(spacing: 13) {
                    excluded("glass-camera-icon", "Camera unavailable in demo")
                    excluded("glass-mic-icon", "Microphone unavailable in demo")
                    excluded("glass-more-icon", "More unavailable in demo")
                }.position(x: 334, y: 724)
                if handoff.desktop && handoff.motion == nil {
                Button { sharing.requestSharing() } label: {
                    if displaySharing || permissionVisible {
                        Circle().fill(Color(red: 231.0 / 255, green: 32.0 / 255, blue: 12.0 / 255)).frame(width: 47, height: 47)
                            .overlay(resourceImage("glass-share-icon").resizable().frame(width: 25.4, height: 18.4))
                    } else { MacGlassControl(icon: "glass-share-icon") }
                }.buttonStyle(.plain).position(x: 342.5, y: 86.5).onHover { hoverShare = $0 }
                    .accessibilityLabel(displaySharing ? "Stop screen sharing" : "Share screen").accessibilityIdentifier("macShareScreen")
                }
                if handoff.desktop && !permissionVisible && (hoverShare || reviewState == "hint") {
                    Text("화면 공유").font(.custom("PretendardVariable-SemiBold", size: 12)).foregroundStyle(.white)
                        .frame(width: 61, height: 25).background(ink, in: RoundedRectangle(cornerRadius: 4)).position(x: 342.5, y: 43.5)
                }
                WatchOverlays(sharing: sharing, review: reviewState)
            }.frame(width: 390, height: 844).offset(x: menuOpen ? 299 : 0)
            if menuOpen { menu }
            if permissionVisible { permissionPanel }
            MacDemoSystemBar().allowsHitTesting(false).accessibilityHidden(true)
            IslandDragHandle().frame(width:124,height:36).position(x:195,y:30)
                .accessibilityLabel("아일랜드를 드래그해서 창 이동")
        }.frame(width: 390, height: 844).clipped().ignoresSafeArea()
        .onAppear {
            if reviewState == "permission" { sharing.permissionRequired = true }
            if reviewState == "menu" { menuOpen = true }
        }
        .onDisappear { sharing.stop() }
        .onChange(of: handoff.motion?.id) { _, id in if id != nil {sharing.stop()} }
        .onChange(of: handoff.desktop) { _, value in if !value { sharing.stop() } }
        .overlay(alignment:.bottom) { Button("아이폰으로") { handoff.returnToPhone() }.disabled(!handoff.canReturn).buttonStyle(.borderedProminent).padding(.bottom,20) }
        .sheet(isPresented: $settingsOpen) { SettingsView(model: model) }
        .alert("Screen sharing could not start", isPresented: Binding(get: { sharing.error != nil }, set: { if !$0 { sharing.error = nil } })) { Button("OK") { sharing.error = nil } } message: { Text(sharing.error ?? "") }
    }
    private var companionImage: Image {
        if let data=handoff.profile,let image=NSImage(data:data) { return Image(nsImage:image) };return resourceImage("companion")
    }
    private func excluded(_ icon: String, _ label: String) -> some View {
        Button {} label: { MacGlassControl(icon: icon, size: 46) }.buttonStyle(MacUnchangedControlStyle()).disabled(true).accessibilityLabel(label)
    }
    private var menu: some View {
        ZStack(alignment: .topLeading) {
            Color(white: 0.996).frame(width: 299, height: 844)
            Text("Genita").font(.custom("KMUTTF-SungkokSemiSerif", size: 28)).tracking(-0.28).position(x: 75, y: 91)
            Button { withAnimation { menuOpen = false } } label: { menuRow("Chat", "reference-menu-chat", 20.7, 20.7) }.buttonStyle(.plain).position(x: 149.5, y: 140)
            Button { menuOpen = false; settingsOpen = true } label: { menuRow("Setting", "reference-menu-settings", 21.7, 20.7) }.buttonStyle(.plain).position(x: 149.5, y: 187)
            Button { withAnimation { menuOpen = false } } label: { Color.clear.contentShape(Rectangle()) }.buttonStyle(.plain).frame(width: 91, height: 844).position(x: 344.5, y: 422).accessibilityLabel("Close menu")
        }
    }
    private func menuRow(_ title: String, _ icon: String, _ width: CGFloat, _ height: CGFloat) -> some View {
        HStack(spacing: 19) { resourceImage(icon).resizable().frame(width: width, height: height); Text(title).font(font(18, medium: true)); Spacer() }.foregroundStyle(ink).padding(.leading, 9).frame(width: 251, height: 44).contentShape(Rectangle())
    }
    private var permissionPanel: some View {
        ZStack(alignment: .topLeading) {
            UnevenRoundedRectangle(topLeadingRadius: 30, topTrailingRadius: 30).fill(Color(white: 254.0 / 255)).frame(width: 390, height: 551).shadow(color: .black.opacity(0.04), radius: 12.95)
            Capsule().fill(Color(white: 219.0 / 255)).frame(width: 47, height: 5).position(x: 195.5, y: 14.5)
            Text("Allow screen sharing.").font(.custom("KMUTTF-SungkokSemiSerif", size: 28)).foregroundStyle(ink).position(x: 179, y: 69)
            Text("Allow Genita to record your screen in\nSystem Settings, then try sharing again.\nYou can keep talking without sharing.").font(font(16)).foregroundStyle(ink).fixedSize(horizontal: true, vertical: true).frame(width: 320, alignment: .leading).position(x: 201, y: 131)
            Button { sharing.openSettings() } label: { Text("Open Settings").font(font(16, medium: true)).foregroundStyle(Color(white: 253.0 / 255)).frame(width: 313, height: 50).background(ink, in: RoundedRectangle(cornerRadius: 6)) }.buttonStyle(.plain).position(x: 194.5, y: 251)
            Button { sharing.permissionRequired = false } label: { Text("Not now").font(font(15, medium: true)).foregroundStyle(ink).frame(width: 313, height: 36).contentShape(Rectangle()) }.buttonStyle(.plain).position(x: 194.5, y: 307)
        }.frame(width: 390, height: 366, alignment: .topLeading).position(x: 195, y: 661).accessibilityIdentifier("macSharePermission")
    }
}
private struct MacUnchangedControlStyle: ButtonStyle { func makeBody(configuration: Configuration) -> some View { configuration.label } }

private struct MacDemoSystemBar: View {
    var body: some View {
        ZStack {
            HStack(spacing: 154) {
                Text("9:41")
                    .font(.system(size: 17, weight: .semibold)).tracking(-0.43)
                    .frame(maxWidth: .infinity).frame(height: 22).padding(.top, 1.5)
                HStack(spacing: 7) {
                    resourceImage("mac-status-cellular").resizable().frame(width: 19.2, height: 12.226)
                    resourceImage("mac-status-wifi").resizable().frame(width: 17.142, height: 12.328)
                    resourceImage("mac-status-battery").resizable().frame(width: 27.328, height: 13)
                }.frame(maxWidth: .infinity).frame(height: 22).padding(.trailing, 1).padding(.top, 1)
            }.padding(.horizontal, 24).offset(y: 1)
            RoundedRectangle(cornerRadius: 18).fill(.black).frame(width: 124, height: 36).offset(y: 0.5)
        }.foregroundStyle(.black).frame(width: 390, height: 57).position(x: 195, y: 29.5)
    }
}

/// Restrict native window dragging to the black island; other controls retain
/// their normal click behavior. The handoff coordinator does not reposition a
/// settled window until a return transfer starts.
private struct IslandDragHandle:NSViewRepresentable {
    func makeNSView(context:Context)->IslandDragView {IslandDragView()}
    func updateNSView(_ view:IslandDragView,context:Context) {}
}
private final class IslandDragView:NSView {
    override var mouseDownCanMoveWindow:Bool {false}
    override func resetCursorRects(){addCursorRect(bounds,cursor:.openHand)}
    override func mouseDown(with event:NSEvent){
        guard MacHandoff.shared.desktop,MacHandoff.shared.motion == nil else{return}
        NSCursor.closedHand.push();defer{NSCursor.pop()}
        window?.performDrag(with:event)
    }
}
