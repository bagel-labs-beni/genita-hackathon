import Combine
import ImageIO
import SwiftUI

struct ConversationView: View {
    @Bindable var model: AppState
    var connecting = false
    var handoffEnabled = true
    @ObservedObject private var handoff = PhoneHandoff.shared
    /// Dyno's E01/E02 permission sheets (#2): shown for the call's own denials, and for the review hook.
    @ObservedObject private var media = PhoneHandoff.shared.media
    private var denied: LocalCallMedia.Kind? { media.denied ?? (call.cameraDenied ? .camera : call.micDenied ? .microphone : nil) }
    private let call = CallController.shared
    @State private var moreOpen = false
    /// RP-1 (D37): Report from ⋮ More
    @State private var reportOpen = false
    #if DEBUG
    /// #291 probe for UI tests: how many times ✕ Stop interpreting ran its action (the tap reached the button)
    @State private var debugStopTaps = 0
    /// same probe for ⋮ More (CallScreenUITests: the sheet did not open after a reconnect)
    @State private var debugMoreTaps = 0
    /// taps the face took (call.interrupt) and how often the rail was swapped for the handoff waiting sheet
    @State private var debugFaceTaps = 0
    @State private var debugWaitingSeen = 0
    #endif
    @State private var cameraGuide = false
    @State private var findsTabOpen = false
    @State private var findsList = FindsListModel(api: CallController.shared.findsAPI)
    @State private var loopURL: URL?
    /// card 10: S09 stops waiting for the generated face after 2.5 s (a photo-only companion never gets one)
    @State private var faceWaitOver = false
    /// the wait stage has been up: it stays in the tree through its 300 ms step back after the face arrived
    @State private var waitStageUp = false
    /// Face plan item 1 (flag `CompanionFace.sceneFraming`): the call scene in the face set's crop (server `framing`),
    /// drawn at once under the poster / live face; with it the veil doesn't wait for the face set.
    @State private var framedScene: CGImage?
    @State private var faceArrivedTaps = 0
    #if DEBUG
    @State private var debugWaitHold = ProcessInfo.processInfo.environment["GENITA_WAIT_STAGE"] != nil
    #endif
    /// S09: no picture of the generated face yet (the scene, or the face set's rendered poster / still; a driver
    /// whose first frame isn't drawn doesn't count — Codex P2), and one is still coming: not after the prep failed
    /// (S09-PF, the call goes on as usual), and at most 20 s when nothing is being made or downloaded. Upload photos never count.
    /// DEBUG `GENITA_WAIT_STAGE=hold` keeps it waiting, `=<seconds>` lets the face arrive after that long
    /// (review shots of the wait stage and the arrival on unwired builds).
    private var waitingForFace: Bool {
        #if DEBUG
        if debugWaitHold { return true }
        #endif
        guard !hasFacePicture, !waitGaveUp, model.prep?.isFailed != true else { return false }
        let prepRunning = model.prep.map { !$0.isReady } ?? false
        // a face set request on the wire (17–48 s seen on CI), or a loaded set whose first picture is being drawn (Codex P2);
        // the pauses between failed retries are idle (the 20 s cap applies)
        return prepRunning || call.faceFetching || call.face != nil || !waitCapOver
    }
    /// cheap: `companionImage` decodes the photo on every read, and this is read several times per body pass (that
    /// starved the main thread enough to stall the face set load on CI — testFixtureFaceSetReachesTheCall)
    private var hasFacePicture: Bool {
        model.companionFaceData != nil || !model.serverWired || call.facePoster != nil || call.faceStill != nil || liveFrameDrawn
    }
    /// the live face drew its first frame (it can beat the poster; Codex P2)
    @State private var liveFrameDrawn = false
    /// the wait stage gives up after this long when nothing is being made (a scene or face set that never loads)
    @State private var waitCapOver = false
    /// the wait ended with no picture: it stays ended (the 5 s face retries don't bring the orb back each time; Codex P2)
    @State private var waitGaveUp = false
    @State private var connectedTaps = 0
    @State private var appConfig = GenitaAppConfigStore.shared
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The waiting sheet for R1 and R1-E (#2, Dyno). A running effect covers the change of owner until it ends.
    private var waitingCopy: HandoffCopy? { handoffEnabled && !connecting && handoff.motion == nil ? HandoffCopy.phone(handoff.surface) : nil }
    var body: some View {
        GeometryReader { safe in
            GeometryReader { full in
                let top = safe.safeAreaInsets.top - 44
                let bottom = full.size.height - 844
                // HUD r01 A: the call's chrome on one safe-area grid (menu + status pill on one row, rail + self view on one baseline)
                let grid = CallHUDGrid(size: full.size, safeTop: safe.safeAreaInsets.top, safeBottom: safe.safeAreaInsets.bottom)
                let panelWidth = min(CGFloat(299), full.size.width - 60)
                // F8 INT-1~6: the face stays, the rail and self view give way to the interpretation overlay
                let interpreting = call.mode == .interpret && !connecting
                let sheet = call.finds.state
                // F10 sheet during interpretation (11/2 decision): the sheet can open; while it is up the
                // interpretation bubbles and hold rail are hidden, and they come back when it closes.
                let unclear = !connecting && sheet == .searching && call.finds.current?.isUnclear == true
                let findsOpen = !connecting && sheet != .idle && sheet != .dismissed && !unclear
                let moveLine = !connecting && handoffEnabled && (handoff.moving || handoff.moveFailed)
                let findsPill = call.finds.pillText
                // S09 wait stage: "Getting {name} ready" until the face is here; S09-PREP keeps its own line instead
                let waitingPill: String? = !connecting && waitingForFace && model.callPrepIndicator == nil ? CallCueView.waitingLine(name: call.companionName, rowWidth: grid.rowPillWidth) : nil
                // HUD r01 A: which line the status pill is on, so the prep line, the chip and camera labels stack around it
                let moveShown = moveLine && !findsTabOpen && !interpreting && !unclear
                let statusWidth = moveShown ? CallCueView.pillWidth(text: HandoffMoveStatusLine.text(moving: handoff.moving))
                    : !findsTabOpen && !connecting && !interpreting && !unclear ? CallCueView.width(cue: call.cue, name: call.companionName, findsText: findsPill, rowWidth: grid.rowPillWidth, waitingText: waitingPill) : nil
                let status = Self.statusLine(width: statusWidth, rowWidth: grid.rowPillWidth)
                ZStack(alignment: .topLeading) {
                    ZStack(alignment: .topLeading) {
                        // r03 / PF-1: the call sits on ink — the band above a full sheet (and the edges of a
                        // stepped-back face) are dark, not the window's white
                        CallInk.ink.frame(width: full.size.width, height: full.size.height).accessibilityHidden(true)
                        // F5-U-CAM CAM-H: with the camera on it is the stage, the face becomes a small window
                        // D22: double-tap my view (the camera stage) → front ↔ back
                        if call.cameraOn { CameraStage(call: call, size: full.size, topInset: top, grid: grid,
                                                       statusRect: CameraBoxes.statusRect(grid: grid, line: status, width: statusWidth ?? 0)).blur(radius: unclear ? 8 : 0).transition(.opacity)
                            .onTapGesture(count: 2) { if call.canFlipCamera { call.flipCamera() } } }
                        // F10-U-SHEET r03: the face steps back as the sheet rises (half .814, rising .895) and
                        // becomes a 96 × 128 window when the sheet is full.
                        CompanionFaceView(still: companionImage, loop: loopURL, face: connecting ? nil : call.face, faceStill: call.faceStill, poster: call.facePoster, framedStill: framedScene).frame(width: full.size.width, height: full.size.height).clipped()
                            // S07 veiled → S09 the veil lifts (motion lane); never in the handoff snapshot (ImageRenderer, no onAppear)
                            // motion details card 10: veiled until the generated face (poster or live) is there, then clears
                            // once (blur 14, 520 ms) with one medium tap; flag off → the catalog reveal as before
                            .modifier(CallFaceVeil(connecting: connecting, faceReady: !waitingForFace && (call.facePoster != nil || call.face != nil || framedScene != nil || faceWaitOver), enabled: handoffEnabled))
                            .grayscale(sheetOffline ? 1 : 0).brightness(sheetOffline ? -0.25 : 0).blur(radius: unclear ? 8 : 0)
                            .scaleEffect(faceScale(sheet), anchor: .topLeading).offset(faceOffset(sheet, top: top))
                            .opacity(sheet == .full || call.cameraOn ? 0 : 1)
                            .contentShape(Rectangle()).onTapGesture { faceTapped() }.accessibilityAction(named: "Interrupt") { call.interrupt() }
                            // after the tap gesture: with the camera on, the hidden full-screen face must not take the
                            // touches meant for the camera stage under it (D22 double-tap → back camera never arrived)
                            .allowsHitTesting(!call.cameraOn)
                            .accessibilityIdentifier("companionFace")
                            .animation(.drawer, value: sheet)
                        // S09 wait stage (춘식이 11/4): the orb holds the face's place until the generated face is here,
                        // then steps back (300 ms) while the face clears (card 10). Same place and steps as the face.
                        // out of the tree (not just transparent) while the face is the small window: the live orb
                        // would keep drawing at 60 fps unseen (Codex P3); the small windows carry their own orb
                        if !connecting && (waitingForFace || waitStageUp) && sheet != .full && !call.cameraOn {
                            CallWaitStage(size: full.size, leaving: !waitingForFace)
                                .scaleEffect(faceScale(sheet), anchor: .topLeading).offset(faceOffset(sheet, top: top))
                                .animation(.drawer, value: sheet)
                                .transition(.opacity)
                        }
                        if waitingCopy != nil { handoffScrim.frame(width: full.size.width, height: full.size.height).allowsHitTesting(false) }
                        Button { withAnimation(.easeInOut(duration: 0.22)) { model.menuOpen.toggle() } } label: {
                            CallGlassControl(icon: "glass-menu-icon", size: CallHUDGrid.button)
                        }.buttonStyle(.plain).disabled(connecting).modifier(CallControlEntrance(shown: !connecting, index: 0)).position(grid.menuCenter)
                            .accessibilityLabel(connecting ? "Menu unavailable while connecting" : "Open menu").accessibilityIdentifier(connecting ? "openMenuConnecting" : "openMenu")
                            .opacity(sheet == .full ? 0 : 1).accessibilityHidden(sheet == .full)
                        if call.cameraOn && sheet != .full {
                            // r01 CAM-H `.pip`: right 20, top 120, 96 × 128, 2 px light border; moves left while the sheet is half up (the rail rises into its place)
                            // the camera's small window is the live, talking face too (Chelsea P1, build 7: a frozen upload photo)
                            CompanionFaceView(still: companionImage, loop: loopURL, face: call.face, faceStill: call.faceStill, poster: call.facePoster, framedStill: framedScene).frame(width: 96, height: 128)
                                .overlay { if waitingForFace { CallWaitStage(size: CGSize(width: 96, height: 128)) } }.clipShape(RoundedRectangle(cornerRadius: 16))
                                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(CallInk.onInk, lineWidth: 2)).shadow(color: CallInk.ink.opacity(0.18), radius: 12, y: 8)
                                .position(x: sheet == .half || sheet == .rising ? 68 : full.size.width - 68, y: 184 + top)
                                .onTapGesture { faceTapped() }.accessibilityLabel("\(call.companionName)")
                                .accessibilityValue(CompanionFaceView.layer(face: call.face != nil, poster: call.facePoster != nil, still: companionImage != nil))
                                .accessibilityIdentifier("cameraPip")
                        }
                        if call.cameraOn, !connecting, let check = call.finds.noSee, sheet == .idle || sheet == .dismissed {
                            // FT-NOSEE (Figma 59:2): left 24, top 124; never over a sheet
                            NoSeeCard(check: check) { withAnimation(.fade) { call.finds.dismissNoSee() } }.offset(x: 24, y: 124 + top).transition(.opacity)
                        }
                        if waitingCopy == nil {
                        if interpreting {
                            if !findsOpen {
                                InterpretOverlay(board: call.interpretBoard, top: top, level: { call.inputLevel }, onClose: { debugNoteStop(); call.setInterpreting(false) }, onHold: { call.setHold($0) })
                                    .frame(width: full.size.width, height: full.size.height)
                                    .transition(.opacity)
                            }
                        } else {
                        ZStack(alignment: .topLeading) {
                            if !call.cameraOn {
                                let selfScale: CGFloat = sheet == .half || sheet == .rising ? 0.5 : 1
                                selfView.scaleEffect(selfScale)
                                    .position(grid.selfCenter(lift: selfLift(sheet), scale: selfScale, sheetUp: CallHUDGrid.sheetUp(sheet)))
                                    .opacity(sheet == .full ? 0 : 1).animation(.drawer, value: sheet)
                                    // camera on: the tile gives way to the camera stage (Reduce Motion: fade only)
                                    .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
                            }
                        }.frame(width: full.size.width, height: full.size.height)
                            .animation(reduceMotion || CallMotion.reviewStill ? .easeOut(duration: 0.2) : .spring(response: 0.4, dampingFraction: 0.85), value: call.cameraOn)
                        Button { cameraTapped() } label: { CallToggleGlass(icon: "glass-camera-icon", on: call.cameraOn) }
                            .buttonStyle(PreviewControlStyle()).disabled(connecting).modifier(CallControlEntrance(shown: !connecting, index: 1)).accessibilityLabel(call.cameraOn ? "Turn camera off" : "Turn camera on").accessibilityIdentifier("cameraToggle").position(x: grid.railX, y: grid.railY(.camera, sheetUp: CallHUDGrid.sheetUp(sheet)) + railShift(sheet))
                            .opacity(sheet == .full ? 0 : 1).accessibilityHidden(sheet == .full).animation(.drawer, value: sheet)
                        // motion details card 2: pressed to 0.92, a light tap on toggle, a blue ring that follows the user's voice
                        Button { call.toggleMic() } label: {
                            CallToggleGlass(icon: "glass-mic-icon", on: call.micOn)
                                .background { MotionVoiceRing(active: call.micOn && !connecting, diameter: CallHUDGrid.button, color: CallInk.blueOnInk, level: { call.inputLevel }) }
                        }
                            .buttonStyle(MotionPressStyle()).disabled(connecting).modifier(CallControlEntrance(shown: !connecting, index: 2))
                            .sensoryFeedback(trigger: call.micOn) { _, _ in MotionDetails.live(reduceMotion: reduceMotion) ? .impact(weight: .light) : nil }.accessibilityLabel(call.micOn ? "Turn microphone off" : "Turn microphone on").accessibilityIdentifier("micToggle").position(x: grid.railX, y: grid.railY(.mic, sheetUp: CallHUDGrid.sheetUp(sheet)) + railShift(sheet))
                            .opacity(sheet == .full ? 0 : 1).accessibilityHidden(sheet == .full).animation(.drawer, value: sheet)
                        Button { debugNoteMore(); withAnimation(.easeOut(duration: 0.22)) { moreOpen = true } } label: { CallGlassControl(icon: "glass-more-icon", size: CallHUDGrid.button) }
                            .buttonStyle(PreviewControlStyle()).disabled(connecting).modifier(CallControlEntrance(shown: !connecting, index: 3)).accessibilityLabel("More").accessibilityIdentifier("more").position(x: grid.railX, y: grid.railY(.more, sheetUp: CallHUDGrid.sheetUp(sheet)) + railShift(sheet))
                            .opacity(sheet == .full ? 0 : 1).accessibilityHidden(sheet == .full).animation(.drawer, value: sheet)
                        }
                        if findsTabOpen && !connecting {
                            FindsTabView(call: call, list: findsList, top: top) { closeFindsTab() }.frame(width: full.size.width, height: full.size.height).transition(.move(edge: .trailing))
                        }
                        if unclear {
                            // IC-4 (features r01): a dark card over the blurred picture, 24 / 124, 310 wide, one button
                            FindUnclearCard(call: call).position(x: full.size.width / 2, y: 124 + top + 74)
                                .transition(.opacity)
                        }
                        if findsOpen {
                            FindsSheet(call: call, size: full.size, talk: { closeFindsTab() }, openFinds: { openFindsTab() }).frame(width: full.size.width, height: full.size.height, alignment: .top)
                                .transition(.move(edge: .bottom))
                        }
                        if sheet == .full {
                            // r03 `.pip`: the face as a 96 × 128 window; tap → back to half
                            Button { withAnimation(.drawer) { call.finds.pipTapped() } } label: {
                                CompanionFaceView(still: companionImage, loop: loopURL, face: call.face, faceStill: call.faceStill, poster: call.facePoster, framedStill: framedScene).frame(width: 96, height: 128)
                                .overlay { if waitingForFace { CallWaitStage(size: CGSize(width: 96, height: 128)) } }.clipShape(RoundedRectangle(cornerRadius: 16))
                                    .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(CallInk.onInk, lineWidth: 2)).shadow(color: CallInk.ink.opacity(0.18), radius: 12, y: 8)
                            }.buttonStyle(PressScale()).position(x: full.size.width - 64, y: 112 + top)
                                .accessibilityLabel("Back to half height").accessibilityIdentifier("findsPip").transition(.opacity)
                        }
                        if sheet == .dismissed {
                            FindsToast(finds: call.finds).position(x: full.size.width / 2, y: 210 + top).genitaToastTransition()
                        }
                        // The call cue belongs to S09. Keep it below the Finds tab so it cannot cover that
                        // screen's title or subtitle; closing Finds immediately resumes the current call cue.
                        if moveLine && !findsTabOpen && !interpreting && !unclear {
                            // MV-1 / MV-E take the call's status line slot
                            HandoffMoveStatusLine().position(x: grid.pillCenter.x, y: grid.statusY(status))
                        } else if !findsTabOpen && !connecting && !interpreting && !unclear {
                            CallCueView(cue: call.cue, name: call.companionName, findsText: findsPill, waitingText: waitingPill, retry: call.retryAnswer, openSettings: openAppSettings, rowWidth: grid.rowPillWidth, level: { call.outputLevel })
                                .frame(width: sheet == .full ? 250 : full.size.width - 2 * CallHUDGrid.margin, alignment: sheet == .full ? .leading : .center)
                                // HUD r01 A: on the menu row (same centre line) when it fits between the menu button and its
                                // mirror, else centred on the line just under it; beside the face window when the sheet is full.
                                .position(x: sheet == .full ? 16 + 125 : grid.pillCenter.x, y: sheet == .full ? 82 + top : grid.statusY(status))
                                // and the call cue steps aside once the Finds sheet is half up or more (200 ms)
                                .opacity(Self.cueHidden(sheet: sheet, findsLine: findsPill != nil, cue: call.cue) ? 0 : 1)
                                .accessibilityHidden(Self.cueHidden(sheet: sheet, findsLine: findsPill != nil, cue: call.cue))
                                .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: Self.cueHidden(sheet: sheet, findsLine: findsPill != nil, cue: call.cue))
                        }
                        // CC-1 wins over GK-1 (a "Noted: …" answers the question)
                        // not over the Finds tab (its back button and title sit on the menu row)
                        if !connecting && !findsTabOpen, let chip = call.profileChip ?? call.askingChip {
                            ProfileChipView(text: chip, soft: call.profileChip == nil).id(call.profileChip == nil ? chip : "\(chip)#\(call.profileChipSerial)")
                                .frame(width: sheet == .full ? 250 : full.size.width - 2 * CallHUDGrid.margin, alignment: sheet == .full ? .leading : .center)
                                .position(x: sheet == .full ? 16 + 125 : full.size.width / 2,
                                          y: sheet == .full ? 122 + top : grid.chipCenterY(status: status, prepLine: model.callPrepIndicator != nil && !interpreting && !moveLine && !findsTabOpen && sheet != .full,
                                                                                         fitsRow: ProfileChipView.width(chip, soft: call.profileChip == nil) <= grid.rowPillWidth,
                                                                                         prepFitsRow: model.callPrepIndicator.map { CallPrepLine.width($0) <= grid.rowPillWidth } ?? true))
                        }
                        // S09-PREP (228:543): the face is still being made while the call runs (S09-P, D28)
                        // never over the Finds tab (its title sits on the menu row and the line under it — Codex P2)
                        if !connecting && !interpreting && !moveLine && !findsTabOpen && sheet != .full, let line = model.callPrepIndicator {
                            CallPrepLine(text: line).position(x: full.size.width / 2, y: grid.prepLineCenterY(status: status, fitsRow: CallPrepLine.width(line) <= grid.rowPillWidth)).transition(.opacity)
                        }
                        }
                        if connecting {
                            let label = DesignLibrary.nodes("connecting").first { $0.type == "text" && ($0.characters ?? "").hasPrefix("Connecting") }!
                            ZStack {
                                connectingSurface
                                DesignText(node: label, text: "Connecting to \(model.companionDisplayName)…").frame(width: lineWidth(for: label), height: label.h)
                            }.frame(width: max(175, lineWidth(for: label) + 40), height: 36).shadow(color: .black.opacity(0.15), radius: 4, y: 4).position(x: full.size.width / 2 + 0.5, y: grid.rowY).accessibilityIdentifier("connectingPill")
                        }
                        if let waitingCopy {
                            VStack(spacing: 0) { Spacer(minLength: 0); HandoffWaitingSheet(copy: waitingCopy) { handoff.continueHere() } }
                                .frame(width: full.size.width, height: full.size.height).transition(.move(edge: .bottom))
                        }
                        if let denied, waitingCopy == nil {
                            handoffScrim.opacity(0.5).frame(width: full.size.width, height: full.size.height).onTapGesture { dismissDenied() }
                            VStack(spacing: 0) {
                                Spacer(minLength: 0)
                                MediaPermissionSheet(kind: denied, name: call.companionName, openSettings: { media.openSystemSettings(for: denied) }, dismiss: { dismissDenied() })
                            }.frame(width: full.size.width, height: full.size.height).transition(.move(edge: .bottom))
                        }
                        if moreOpen {
                            CallInk.dim.frame(width: full.size.width, height: full.size.height).onTapGesture { withAnimation(.easeOut(duration: 0.22)) { moreOpen = false } }
                                .accessibilityLabel("Close More").accessibilityAddTraits(.isButton).accessibilityIdentifier("closeMore")
                            VStack(spacing: 0) {
                                Spacer(minLength: 0)
                                // #180: Move to Mac runs the move (unpaired → the P01 pairing sheet)
                                CallMoreSheet(call: call, textChatEnabled: appConfig.config.flag("textChat", default: false), moveToMacSubtitle: handoff.link.connected ? "Connected to your Mac" : "Pair with your Mac", moveToMac: { handoff.moveToMac() },
                                              openFinds: { openFindsTab() }, report: { reportOpen = true }) {
                                    withAnimation(.easeOut(duration: 0.22)) { moreOpen = false }
                                }
                            }.frame(width: full.size.width, height: full.size.height).transition(.move(edge: .bottom))
                        }
                    }.frame(width: full.size.width, height: full.size.height).offset(x: model.menuOpen ? panelWidth : 0)
                    if cameraGuide && !connecting {
                        CameraGuideSheet(bottomInset: max(0, bottom), turnOn: { CameraGuide.seen = true; withAnimation(.drawer) { cameraGuide = false }; call.toggleCamera() },
                                         notNow: { withAnimation(.drawer) { cameraGuide = false } })
                            .frame(width: full.size.width, height: full.size.height).transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                    if model.menuOpen {
                        Color(white: 0.996).frame(width: panelWidth, height: full.size.height)
                        let title = DesignLibrary.nodes("menu").first { $0.characters == "Genita" }!
                        DesignText(node: title).frame(width: title.w, height: title.h).position(x: title.x + title.w / 2, y: title.y + top + title.h / 2)
                        menuRow("Chat", icon: "reference-menu-chat", y: 118, width: panelWidth, top: top) { withAnimation { model.menuOpen = false } }.accessibilityIdentifier("returnConversation")
                        menuRow("Setting", text: "Finds", symbol: "bookmark", badge: findsList.count > 0 ? "\(findsList.count)" : nil, y: 165, width: panelWidth, top: top) { openFindsTab() }.accessibilityIdentifier("menuFinds")
                        menuRow("Setting", text: "Settings", icon: "reference-menu-settings", y: 212, width: panelWidth, top: top) { model.menuOpen = false; model.settingsOpen = true }.accessibilityIdentifier("settings")
                        if waitingCopy == nil && handoffEnabled {
                            moveToMacRow(y: 259, width: panelWidth, top: top) { withAnimation { model.menuOpen = false }; handoff.moveToMac() }.accessibilityIdentifier("moveToMac")
                        }
                        Button { withAnimation { model.menuOpen = false } } label: { Color.clear.contentShape(Rectangle()) }
                            .frame(width: full.size.width - panelWidth, height: full.size.height).position(x: panelWidth + (full.size.width - panelWidth) / 2, y: full.size.height / 2).buttonStyle(.plain).accessibilityLabel("Close menu")
                    }
                }.frame(width: full.size.width, height: full.size.height).clipped()
            }.ignoresSafeArea()
        }.opacity(handoffEnabled && handoff.motionVisible ? 0 : 1)
        // CRASH-1: while the pairing sheet is up, the call under it (⋮, Interpret, the rail) takes no touches
        .allowsHitTesting(!(handoffEnabled && handoff.settings))
        .accessibilityHidden(handoffEnabled && handoff.settings)
        .overlay { if handoffEnabled && !connecting { PhoneHandoffOverlay(model:model) } }
        #if DEBUG
        // face pipeline probe for UI tests (why S09 shows the still): shows / attempts / loading / face / poster / error
        .overlay(alignment: .bottomLeading) {
            Text(call.faceDebug).font(.system(size: 2)).opacity(0.02).allowsHitTesting(false).accessibilityIdentifier("faceDebug")
        }
        // #291 probe (DEBUG builds only, never in TestFlight): taps that reached ✕ and the call's mode right now
        .overlay(alignment: .bottomLeading) {
            Text("stop:\(debugStopTaps) mode:\(call.mode == .interpret ? "interpret" : "chat") more:\(debugMoreTaps) moreOpen:\(moreOpen) link:\(String(describing: call.link)) face:\(debugFaceTaps) waiting:\(debugWaitingSeen) surface:\(String(describing: handoff.surface))").font(.system(size: 2)).opacity(0.02)
                .allowsHitTesting(false).accessibilityIdentifier("debugInterpretProbe")
                .onChange(of: waitingCopy != nil) { _, on in if on { debugWaitingSeen += 1 } }
        }
        #endif
        // L4: the Meta face animates only while the call screen is up and the app is active (UI review: one frame)
        // S07: fetch the face set while connecting, so S09 opens on the generated face (build 6: upload photo ~4 s, then a jump)
        .onAppear { if connecting { call.prepareFace(reduceMotion: reduceMotion || CallMotion.reviewStill) } else { showFace() } }
        .onDisappear { if !connecting { call.hideFace() } }
        .onChange(of: scenePhase) { _, phase in if !connecting { if phase == .active { showFace() } else { call.hideFace() } } }
        .onChange(of: reduceMotion) { _, on in call.setFaceReduceMotion(on || CallMotion.reviewStill) }
        .onChange(of: handoff.surface) { _, surface in let onMac = surface != .active; if !connecting { if onMac { call.hideFace() } else if scenePhase == .active { showFace() } } }
        .sheet(isPresented: $model.settingsOpen) { SettingsView(model: model) }
        .reportFlow(isPresented: $reportOpen, surface: "call", auth: model.onboarding.auth) { call.lastReplyText }
        .task(id: model.setup.imageData) { loopURL = model.companionLoopURL }
        // card 10: one medium tap when this call first goes live (not on a cached face alone, not on reconnects)
        .sensoryFeedback(trigger: connectedTaps) { _, _ in MotionDetails.live(reduceMotion: reduceMotion) ? .impact(weight: .medium) : nil }
        .onChange(of: call.link == .live, initial: true) { _, live in if live && !connecting && !waitingForFace && connectedTaps == 0 { connectedTaps = 1 } }
        // wait stage → face: the orb steps back for 300 ms, the pill turns to the live cue, one medium tap
        .onChange(of: waitingForFace, initial: true) { was, now in
            if now { waitStageUp = true; return }
            guard was, !connecting else { waitStageUp = false; return }
            // the arrival is card 10's moment: its one tap moves here when the face came after the call went live
            // (the wait gave up with no picture: only the live tap it held back)
            if !hasFacePicture { if connectedTaps == 0, call.link == .live { connectedTaps = 1 } }
            // before the link is live the arrival taps on its own and card 10's live tap stays for the link (Codex P3)
            else if connectedTaps == 0, call.link == .live { connectedTaps = 1 } else { faceArrivedTaps += 1 }
            // still over after the step back (not a blink while prep turns ready and the idle cap restarts): it gave up
            Task {
                try? await Task.sleep(for: .milliseconds(320))
                guard !waitingForFace else { return }
                waitStageUp = false
                if !hasFacePicture { waitGaveUp = true }
            }
        }
        // face plan item 1: draw the scene in the poster's crop (off the main thread) as soon as scene + framing are here
        .task(id: framedSceneID) {
            guard CompanionFace.sceneFraming, let data = model.sceneImageData, let framing = model.prep?.framing else { framedScene = nil; return }
            let rm = reduceMotion || CallMotion.reviewStill
            let image = await Task.detached(priority: .userInitiated) { () -> CGImage? in
                guard let src = CGImageSourceCreateWithData(data as CFData, nil),
                      let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
                      let w = props[kCGImagePropertyPixelWidth] as? CGFloat, let h = props[kCGImagePropertyPixelHeight] as? CGFloat else { return nil }
                return FaceRenderer.framedScene(data: data, outputSize: CompanionFace.outputSize(still: CGSize(width: w, height: h)), framing: framing, reduceMotion: rm)
            }.value
            if !Task.isCancelled { framedScene = image }
        }
        #if DEBUG
        .task(id: connecting) {
            guard !connecting, let s = ProcessInfo.processInfo.environment["GENITA_WAIT_STAGE"].flatMap(Double.init) else { return }
            try? await Task.sleep(for: .seconds(s))
            if !Task.isCancelled { debugWaitHold = false }
        }
        #endif
        .task(id: call.face.map(ObjectIdentifier.init)) {
            liveFrameDrawn = false
            guard let face = call.face else { return }
            for await frame in face.$frame.values where frame != nil { liveFrameDrawn = true; break }
        }
        .sensoryFeedback(trigger: faceArrivedTaps) { _, _ in MotionDetails.live(reduceMotion: reduceMotion) ? .impact(weight: .medium) : nil }
        // the idle cap starts again when prep moves on (running → ready brings a scene and a face set request; Codex P2)
        .task(id: "\(connecting) \(model.prep?.status ?? "")") {
            guard !connecting else { return }
            waitCapOver = false
            try? await Task.sleep(for: .seconds(20))
            if !Task.isCancelled { waitCapOver = true }
        }
        .task(id: connecting) {
            guard !connecting, !faceWaitOver else { return }
            try? await Task.sleep(for: .seconds(2.5))
            if !Task.isCancelled { faceWaitOver = true }
        }
        // the prep call scene is the still under the face (also after a relaunch, when PREP-1 didn't load it)
        // keyed on ready too: followPrep no longer waits on the scene in the call, so a scene that failed while prep
        // ran is tried again when it turns ready; a view task, so it ends with the screen (Start over; Codex P2 x2)
        .task(id: "\(model.prep?.sceneURL?.absoluteString ?? "") \(model.prep?.isReady == true)") { await model.loadScene() }
        // S09-P (D28): the face is still being made while the call runs; keep `model.prep` fresh so the in-call
        // indicator (`model.callPrepIndicator`, S09-PREP 228:543) follows scene → expressions → mouth.
        // keyed on the status too: a PREP-1e Try again answered after the call started (failed → running) polls again
        .task(id: "\(connecting) \(model.prep?.status ?? "")") { if !connecting { await model.followPrep(every: 5, sceneFirst: false) } }
        // AU-25 (D28 reveal): prep finished mid-call → fetch the face set now (the call's own retry is the fallback)
        .onChange(of: model.prep?.isReady == true) { _, ready in
            // face plan item 3: a load waiting out its 5 s retry asks again now
            if ready { call.faceSetReady() }
            if ready && !connecting && scenePhase == .active { showFace() }
        }
        .onAppear {
            if !connecting {
                call.companionName = model.companionDisplayName
                call.onCompanionNamed = { [model] name in model.setup.companionName = name }
                call.begin(model.callStart)
                model.setup.firstCallPending = false
                #if DEBUG
                call.installFindsFixture()
                call.installProfileChipFixture()
                installFindsTabFixture()
                #endif
            }
        }
        .onDisappear { if !connecting { call.end(); keepScreenAwake(false) } }
        .onAppear { if !connecting { keepScreenAwake(scenePhase == .active) } }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: CallBackgroundTime.end(); call.sceneActivityChanged(.active); callBack()
            case .inactive: call.sceneActivityChanged(.inactive)
            case .background: call.sceneActivityChanged(.background); holdForGrace()
            @unknown default: call.sceneActivityChanged(.background); holdForGrace()
            }
            if !connecting { keepScreenAwake(phase == .active) }
        }
        // swipe-kill from the foreground (RV-01): the last chance to say `stop`
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willTerminateNotification)) { _ in if !connecting { call.end() } }
        // #2: the conversation moved to the Mac (R1 waiting sheet): this iPhone stops listening and showing
        .onChange(of: handoff.surface) { _, surface in if surface != .active { call.suspend() } }
        // F1-L7: 4401 → A02 sign in, 4403 → CS01 consent (CallController.stopped)
        .onChange(of: call.stopped) { _, stop in model.route(stop) }
    }
    /// AU-38 / IC-02 step 4: Home or lock pauses the call for its grace (CallController.backgroundGraceMs). The app has
    /// no audio background mode, so a background task keeps it running that long; then the call hangs up with `stop`
    /// (or sooner, if iOS takes the time back). A swipe-kill ends it through `willTerminate`.
    private func holdForGrace() {
        guard !connecting, call.inBackgroundGrace else { return }
        let call = call
        CallBackgroundTime.begin(seconds: Double(CallController.backgroundGraceMs) / 1000 + 2) { call.end() }
    }
    /// IC-02 step 4 "돌아오면 재연결": back after the grace ran out (the call hung up), the call screen calls again —
    /// a new call that greets, mic as the user left it (B12). Back within the grace, the paused call resumes itself.
    /// Not after the server stopped the call (sign-in, consent, time limit route elsewhere).
    private func callBack() {
        guard !connecting, call.isEnded, call.stopped == nil else { return }
        call.begin(model.callStart)
    }
    /// AU-39: Auto-Lock must not end a hands-free call; only while this call screen is up and the app is active.
    private func keepScreenAwake(_ on: Bool) { UIApplication.shared.isIdleTimerDisabled = on }
    /// Not while the conversation is on the Mac (this screen is hidden then).
    private func showFace() {
        guard !(handoffEnabled && handoff.surface != .active) else { return }
        call.showFace(reduceMotion: reduceMotion || CallMotion.reviewStill, animate: !CallMotion.reviewStill)
    }
    /// S07 pill grows for a long {name} (NM01 allows 20 characters); "Connecting to Jin…" keeps the board's 175 pt.
    private func lineWidth(for label: DesignNode) -> CGFloat {
        let line = "Connecting to \(model.companionDisplayName)…"
        return max(label.w, ceil((line as NSString).size(withAttributes: [.font: label.font]).width) + 2)
    }
    private func debugNoteMore() {
        #if DEBUG
        debugMoreTaps += 1
        #endif
    }
    private func debugNoteStop() {
        #if DEBUG
        debugStopTaps += 1
        #endif
    }
    private var sheetOffline: Bool { call.finds.state != .idle && (call.link == .reconnecting || call.finds.offline) }

    /// CAM-1: the first time the camera is asked for, say what it does before the system prompt. Turning it off needs no guide.
    private func cameraTapped() {
        if !call.cameraOn && !CameraGuide.seen { withAnimation(.drawer) { cameraGuide = true } } else { call.toggleCamera() }
    }

    /// Face tap: with the sheet up it folds the sheet (r03 "얼굴 누르기 → 접힘"); otherwise it interrupts.
    private func faceTapped() {
        #if DEBUG
        debugFaceTaps += 1
        #endif
        if withAnimation(.drawer, { call.finds.faceTapped() }) { return }
        call.interrupt()
    }
    private func faceScale(_ s: SheetState) -> CGFloat { s == .half ? 0.814 : s == .rising ? 0.895 : 1 }
    private func faceOffset(_ s: SheetState, top: CGFloat) -> CGSize {
        s == .half ? CGSize(width: 43.1, height: -66) : s == .rising ? CGSize(width: 24.2, height: -37.1) : .zero
    }
    /// r03 `.self` from the sheet baseline (806 + H − 844): half → half size with its bottom where the old box's was
    /// (300.5 + H − 844: 806 − 48 − 481.5 + 24); peek/searching → up 122.
    private func selfLift(_ s: SheetState) -> CGFloat {
        switch s {
        case .half, .rising: -481.5
        case .peek, .searching: -122
        default: 0
        }
    }
    /// HUD r01 A: which line the status pill is on (CallHUDGrid.StatusLine), from what it shows.
    /// Measured, not counted: a pill no wider than the row's room stays on the row; wider ones (a cue with a button,
    /// a long Finds line, MV-E) take the second line. Plain "{name} is …" cues shorten instead (CallCueView.nameLine).
    static func statusLine(width: CGFloat?, rowWidth: CGFloat) -> CallHUDGrid.StatusLine {
        guard let width else { return .none }
        return width <= rowWidth ? .row : .second
    }
    /// HUD r01 A: the call cue fades out once the sheet is half up or more. A Finds line (PF-1) and the problem cues
    /// (reconnecting, no answer, mic off) stay: they are what the sheet is about, or something to act on.
    static func cueHidden(sheet: SheetState, findsLine: Bool, cue: CallCue) -> Bool {
        guard sheet == .half || sheet == .rising || sheet == .full, !findsLine else { return false }
        switch cue {
        case .reconnecting, .answerFailed, .micBlocked: return false
        default: return true
        }
    }
    /// r03 `.rail`: half → up 440, peek/searching → up 122, full → hidden behind the sheet.
    private func railShift(_ s: SheetState) -> CGFloat { CameraBoxes.railShift(s) }

    func dismissDenied() { media.denied = nil; call.dismissDenied() }
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
    /// Drawer rows sit on a 47 pt pitch (y 118 / 165 / 212 / 259) and are 44 pt tall: each row's hit area takes half
    /// the 3 pt gap on both sides, so the rows tile the column with no dead strip and no overlap (MOVE-2).
    static let menuRowPitch: CGFloat = 47
    static let menuRowHitShape = Rectangle().inset(by: -(menuRowPitch - 44) / 2)
    func menuRow(_ title: String, text: String? = nil, icon: String = "", symbol: String? = nil, badge: String? = nil, y: CGFloat, width: CGFloat, top: CGFloat, action: @escaping () -> Void) -> some View {
        let label = DesignLibrary.nodes("menu").first { $0.characters == title }!
        return Button(action: action) {
            ZStack(alignment: .topLeading) {
                Color.clear
                if let symbol { Image(systemName: symbol).font(.system(size: 18, weight: .regular)).foregroundStyle(CallInk.ink).frame(width: 21, height: 21).position(x: 20, y: 22) }
                else { Image(resource: icon).resizable().frame(width: title == "Chat" ? 20.7 : 21.7007, height: 20.7).position(x: 20, y: 22) }
                // "Settings" is wider than the Figma "Setting" node: room to 140 pt, as Move to Mac
                let w = max(label.w, 140)
                DesignText(node: label, text: text ?? label.characters).frame(width: w, height: label.h).position(x: label.x - 24 + w / 2, y: 22)
                if let badge { Text(badge).font(TypeStyle.body(14)).foregroundStyle(CallInk.mute).position(x: width - 48 - 12, y: 22) }
            }.frame(width: width - 48, height: 44).contentShape(Self.menuRowHitShape)
        }.buttonStyle(.plain).position(x: width / 2, y: y + 22 + top).accessibilityLabel(text ?? title)
    }

    #if DEBUG
    /// Screenshots of the Finds tab without a server: GENITA_FINDS_TAB = list | empty | detail (recorded cards).
    func installFindsTabFixture() {
        let configured = ProcessInfo.processInfo.environment["GENITA_FINDS_TAB"]
        // Appetize preview: Finds always reads the recorded cards (the demo has no account), the tab opens by itself only when asked
        guard let mode = configured ?? (BrowserPreview.isActive ? "list" : nil) else { return }
        let recorded = FixtureFindsAPI.recorded()
        findsList.api = FixtureFindsAPI(cards: mode == "empty" ? [] : recorded.cards)
        findsList.frames = { recorded.frames[$0] ?? [] }
        findsList.purge = { _ in }
        guard configured != nil else { return }
        Task { @MainActor in
            for _ in 0..<80 where call.link != .live { try? await Task.sleep(for: .milliseconds(100)) }
            try? await Task.sleep(for: .milliseconds(300))
            openFindsTab()
            if mode == "detail" {
                await findsList.load()
                if let first = findsList.cards.first(where: { $0.saved == true }) {
                    try? await Task.sleep(for: .milliseconds(400))
                    withAnimation(.drawer) { call.finds.openSaved(first, frames: findsList.frames(first.id)) }
                }
            }
        }
    }
    #endif

    /// M01 Finds / ⋮ Finds → the list. The in-call sheet folds away so the list is not covered.
    func openFindsTab() {
        call.finds.state = .idle
        withAnimation(.easeInOut(duration: 0.22)) { model.menuOpen = false; moreOpen = false; findsTabOpen = true }
    }
    func closeFindsTab() {
        withAnimation(.easeInOut(duration: 0.22)) { findsTabOpen = false }
    }
    /// Same row as the design's menu rows. The Figma menu has no Move to Mac row yet, so it borrows Chat's text style.
    func moveToMacRow(y: CGFloat, width: CGFloat, top: CGFloat, action: @escaping () -> Void) -> some View {
        let label = DesignLibrary.nodes("menu").first { $0.characters == "Chat" }!
        return Button(action: action) {
            ZStack(alignment: .topLeading) {
                Color.clear
                Image(systemName: "laptopcomputer").symbolRenderingMode(.monochrome).font(.system(size: 16)).foregroundStyle(Color(white: 17.0 / 255)).frame(width: 24, height: 21).position(x: 20, y: 22)
                DesignText(node: label, text: "Move to Mac").frame(width: 140, height: label.h).position(x: label.x - 24 + 70, y: 22)
            }.frame(width: width - 48, height: 44).contentShape(Self.menuRowHitShape)
        }.buttonStyle(.plain).position(x: width / 2, y: y + 22 + top).accessibilityLabel("Move to Mac")
    }
    /// Self view: the call's front camera when on (one owner: CallController), Dyno's flip button, the placeholder when off.
    @ViewBuilder var selfView: some View {
        if call.cameraOn {
            ZStack(alignment: .bottomLeading) {
                SelfCameraView(session: call.cameraSession).frame(width: 113, height: 211).background(CallInk.ink)
                if call.canFlipCamera {
                    Button { call.flipCamera() } label: {
                        Image(systemName: "arrow.triangle.2.circlepath").font(.system(size: 15)).foregroundStyle(.white).frame(width: 44, height: 44).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityLabel("Flip camera").accessibilityIdentifier("flipCamera")
                }
            }.frame(width: 113, height: 211).clipShape(RoundedRectangle(cornerRadius: 16)).accessibilityElement(children: .contain).accessibilityLabel("Your camera")
        } else {
            // HUD r01 A: camera off = a small glass tile (72 × 96), not the old 113 × 211 dark box
            let shape = RoundedRectangle(cornerRadius: 16)
            ZStack {
                shape.fill(.ultraThinMaterial).environment(\.colorScheme, .dark)
                shape.fill(Color.black.opacity(0.28))
                Image(systemName: "video.slash").font(.system(size: 18, weight: .regular)).foregroundStyle(Color.white.opacity(0.7))
            }
            .overlay(shape.strokeBorder(Color.white.opacity(0.35), lineWidth: 0.7))
            .frame(width: CallHUDGrid.selfOff.width, height: CallHUDGrid.selfOff.height)
            .accessibilityElement().accessibilityLabel("Your camera is off").accessibilityIdentifier("selfViewOff")
            // D22: double-tap the self view → the camera on, facing back
            .onTapGesture(count: 2) { call.useBackCamera() }.accessibilityAction(named: "Use back camera") { call.useBackCamera() }
        }
    }
    /// What the framed scene is drawn from: the scene bytes, the server's crop and the overscan (reduce motion).
    private var framedSceneID: String {
        let d = model.sceneImageData
        return "\(model.sceneKey ?? "-")|\(d?.count ?? -1)|\(d?.hashValue ?? 0)|\(String(describing: model.prep?.framing))|\(reduceMotion || CallMotion.reviewStill)"
    }
    /// The still under the face: the prep call scene (the generated face, same framing as the face set). The upload
    /// photo never shows on a call (Chelsea P1, build 7); until the scene or the face set lands it's the dark ground.
    /// Unwired builds (UI tests, Appetize preview) keep their bundled fixture face.
    var companionImage: Image? {
        if let data = model.companionFaceData, let image = UIImage(data: data) { return Image(uiImage: image) }
        return model.serverWired ? nil : Image(resource: "companion")
    }
}

