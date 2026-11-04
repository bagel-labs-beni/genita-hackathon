import SwiftUI

struct MacConversationView: View {
    @ObservedObject private var handoff = MacHandoff.shared
    @ObservedObject private var sharing = MacHandoff.shared.sharing
    @ObservedObject private var media = MacHandoff.shared.media
    @State private var model = AppState()
    /// F8-L4 · ⋮ → Interpret a call (INT-M0~M2)
    @State private var interpret = MacInterpretController()
    /// The live call owns camera and mic on the Mac too (one owner; #2's LocalCallMedia only keeps the permission UI).
    private let call = CallController.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// #118: account, companion and when the call runs on this Mac.
    @ObservedObject private var macCall = MacCall.shared
    /// #121 MAC-LINK: the product page just opened in the browser.
    @State private var linkOpened: ProductPick?
    @State private var menuOpen = false
    @State private var settingsOpen = false
    /// Debug review renders one state per screenshot without the env (MacHandoff.renderReviewScreens).
    var reviewOverride: String? = nil
    private var reviewState: String {
        #if DEBUG
        reviewOverride ?? ProcessInfo.processInfo.environment["GENITA_MAC_REVIEW"] ?? ""
        #else
        ""
        #endif
    }
    /// R2 and R2-E. A running effect covers the change of owner until it ends.
    private var waitingCopy: HandoffCopy? { handoff.motion == nil ? HandoffCopy.mac(handoff.surface, sharingStopped: handoff.sharingStopped) : nil }
    private var displaySharing: Bool { sharing.isSharing || ["sharing", "reacting", "black", "speaker"].contains(reviewState) }
    private var permissionVisible: Bool { sharing.permissionRequired }
    /// The Share screen pill: sharing, starting (the permission sheet or the macOS picker is open), or idle.
    private var sharePhase: MacSharePill.Phase {
        if displaySharing { return .sharing }
        if permissionVisible || sharing.choosing || reviewState == "share-starting" { return .starting }
        return .idle
    }
    private let blue = Color(red: 0, green: 162.0 / 255, blue: 1)
    /// The menu / share row: under the fake status bar before, at the window's top in Mac v2 (#216).
    private var topRowY: CGFloat { MacDesignV2.enabled ? 47.5 : 86.5 }
    private let ink = Color(white: 17.0 / 255)
    private func font(_ size: CGFloat, medium: Bool = false) -> Font { .custom(medium ? "PretendardVariable-Medium" : "PretendardVariable-Regular", size: size) }
    var body: some View {
        ZStack(alignment: .topLeading) {
            ZStack(alignment: .topLeading) {
                companionStill(width: 479, height: 852).offset(x: -53, y: -4).frame(width: 390, height: 844, alignment: .topLeading).clipped()
                    // motion details card 10: veiled while the call connects, clears once when it is live (flag off: plain)
                    .modifier(MacCallVeil(veiled: call.link == .connecting))
                    .contentShape(Rectangle()).onTapGesture { faceTapped() }
                    .accessibilityElement().accessibilityLabel(macCall.companionName.map { "\($0) on the call" } ?? "Your companion").accessibilityIdentifier("macCompanionFace")
                // L4: the animated Meta face (prep face set), same framing as the still; nil → the still
                ZStack(alignment: .topLeading) { if let face = call.face {
                    // same presence: the face set's own rest frame sits under the live face, so the first frame after
                    // arriving from the iPhone is already this face in this crop (never the prep still, then a jump)
                    ZStack {
                        if let poster = call.facePoster { Image(decorative: poster, scale: 1).resizable().scaledToFill() }
                        FaceFrameView(driver: face)
                    }.frame(width: 479, height: 852).clipped().offset(x: -53, y: -4).frame(width: 390, height: 844, alignment: .topLeading).clipped()
                        // the motion lane's call veil (as the iPhone #524 reveal): the generated face clears it once
                        .modifier(MacCallVeil(veiled: call.link == .connecting))
                        .allowsHitTesting(false)
                        // S09-P (D28, AU-25): a face set that lands mid-call fades in over the still once (the reveal)
                        .transition(.opacity)
                } }.animation(reduceMotion ? nil : CompanionFace.revealCurve, value: call.face.map(ObjectIdentifier.init))
                if sheetFull { MacSheetInk.ink.frame(width: 390, height: 844).allowsHitTesting(false) }
                if waitingCopy != nil { handoffScrim.frame(width: 390, height: 844).allowsHitTesting(false) }
                Button { withAnimation { menuOpen.toggle() } } label: { MacGlassControl(icon: "glass-menu-icon") }
                    .buttonStyle(.plain).position(x: 47.5, y: topRowY).opacity(sheetFull || linkOpened != nil || menuOpen ? 0 : 1).allowsHitTesting(!sheetFull && linkOpened == nil && !menuOpen).accessibilityIdentifier("macOpenMenu")
                if interpret.isLive {
                    InterpretOverlay(board: call.interpretBoard, level: { call.inputLevel }, onClose: { interpret.stop() }, onHold: { call.setHold($0) })
                        .frame(width: 390, height: 844)
                } else if waitingCopy == nil {
                    // live captions r01: same layer as the iPhone, bottom edge 16 above the rail (626), under the self view and rail
                    captionLayer
                    if MacDesignV2.enabled {
                        // iPhone S09 HUD A (#530) on the Mac: a glass tile at the bottom left, 16 from the edge, its
                        // bottom on the control rail's bottom (724 + 82); camera on grows it 72×96 → 108×144
                        selfView.frame(width: selfSize.width, height: selfSize.height)
                            .position(x: 16 + selfSize.width / 2, y: 806 - selfSize.height / 2 - railShift).opacity(sheetCovers ? 0 : 1)
                            .animation(reduceMotion ? nil : .spring(response: 0.4, dampingFraction: 0.85), value: call.cameraOn)
                    } else {
                        selfView.position(x: 87.5, y: 700.5 - railShift).opacity(sheetCovers ? 0 : 1)
                    }
                    VStack(spacing: 13) {
                        Button { call.toggleCamera() } label: { MacGlassControl(icon: "glass-camera-icon", size: 46, slashed: !call.cameraOn) }.buttonStyle(MacUnchangedControlStyle())
                            .modifier(MacControlEntrance(shown: call.link != .connecting, index: 0))
                            .accessibilityLabel(call.cameraOn ? "Turn camera off" : "Turn camera on").accessibilityIdentifier("macCameraToggle")
                        // motion details card 2: pressed to 0.94 (build 11), a blue ring that follows the user's voice while the mic is on
                        Button { call.toggleMic() } label: {
                            MacGlassControl(icon: "glass-mic-icon", size: 46, slashed: !call.micOn)
                                .background { MotionVoiceRing(active: call.micOn && call.link == .live, diameter: 46, color: Color(red: 84 / 255, green: 193 / 255, blue: 1), level: { call.inputLevel }) }
                        }.buttonStyle(MotionPressStyle())
                            .modifier(MacControlEntrance(shown: call.link != .connecting, index: 1))
                            .accessibilityLabel(call.micOn ? "Turn microphone off" : "Turn microphone on").accessibilityIdentifier("macMicToggle")
                        if MacInterpretController.enabled {
                            Button { withAnimation(.easeOut(duration: 0.22)) { interpret.open() } } label: { MacGlassControl(icon: "glass-more-icon", size: 46) }
                                .buttonStyle(.plain).modifier(MacControlEntrance(shown: call.link != .connecting, index: 2)).accessibilityLabel("More").accessibilityIdentifier("macMore")
                        } else {
                            // ⋮ = the Mac menu (MC-M: Finds, Setting, Move to iPhone) while interpretation is cut — never a dead button
                            Button { withAnimation { menuOpen = true } } label: { MacGlassControl(icon: "glass-more-icon", size: 46) }
                                .buttonStyle(.plain).modifier(MacControlEntrance(shown: call.link != .connecting, index: 2)).accessibilityLabel("More").accessibilityIdentifier("macMore")
                        }
                    }.position(x: 334, y: 724 - railShift).opacity(sheetCovers ? 0 : 1).allowsHitTesting(!sheetCovers)
                }
                if waitingCopy == nil && handoff.motion == nil && !sheetFull && linkOpened == nil {
                    // Share screen r01 (Chelsea OK 11/4): one labelled glass pill, right edge at 366, centred on the top row
                    MacSharePill(phase: sharePhase, action: { sharing.requestSharing() }, reviewHover: reviewState == "share-hover")
                        .frame(width: 342, alignment: .trailing).position(x: 195, y: topRowY)
                }
                if let waitingCopy {
                    VStack(spacing: 0) { Spacer(minLength: 0); HandoffWaitingSheet(copy: waitingCopy) { handoff.continueHere() } }.frame(width: 390, height: 844)
                }
                if let denied = callDenied, waitingCopy == nil {
                    VStack(spacing: 0) {
                        Spacer(minLength: 0)
                        MediaPermissionSheet(kind: denied, name: call.companionName, openSettings: { media.openSystemSettings(for: denied) }, dismiss: { call.dismissDenied() })
                    }.frame(width: 390, height: 844)
                }
                if waitingCopy == nil && !interpret.isLive {
                    if linkOpened == nil {
                        MacResultSheet(finds: call.finds) { pick in withAnimation(.easeOut(duration: 0.22)) { linkOpened = pick } }
                            .frame(width: 390, height: 844, alignment: .topLeading)
                    }
                    if sheetFull {
                        companionStill(width: 96, height: 128, fill: true).clipShape(RoundedRectangle(cornerRadius: 16))
                            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(MacSheetInk.onInk, lineWidth: 2))
                            .position(x: 278 + 48, y: (MacDesignV2.enabled ? 28 : 48) + 64).onTapGesture { withAnimation { call.finds.pipTapped() } }
                            .accessibilityLabel("Back to half height").accessibilityAddTraits(.isButton)
                    }
                    if let text = cueText { MacCallCue(text: text).frame(maxWidth: sheetFull ? 250 : 342, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                        .position(x: sheetFull ? 16 + 125 : 195, y: sheetFull ? 86 : (MacDesignV2.enabled && !displaySharing ? 103 : 142)).frame(width: 390, height: 844, alignment: .topLeading).allowsHitTesting(false) }
                    if linkOpened != nil {
                        // MAC-LINK = Dyno's demo video (2:16): the prompt draws its own two-line pill, so no separate cue
                        MacLinkPrompt(share: { linkOpened = nil; sharing.requestSharing() }, notNow: { withAnimation(.easeOut(duration: 0.22)) { linkOpened = nil } })
                    }
                }
                // A full result sheet owns the top of the window; the share chip and cards come back when it folds.
                if !sheetFull { WatchOverlays(sharing: sharing, review: reviewState) }
            }.frame(width: 390, height: 844).offset(x: menuOpen ? 299 : 0)
            if menuOpen { menu }
            if MacInterpretController.enabled && interpret.stage == .picking { interpretSheet }
            if permissionVisible { permissionPanel }
            // QA #216 to-be: no fake 9:41 / battery bar on a real Mac (the island handle stays for moving the window)
            if !MacDesignV2.enabled { MacDemoSystemBar(onDark: waitingCopy != nil || sheetFull).allowsHitTesting(false).accessibilityHidden(true) }
            if MacDesignV2.enabled {
                // Mac v2: no island on a Mac — a small grab bar says where the window moves from
                Capsule().fill(Color.white.opacity(menuOpen ? 0 : 0.55)).frame(width: 36, height: 5).position(x: 195, y: 10.5).allowsHitTesting(false).accessibilityHidden(true)
                if !MacDesignV2.reviewRender { IslandDragHandle().frame(width:124,height:28).position(x:195,y:14).accessibilityLabel("Drag to move the window") }
            } else {
                IslandDragHandle().frame(width:124,height:36).position(x:195,y:30)
                    .accessibilityLabel("Drag to move the window")
            }
        }.frame(width: 390, height: 844).clipped().ignoresSafeArea()
        // same presence (flag): the waiting sheet fades away as the conversation comes back to this Mac
        .animation(MacPresenceFade.enabled ? .easeOut(duration: MacPresenceFade.seconds) : nil, value: waitingCopy == nil)
        .onAppear {
            if reviewState == "permission" { sharing.permissionRequired = true }
            if reviewState == "menu" { menuOpen = true }
            #if DEBUG
            if reviewState == "link" { linkOpened = MacResultFixture.firstPick }
            #endif
            // {name} comes from the account's companion (named on the iPhone, NM01), never a hard-coded "Jin"
            if model.onboarding.auth.isSignedIn {
                Task { if let c = try? await model.onboarding.companion() { model.setup.companionName = c.name; call.companionName = c.name } }
            }
        }
        .onAppear { call.showFace(reduceMotion: reduceMotion) }
        .onDisappear { call.hideFace() }
        .onChange(of: reduceMotion) { _, on in call.setFaceReduceMotion(on) }
        // F5: the live call's session id + token reach the screen share (release builds had no watchConfig at all)
        .onChange(of: call.sessionId) { _, id in
            sharing.watchConfig = id.map { .init(server: call.currentEndpoint.url, token: call.currentEndpoint.token, sessionId: $0) }
        }
        .onChange(of: call.link) { _, link in
            if link == .idle { sharing.stop(); sharing.watchConfig = nil }
            else if link != .live { sharing.watchConfig = nil }
            else if let id = call.sessionId { sharing.watchConfig = .init(server: call.currentEndpoint.url, token: call.currentEndpoint.token, sessionId: id) }
        }
        .onChange(of: macCall.isSignedIn) { _, signedIn in if !signedIn { sharing.stop(); sharing.watchConfig = nil } }
        .onChange(of: call.micOn) { _, on in if handoff.ownership.isOwner { MacCall.micRemembered = on } }
        .sheet(isPresented: $settingsOpen) { MacSettingsSheet(compact: true) }
        .alert("Couldn’t start interpreting", isPresented: Binding(get: { if case .failed = interpret.stage { return true } else { return false } }, set: { if !$0 { interpret.stage = .idle } })) {
            Button("OK") { interpret.stage = .idle }
        } message: { if case let .failed(message) = interpret.stage { Text(message) } }
        .onDisappear { if interpret.isLive { interpret.stop() } }
        .alert(sharing.errorTitle, isPresented: Binding(get: { sharing.error != nil }, set: { if !$0 { sharing.error = nil } })) { Button("OK") { sharing.error = nil } } message: { Text(sharing.error ?? "") }
    }
    /// INT-M0 · pick the call app, then Start interpreting.
    private var interpretSheet: some View {
        ZStack(alignment: .bottom) {
            Color(white: 17.0 / 255).opacity(0.46).frame(width: 390, height: 844)
                .onTapGesture { withAnimation(.easeOut(duration: 0.22)) { interpret.cancel() } }
                .accessibilityLabel("Close").accessibilityAddTraits(.isButton)
            MacInterpretCallSheet(app: $interpret.app, warning: interpret.headphones ? nil : "No headphones on: the other person would hear my whispers too.") {
                interpret.start(.companion(name: call.companionName, userName: model.setup.name, profile: model.setup.response, traits: model.setup.presence.sorted(), voiceId: nil))
            }
            .frame(width: 390)
            .transition(.move(edge: .bottom))
        }
        .frame(width: 390, height: 844)
        .accessibilityIdentifier("macInterpretSheet")
    }
    /// This account's own picture only: the server's scene still, else the one the iPhone handed over. Without either the
    /// call shows a neutral placeholder — never the bundled demo face, which is someone else's companion (#524 UI sweep, CL-03).
    private var companionPicture: NSImage? {
        // CL-03 order (CallStillSource, tested): this account's server still, then the iPhone's handoff profile, else
        // the dark ground — never the bundled companion.png in the shipped app (DEBUG review renders below only)
        switch CallStillSource.pick(hasServerStill: macCall.face != nil, hasHandoffProfile: handoff.profile != nil) {
        case .serverStill: return macCall.face
        case .handoffProfile: if let image = handoff.profile.flatMap({ NSImage(data: $0) }) { return image }
        case .ground: break
        }
        #if DEBUG
        // review renders (GENITA_MAC_REVIEW_OUT) keep the fixture face so the call screens stay comparable
        if ProcessInfo.processInfo.environment["GENITA_MAC_REVIEW_OUT"] != nil, reviewState != "noface",
           let url = Bundle.main.url(forResource: "companion", withExtension: "png") { return NSImage(contentsOf: url) }
        #endif
        return nil
    }
    @ViewBuilder private func companionStill(width: CGFloat, height: CGFloat, fill: Bool = false) -> some View {
        if let picture = companionPicture {
            if fill { Image(nsImage: picture).resizable().scaledToFill().frame(width: width, height: height) }
            else { Image(nsImage: picture).resizable().frame(width: width, height: height) }
        } else {
            MacFacePlaceholder().frame(width: width, height: height)
        }
    }
    // MARK: #118 / #121 call + sheet layout
    /// Live captions r01 (LiveCaptions.swift): the iPhone's layer, bottom edge 16 above the rail VStack's top (724 − 82 → 626).
    @ViewBuilder private var captionLayer: some View {
        // kill switch: app config flag `liveCaptions` (default on), as on the iPhone
        if GenitaAppConfigStore.shared.config.flag("liveCaptions", default: true) {
        CallCaptionLayer(style: CaptionStyle(ink: MacSheetInk.ink, onInk: MacSheetInk.onInk, blue: Color(red: 84 / 255, green: 193 / 255, blue: 1),
                                             font: { size, weight in .custom(weight == .medium ? "PretendardVariable-Medium" : "PretendardVariable-Regular", fixedSize: size) }),
                         size: CGSize(width: 390, height: 844), bottom: 724 - 82 - 16 - railShift,
                         hidden: call.link == .connecting || sheetCovers || menuOpen,
                         micOn: call.micOn || reviewState == "caption", frame: { call.captionFrame() }, level: { call.inputLevel }, still: reviewState == "caption")
        }
    }
    private var sheetFull: Bool { call.finds.state == .full && linkOpened == nil && waitingCopy == nil }
    /// half / full: the sheet covers the self view and the controls (r03).
    /// half / full cover the self view and controls; MAC-LINK shows only the face, the line and its two buttons.
    private var sheetCovers: Bool { linkOpened != nil || [.rising, .half, .full].contains(call.finds.state) }
    /// r03 rail rule on the Mac: searching (198) and peek (148) lift the self view and controls above the sheet.
    private var railShift: CGFloat { [.searching, .peek].contains(call.finds.state) && linkOpened == nil ? call.finds.state.macHeight - 26 : 0 }
    private var cueText: String? {
        // MC-M (90:2): the face beside the open menu carries nothing
        if linkOpened != nil || menuOpen { return nil }
        if let line = handoff.moveLine { return line }   // AU-88: Move to iPhone waiting / failed
        if sharing.stoppedCue || reviewState == "share-stopped" { return "Stopped sharing" }
        if sharing.isSharing, let message = sharing.connectionMessage { return message }
        // MS-2 "Reacting" and MS-3 black-screen card own that spot while a share is live
        if sharing.isSharing && (sharing.reacting || sharing.blank) { return nil }
        if ["black", "reacting"].contains(reviewState) { return nil }
        // the server's spoken line for the card (one line in the pill); otherwise the call cue, as on the iPhone —
        // no app copy (the searching "On it." is the server's spoken reply, heard as "{name} is talking")
        if sheetFull, let say = call.finds.current?.card?.say, !say.isEmpty { return say }
        return MacCallCue.text(call.cue, name: macCall.companionName ?? call.companionName)
    }
    /// Face tap: folds an open sheet (r03), otherwise stops the companion mid-sentence.
    private func faceTapped() {
        if withAnimation(.spring(response: 0.42, dampingFraction: 0.86), { call.finds.faceTapped() }) { return }
        call.interrupt()
    }
    /// E01/E02 from the call's own permission checks (Dyno's sheet, the call's state).
    private var callDenied: LocalCallMedia.Kind? { call.micDenied ? .microphone : call.cameraDenied ? .camera : nil }
    /// Self view size on Mac v2 (iPhone HUD A): camera off 72×96, on 108×144.
    private var selfSize: CGSize { call.cameraOn ? CGSize(width: 108, height: 144) : CGSize(width: 72, height: 96) }
    @ViewBuilder private var selfView: some View {
        if call.cameraOn {
            if MacDesignV2.enabled {
                SelfCameraPreview(session: call.cameraSession).clipShape(RoundedRectangle(cornerRadius: 16))
                    .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.white.opacity(0.35), lineWidth: 0.7))
            } else {
                SelfCameraPreview(session: call.cameraSession).frame(width: 113, height: 211).clipShape(RoundedRectangle(cornerRadius: 16))
            }
        } else {
            if MacDesignV2.enabled {
                // the iPhone's camera-off glass tile: dark material + 28 % black, 0.7 pt white 35 % rim, video.slash
                Image(systemName: "video.slash").font(.system(size: 18, weight: .regular)).foregroundStyle(Color.white.opacity(0.7))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background {
                        // MA-04: a live material over the animated face re-blurs every frame (CA commit on the main
                        // thread). Solid stand-in with the same look in a still: the dark material + 28 % black composites to #211D22 (the material look, 춘식이 3× median) ; solved from two CI renders (춘식이 region medians, icon excluded) for a #211D22 composite: #201C21 at 92 %.
                        RoundedRectangle(cornerRadius: 16).fill(Color(red: 32.0 / 255, green: 28.0 / 255, blue: 33.0 / 255).opacity(0.92))
                    }
                    .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.white.opacity(0.35), lineWidth: 0.7))
                    .accessibilityElement().accessibilityLabel("Your camera is off")
            } else {
                resourceImage("selfPreview").resizable().frame(width: 113, height: 211).accessibilityLabel("Your camera is off")
            }
        }
    }
    /// MC-M (Figma 90:2): Chat (dimmed, text chat is cut), Finds with its count, Setting, a rule, then Move to iPhone
    /// (dimmed while no iPhone is in front, as the Move to Mac row on the iPhone).
    private var menu: some View {
        let finds = call.finds.cardCount
        let canMove = handoff.canMoveToPhone
        return ZStack(alignment: .topLeading) {
            Color(white: 253.0 / 255).frame(width: 299, height: 844)
            VStack(alignment: .leading, spacing: 0) {
                Text("Genita").font(MacSheetInk.serif(28)).tracking(-0.28).foregroundStyle(ink).frame(height: 34, alignment: .leading)
                    .padding(.leading, 33).padding(.bottom, 12).accessibilityAddTraits(.isHeader)
                menuLine("Chat", icon: AnyView(resourceImage("reference-menu-chat").resizable().frame(width: 20, height: 20)), dim: true, trailing: MacDesignV2.enabled ? "Soon" : nil, id: "macMenuChat") {}.disabled(true)
                menuLine("Finds", icon: AnyView(Image(systemName: "bookmark").font(.system(size: 17, weight: .light))), trailing: finds > 0 ? "\(finds)" : nil, id: "macMenuFinds") {
                    withAnimation { menuOpen = false }
                    if call.finds.cardCount > 0 { call.finds.reopenLatest() }
                }
                menuLine(MacDesignV2.enabled ? "Settings" : "Setting", icon: AnyView(resourceImage("reference-menu-settings").resizable().frame(width: 20, height: 20)), id: "macMenuSetting") { menuOpen = false; settingsOpen = true }
                Rectangle().fill(Color(white: 227.0 / 255)).frame(height: 1).padding(.leading, 32).padding(.trailing, 24).padding(.top, 8)
                menuLine("Move to iPhone", icon: AnyView(Image(systemName: "iphone").font(.system(size: 17, weight: .light))), dim: !canMove, height: 56, top: 8, id: "macMenuMoveToPhone") {
                    withAnimation { menuOpen = false }
                    handoff.moveToPhone()
                }.disabled(!canMove)
            }.padding(.top, MacDesignV2.enabled ? 56 : 72).frame(width: 299, height: 844, alignment: .topLeading)
            Button { withAnimation { menuOpen = false } } label: { Color.clear.contentShape(Rectangle()) }.buttonStyle(.plain).frame(width: 91, height: 844).position(x: 344.5, y: 422).accessibilityLabel("Close menu")
        }
    }
    private func menuLine(_ title: String, icon: AnyView, dim: Bool = false, trailing: String? = nil, height: CGFloat = 48, top: CGFloat = 0, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                HStack(spacing: 12) {
                    icon.foregroundStyle(ink).frame(width: 20, height: 20)
                    Text(title).font(MacSheetInk.sans(17)).foregroundStyle(ink)
                }.opacity(dim ? 0.4 : 1)
                Spacer(minLength: 0)
                // "Soon" / the Finds count as a padded capsule badge (was bare 14 pt text, dimmed to 0.4 with the row)
                if let trailing {
                    Text(trailing).font(MacSheetInk.sans(12, .medium)).foregroundStyle(MacSheetInk.mute).monospacedDigit()
                        .padding(.horizontal, 8).frame(minWidth: 22, minHeight: 22).background(MacSheetInk.chip, in: Capsule())
                }
            }.padding(.leading, 32).padding(.trailing, 24).padding(.top, top).frame(width: 299, height: height).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityIdentifier(id)
    }
    private var permissionPanel: some View {
        ZStack(alignment: .topLeading) {
            UnevenRoundedRectangle(topLeadingRadius: 30, topTrailingRadius: 30).fill(Color(white: 254.0 / 255)).frame(width: 390, height: 551).shadow(color: .black.opacity(0.04), radius: 12.95)
            Capsule().fill(Color(white: 219.0 / 255)).frame(width: 47, height: 5).position(x: 195.5, y: 14.5)
            Text("Allow screen sharing.").font(.custom("KMUTTF-SungkokSemiSerif", size: 28)).foregroundStyle(ink).position(x: 179, y: 69)
            Text("Allow Genita to record your screen in\nSystem Settings, then try sharing again.\nYou can keep talking without sharing.").font(font(16)).foregroundStyle(ink).fixedSize(horizontal: true, vertical: true).frame(width: 320, alignment: .leading).position(x: 201, y: 131)
            MacV2Button(label: "Open Settings", id: "macSharePermissionOpen") { sharing.openSettings() }.frame(width: 313).position(x: 194.5, y: 251)
            Button { sharing.permissionRequired = false } label: { Text("Not now").font(font(15, medium: true)).foregroundStyle(ink).frame(width: 313, height: 36).contentShape(Rectangle()) }.buttonStyle(.plain).position(x: 194.5, y: 307).accessibilityLabel("Not now").accessibilityIdentifier("macSharePermissionNotNow")
        }.frame(width: 390, height: 366, alignment: .topLeading).position(x: 195, y: 661).accessibilityIdentifier("macSharePermission")
    }
}
/// Motion details card 10 on the Mac call window (flag `motionDetails`; off: unchanged).
private struct MacCallVeil: ViewModifier {
    var veiled: Bool
    func body(content: Content) -> some View {
        if MotionDetails.enabled { content.motionCallReveal(veiled: veiled) } else { content }
    }
}