/// Motion details card 10 with the flag on (veil until the face is ready), the catalog face reveal with it off.
private struct CallFaceVeil: ViewModifier {
    var connecting: Bool
    var faceReady: Bool
    var enabled: Bool
    func body(content: Content) -> some View {
        if MotionDetails.enabled {
            content.motionCallReveal(veiled: connecting || !faceReady, enabled: enabled)
        } else {
            content.genitaFaceReveal(veiled: connecting, enabled: enabled)
        }
    }
}

/// Motion details card 10: S07 keeps the controls back; they rise in 40 ms apart once connected. Flag off: as before.
private struct CallControlEntrance: ViewModifier {
    var shown: Bool
    var index: Int
    func body(content: Content) -> some View {
        if MotionDetails.enabled { content.motionControlRise(shown: shown, index: index) } else { content }
    }
}

private struct PreviewControlStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { configuration.label }
}

struct CallGlassControl: View {
    let icon: String
    var size: CGFloat
    var slashed = false
    /// mic / camera off: the SF Symbols slash glyph instead of the bitmap (GlassGlyph.offSymbol)
    var off = false
    var body: some View {
        ZStack {
            if #available(iOS 26.0, *) {
                Circle().fill(.black.opacity(GlassGlyph.fill)).glassEffect(.clear, in: Circle()).environment(\.colorScheme, .dark).overlay(Circle().strokeBorder(LinearGradient(colors: [.white.opacity(0.65), .white.opacity(0.06), .white.opacity(0.32)], startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 0.7))
            } else {
                Circle().fill(.ultraThinMaterial).environment(\.colorScheme, .dark)
                    .overlay(Circle().fill(.black.opacity(GlassGlyph.fill)))
                    .overlay(Circle().strokeBorder(LinearGradient(colors: [.white.opacity(0.65), .white.opacity(0.06), .white.opacity(0.32)], startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 0.7))
            }
            // glyph = 55 % of the circle (GlassGlyph); ⋮ as three dots
            if icon == GlassGlyph.moreIcon {
                GlassDots(diameter: size)
            } else if off, let symbol = GlassGlyph.offSymbol(for: icon) {
                GlassOffSymbol(name: symbol, diameter: size)
            } else if let url = Bundle.main.url(forResource: icon, withExtension: "png"), let image = UIImage(contentsOfFile: url.path) {
                let g = GlassGlyph.size(pixels: CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale), diameter: size)
                Image(uiImage: image).resizable().frame(width: g.width, height: g.height)
            }
            if slashed { Capsule().fill(.white).frame(width: 26, height: 1.5).rotationEffect(.degrees(45)) }
        }.frame(width: size, height: size).contentShape(Circle())
    }
}

/// S09-PREP (Figma 228:543): small dark pill with a turning arc under the status line while prep runs.
/// (#179 draws the same pill from `CallController.prepStage`; this one reads the account's prep poll.)
struct CallPrepLine: View {
    let text: String
    /// 16 + arc 14 + 8 + text (14 medium) + 16 — the pill's room rule decides whether it may sit on the menu row.
    static func width(_ text: String) -> CGFloat {
        let font = UIFont(name: "PretendardVariable-Medium", size: 14) ?? .systemFont(ofSize: 14, weight: .medium)
        return 16 + 14 + 8 + ceil((text as NSString).size(withAttributes: [.font: font]).width) + 16
    }
    @State private var turn = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        HStack(spacing: 8) {
            Circle().stroke(CallInk.onInk.opacity(0.32), lineWidth: 2)
                .overlay(Circle().trim(from: 0, to: 0.25).stroke(CallInk.blueOnInk, style: StrokeStyle(lineWidth: 2, lineCap: .round)).rotationEffect(.degrees(turn ? 360 : 0)))
                .frame(width: 14, height: 14)
                .onAppear { if !reduceMotion && !CallMotion.reviewStill { withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) { turn = true } } }
            Text(text).font(TypeStyle.body(14, .medium)).foregroundStyle(CallInk.onInk).lineLimit(1).fixedSize()
        }
        .padding(.horizontal, 16).padding(.vertical, 8).frame(minHeight: 36)
        .background(CallInk.pill, in: RoundedRectangle(cornerRadius: 18))
        .accessibilityElement(children: .combine).accessibilityIdentifier("callPrepPill")
    }
}

/// The background time a paused call holds its grace with (one at a time).
@MainActor enum CallBackgroundTime {
    private static var task: UIBackgroundTaskIdentifier = .invalid
    private static var timer: Task<Void, Never>?
    /// Runs `expired` when iOS takes the time back before the grace is over; the task ends by itself after `seconds`.
    static func begin(seconds: Double, expired: @escaping @MainActor () -> Void) {
        end()
        task = UIApplication.shared.beginBackgroundTask(withName: "genita.call.grace") {
            MainActor.assumeIsolated { expired(); end() }
        }
        timer = Task { @MainActor in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled else { return }
            end()
        }
    }
    static func end() {
        timer?.cancel(); timer = nil
        if task != .invalid { UIApplication.shared.endBackgroundTask(task); task = .invalid }
    }
}