private struct MacControlEntrance: ViewModifier {
    var shown: Bool
    var index: Int
    func body(content: Content) -> some View {
        if MotionDetails.enabled { content.motionControlRise(shown: shown, index: index) } else { content }
    }
}

private struct MacUnchangedControlStyle: ButtonStyle { func makeBody(configuration: Configuration) -> some View { configuration.label } }

private struct MacDemoSystemBar: View {
    var onDark = false
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
                }.colorInvert(onDark).frame(maxWidth: .infinity).frame(height: 22).padding(.trailing, 1).padding(.top, 1)
            }.padding(.horizontal, 24).offset(y: 1)
            RoundedRectangle(cornerRadius: 18).fill(.black).frame(width: 124, height: 36).offset(y: 0.5)
        }.foregroundStyle(onDark ? Color(white: 253.0 / 255) : .black).frame(width: 390, height: 57).position(x: 195, y: 29.5)
    }
}

private extension View {
    @ViewBuilder func colorInvert(_ on: Bool) -> some View { if on { colorInvert() } else { self } }
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
        guard MacHandoff.shared.companionVisible,MacHandoff.shared.motion == nil else{return}
        NSCursor.closedHand.push();defer{NSCursor.pop()}
        window?.performDrag(with:event)
    }
}

/// The call's ground until this account's own face arrives — the same as the iPhone (#524 CompanionFaceView: no still
/// → the dark call ink #111 under the S07 veil): no initial, no silhouette, no new design, and never someone else's face
/// (CL-03). The live face fades in over it with the same veil lift (`genitaFaceReveal`).
struct MacFacePlaceholder: View {
    var body: some View {
        MacSheetInk.ink.accessibilityHidden(true)
    }
}
