import SwiftUI
import AVFoundation
import Combine
import ARKit

@MainActor final class PhoneHandoff: ObservableObject {
    static let shared = PhoneHandoff()
    let link: HandoffLink
    let tracker = ScreenWorldTracker()
    let media = LocalCallMedia()
    let ownership: OwnershipCoordinator
    /// F6-L7: the server's conversation layer. When it is up it decides the owner and relays Move to Mac;
    /// the local link stays as the fallback and the effect layer.
    let server = ServerOwnershipLink(device: .phone)
    private var fanout: OwnershipFanout?
    private let feedback = HandoffFeedback()
    @Published private(set) var surface = HandoffSurface.active
    @Published var motion: TransitionPayload?
    @Published private(set) var renderedMotionID: String?
    var motionVisible: Bool { motion != nil && renderedMotionID == motion?.id }
    func effectReady(_ id:String) { guard motion?.id == id else{return};renderedMotionID=id }
    @Published var settings = false
    /// P01-E: the six digits found no Mac.
    @Published var pairingFailed = false
    /// Review hook only: shows P02 without a Mac.
    @Published var debugPaired = false
    private var pairingAttempt = 0
    @Published var code = ""
    @Published private(set) var moving = false
    /// MV-E: shown for 3 s as the call's status line, then it clears itself (independent of any view).
    @Published var moveFailed = false {
        didSet {
            guard moveFailed,!pinMoveFailed else{return} // every failure restarts the 3 s (a quick retry that fails again stays up 3 s)
            moveFailedToken+=1;let token=moveFailedToken
            DispatchQueue.main.asyncAfter(deadline:.now()+3) { [weak self] in if self?.moveFailedToken==token {self?.moveFailed=false} }
        }
    }
    private var moveFailedToken = 0
    /// DEBUG `--handoff-state mve`: the line stays up for the screenshot (a slow CI runner launched after the 3 s
    /// had passed and missed it). The 3 s clear is covered by `PhoneHandoffMoveLineTests`.
    private var pinMoveFailed = false
    /// P03: the rear camera is looking for the MAC-REG picture.
    @Published private(set) var registeringVisible = false
    /// P04: the toast after the screen was learned (4 s).
    @Published private(set) var registeredToast = false
    /// Touch to move needs world tracking (A12+) and a known display size. LiDAR only adds precision.
    var proximitySupported: Bool { debugPaired || ScreenWorldTracker.supported && PhoneDisplayGeometry.meters != nil }
    var isPaired: Bool { link.remembered != nil }
    private var pending: [String: Any]?
    private var snapshot = ""
    private var clockOffset = 0.0
    private var generation = 0
    private var model: AppState?
    private var trackingURL: URL?
    private var launchConnected=false
    private var sceneActive=true
    private var registering=false
    private var moveAttempt=0
    private var trackingStarted=false
    private var lastPing=Date().timeIntervalSince1970
    private var timer: Timer?
    /// DEBUG review states pin "the Mac is reachable" (--handoff-state, --proximity-moment).
    var debugPeerReachable: Bool?
    private var subscriptions = Set<AnyCancellable>()
    private var accountScope = HandoffAccountScope()
    private let accountResolver = HandoffAccountResolver()
    /// a first /me is in flight (set when resolving starts; cleared on adopt, expiry and any setAccount)
    private var resolving=false
    init() {
        let args=ProcessInfo.processInfo.arguments
        if args.contains("--uitesting") { for key in ["genita.handoff.ownership","genita.handoff.rememberedMac"] {UserDefaults.standard.removeObject(forKey:key)} }
        link=HandoffLink()
        ownership=OwnershipCoordinator(device:.phone)
        ownership.useAccount(nil)
        let fanout=OwnershipFanout([link,server]);self.fanout=fanout
        ownership.transport=fanout
        ownership.onChange = { [weak self] old,new in self?.ownerChanged(from:old,to:new) }
        link.onMessage = { [weak self] in self?.receive($0) }
        server.onEffect = { [weak self] in self?.serverEffect($0) }
        server.onConnect = { [weak self] in
            guard let self,self.accountScope.accountID != nil else{return}
            self.server.send(["type":"hello","owner":self.ownership.state.owner.serverName,"epoch":self.ownership.state.epoch,"active":self.sceneActive])
        }
        tracker.$registered.dropFirst().removeDuplicates().sink { [weak self] done in
            guard let self,done,self.registeringVisible else{return}
            // Keep `registering` on: tracking must restart even if the app leaves before the world map is saved.
            self.registeringVisible=false;self.showRegisteredToast()
        }.store(in:&subscriptions)
        tracker.onReading = { [weak self] reading in
            guard let self else { return }; var packet=reading; packet["type"]="reading"
            self.link.send(packet, reliable:false)
        }
        // the live call owns camera and mic (CallController); Dyno's tracking hooks attach to it
        CallController.shared.beforeCameraStart = { [weak self] in self?.trackingStarted=false;self?.tracker.stop() }
        CallController.shared.onCameraChange = { [weak self] in self?.updateTracking() }
        CallController.shared.onConnected = { [weak self] in self?.startConnections() }
        link.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in:&subscriptions)
        server.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in:&subscriptions)
        tracker.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in:&subscriptions)
        refreshSurface()
        timer=Timer.scheduledTimer(withTimeInterval:1,repeats:true){ [weak self] _ in Task { @MainActor in self?.refreshSurface() } }
    }
    /// Verified sign-in /me and logout switch the local link and ownership together.
    func setAccount(_ accountID: String?) {
        // Logout must cancel /me even when no scope has been resolved yet.
        let wasResolving=resolving;resolving=false
        accountResolver.invalidate()
        // P01's digits typed while this sign-in's /me was pending belong to it: the first verified scope keeps them,
        // whichever path verified it (routeOnLaunch or the resolver). An account switch or logout drops them.
        let carry=HandoffPairingInput.carries(from:accountScope.accountID,to:accountID) ? (code:code,settings:settings) : nil
        guard accountScope.select(accountID) else {
            // logout before /me verified anything: still drop what was typed
            // only a logout that cancels a pending /me: a plain "no account" call at launch must not close P01
            if accountID == nil,wasResolving {pairingAttempt+=1;pairingFailed=false;code="";settings=false}
            return
        }
        server.stop();link.autoReconnect=false;link.useAccount(accountID)
        generation+=1;pairingAttempt+=1;moveAttempt+=1;moveFailedToken+=1
        pending=nil;motion=nil;renderedMotionID=nil;feedback.cancel()
        moving=false;moveFailed=false;pairingFailed=false;code="";settings=false
        registering=false;registeringVisible=false;registeredToast=false
        trackingURL=nil;trackingStarted=false;tracker.stop();lastPing=0;snapshot=""
        media.stopAll()
        ownership.useAccount(accountID)
        if let carry {code=carry.code;settings=carry.settings}
        refreshSurface()
        link.autoReconnect=accountID != nil && sceneActive
        if accountID != nil,model != nil {startConnections()}
        if carry?.code.count == 6 {connect()}
    }
    private func startConnections() {
        guard sceneActive else { return }
        guard accountScope.accountID != nil else { resolveAccount();return }
        let args=ProcessInfo.processInfo.arguments
        if !args.contains("--uitesting") || args.contains("--handoff-server") {server.start()}
        // a recovered call never swaps a code pairing in progress for the remembered Mac
        if HandoffPairingInput.mayReconnectRemembered(sheetOpen:settings,code:link.pairedWithCode ? "" : code,linkConnected:link.connected) {link.reconnect()}
    }
    private func resolveAccount() {
        guard sceneActive,accountScope.accountID == nil,let model,model.serverWired,
              !model.storage.bool(forKey:AppState.signedOutKey) else { return }
        let auth=model.onboarding.auth
        resolving=true
        accountResolver.resolve(snapshot:model.launchAuthSnapshot,current:{ model.launchAuthSnapshot },
            fetch:{ await auth.sessionState() },adopt:{ [weak self,weak model] accountID in
                self?.resolving=false
                // setAccount keeps the code entered while /me was pending and joins once the scope is installed
                model?.adopt(accountId:accountID)
            },expired:{ [weak model] in model?.signedOut() })  // setAccount(nil) clears `resolving` after it drops the typed digits
    }
    func attach(_ model: AppState) {
        self.model=model
        let args=ProcessInfo.processInfo.arguments
        #if DEBUG
        if let i=args.firstIndex(of:"--handoff-state"),args.indices.contains(i+1) {
            switch args[i+1] {
            case "p03": registeringVisible=true;return
            case "p04": showRegisteredToast();return
            // CI screenshots of the pairing sheet and the move status line (no Mac needed)
            case "p01": code="482";settings=true;return
            case "p01-looking": code="482918";settings=true;return
            case "p01e": code="482918";pairingFailed=true;settings=true;return
            case "p02": debugPaired=true;settings=true;return
            case "mv1": moving=true;return
            case "mve": pinMoveFailed=true;moveFailed=true;return
            default: break
            }
            if !ownership.isOwner || ownership.state.epoch==0 {ownership.receive(OwnershipClaim(owner:.mac,epoch:1))}
            debugPeerReachable=args[i+1]=="r1"
            refreshSurface()
            return
        }
        #endif
        // UI tests stay offline so their screens never depend on a server.
        startConnections()
        if !launchConnected,let i=args.firstIndex(of:"--handoff-code"),args.indices.contains(i+1) {launchConnected=true;code=args[i+1];connect();return}
    }
    func resume() {
        sceneActive=true;link.autoReconnect=accountScope.accountID != nil;lastPing=Date().timeIntervalSince1970
        server.setActive(true)
        startConnections()
        updateTracking();refreshSurface()
    }
    /// P01: runs by itself when the sixth digit goes in. No Mac within 8 s shows P01-E.
    func connect() {
        // Registering the screen waits for Set up touch to move (P02), so Not now leaves no MAC-REG behind.
        pairingFailed=false;registering=false
        guard code.count == 6 else{return}
        if accountScope.accountID == nil {resolveAccount()} else {link.join(code)}
        pairingAttempt+=1;let attempt=pairingAttempt
        DispatchQueue.main.asyncAfter(deadline:.now()+8) { [weak self] in
            guard let self,self.pairingAttempt==attempt,!self.link.connected else{return}
            self.pairingFailed=true
        }
    }
    /// Editing the digits drops a running search, so its timer can't flag the new input.
    func codeEdited() { pairingAttempt+=1;pairingFailed=false }
    /// Closes P01/P02. A half-entered code is dropped.
    func closePairing() { pairingAttempt+=1;pairingFailed=false;if !link.connected {code=""};settings=false }
    /// P02 Set up touch to move → P03 here and MAC-REG on the Mac at the same time.
    func registerScreen() { registering=true;registeringVisible=true;tracker.resetScreen();link.send(["type":"register"]);updateTracking();settings=false;model?.settingsOpen=false }
    func cancelRegistration() { registeringVisible=false;registering=false;link.send(["type":"registerCancel"]);updateTracking() }
    private func showRegisteredToast() {
        withAnimation(.easeOut(duration:0.2)) {registeredToast=true}
        DispatchQueue.main.asyncAfter(deadline:.now()+4) { [weak self] in withAnimation(.easeOut(duration:0.2)) {self?.registeredToast=false} }
    }
    func forgetMac() { registering=false;trackingURL=nil;updateTracking();link.forgetMac();code="";refreshSurface() }
    func snapshotCall() {
        guard let model else { return }
        let renderer=ImageRenderer(content: ConversationView(model:model,handoffEnabled:false).frame(width:390,height:844).environment(\.colorScheme,.light).environment(\.genitaStillRender,true))
        renderer.scale=2
        snapshot=renderer.uiImage?.pngData()?.base64EncodedString() ?? ""
    }
    /// Continue here on R1 or R1-E. The tap wins immediately, with or without the Mac.
    func continueHere() {
        guard !ownership.isOwner else{return}
        generation+=1;pending=nil;motion=nil
        if server.nextTrigger != "move" {server.nextTrigger="continue"}
        withAnimation(.easeOut(duration:0.24)) { ownership.claimHere() }
        feedback.playConnected()
    }
    /// Move to Mac in the menu. Works on every iPhone and needs no position tracking.
    /// With the server up and the Mac online, no pairing is needed: the server relays the request and the Mac claims.
    func moveToMac() {
        guard ownership.isOwner,!moving else{return}
        let viaServer=server.peerActive
        guard viaServer || isPaired || link.connected else {
            // The server is up but the Mac isn't running Genita: say so (MV-E) rather than asking for a code.
            if server.connected {moveFailed=true} else {settings=true}
            return
        }
        moving=true;moveAttempt+=1;let attempt=moveAttempt
        // One channel per request, so a late duplicate can't undo a later Continue here.
        if viaServer {server.moveRequest(to:.mac)}
        else if link.connected {link.send(["type":"moveRequest"])} else {link.reconnect()}
        DispatchQueue.main.asyncAfter(deadline:.now()+5) { [weak self] in
            guard let self,self.moving,self.moveAttempt==attempt else{return}
            self.moving=false;self.moveFailed=true
        }
    }
    private func ownerChanged(from old:ConversationDevice,to new:ConversationDevice) {
        moving=false;moveAttempt+=1
        if new == .mac {media.stopAll();CallController.shared.suspend()}
        // AU-83/AU-84: back from the Mac. The open call gets a new server session seeded with what was said on the Mac,
        // and the mic comes back as the user left it. A call ended meanwhile (background) begins again on .active.
        else if old == .mac {CallController.shared.rejoin()}
        updateTracking();refreshSurface()
        if old != new,new == .mac,motion == nil {feedback.playConnected()}
    }
    /// Tracking only runs while this iPhone has the conversation: it stops the rear camera once moved.
    private func updateTracking() {
        let wanted=sceneActive && ownership.isOwner && link.connected && proximitySupported && trackingURL != nil && !CallController.shared.cameraOn && (registering || tracker.hasSavedSpace)
        if wanted,let trackingURL {
            if !trackingStarted {trackingStarted=true;tracker.start(trackingURL)}
        } else if trackingStarted {trackingStarted=false;tracker.stop()}
    }
    private func serverEffect(_ effect:PresenceEffect) {
        guard accountScope.accountID != nil else{return}
        switch effect {
        case let .apply(claim):
            // A touch move's effect is driven by Dyno's local prepare/ready/start. If the server's copy of the
            // same claim arrives first, hold it until the effect has begun so the transition looks unchanged.
            if pending != nil || motion != nil {
                let generation=accountScope.generation
                DispatchQueue.main.asyncAfter(deadline:.now()+1.2) { [weak self] in
                    guard let self,self.accountScope.accepts(generation) else{return}
                    self.ownership.receive(claim)
                }
            } else {ownership.receive(claim)}
        case .moveRequested: if sceneActive && !ownership.isOwner {server.nextTrigger="move";continueHere()}
        case .moveFailed: if moving {moving=false;moveAttempt+=1;moveFailed=true}
        case .peerChanged: refreshSurface()
        }
    }
    private func refreshSurface() {
        // The Mac counts as reachable over the local link (pings) or the server (presence).
        let reachable=debugPeerReachable ?? ((link.connected && Date().timeIntervalSince1970-lastPing<3) || server.peerOnline)
        let next=ownership.surface(peerReachable:reachable)
        if next != surface {withAnimation(.easeOut(duration:0.24)) {surface=next}}
    }
    func receive(_ data:[String:Any]) {
        guard accountScope.accountID != nil else{return}
        switch data["type"] as? String {
        case "connected":
            lastPing=Date().timeIntervalSince1970
            snapshotCall()
            var hello:[String:Any]=["type":"hello","image":snapshot,"profile":model?.companionFaceData?.base64EncodedString() ?? "","register":registering && proximitySupported]
            if let size=PhoneDisplayGeometry.meters {hello["phoneHeight"]=size.height;hello["phoneWidth"]=size.width}
            link.send(hello)
            ownership.publishCurrent()
            if moving && !server.peerActive {link.send(["type":"moveRequest"])}
            // P02 (Paired) follows the code. Without position tracking there is nothing to set up, so it closes.
            if link.pairedWithCode && !proximitySupported {settings=false}
            refreshSurface()
        case "welcome":
            guard let identity=data["identity"] as? String, let url=URL(string:"genita://"+identity) else{return}
            trackingURL=url;updateTracking()
        case "ping":
            lastPing=Date().timeIntervalSince1970
            link.send(["type":"pong","sent":data["sent"] ?? 0,"phone":lastPing])
            refreshSurface()
        case "clock": clockOffset=data["offset"] as? Double ?? 0
        case "registration":
            // The Mac shows MAC-REG at this physical size: track that picture (all iPhones, A12+).
            tracker.setRegistration(RegistrationGeometry(data))
        case "ownership":
            if let claim=OwnershipClaim(data) {ownership.receive(claim)}
        case "moveRequest":
            if sceneActive {continueHere()}
        case "prepare":
            guard motion == nil, !snapshot.isEmpty else{return}
            pending=data;link.send(["type":"ready","id":data["id"] ?? ""])
        case "start":
            guard let id=data["id"] as? String,id==pending?["id"] as? String, let start=data["start"] as? Double else{return}
            generation+=1;let epoch=generation
            let outgoing=data["outgoing"] as? Bool ?? true
            let right=data["right"] as? Bool ?? false
            let localStart=start+clockOffset
            renderedMotionID=nil
            motion=TransitionPayload(id:id,image:snapshot,start:localStart,outgoing:outgoing,reverse:(!outgoing) != right)
            // The conversation owns its audio session. Handoff must not change
            // an active call category, microphone route, or speaker selection.
            try? feedback.schedule(delay:max(0,localStart-Date().timeIntervalSince1970),duration:3.2,outgoing:outgoing)
            try? feedback.scheduleSounds(delay:max(0,localStart-Date().timeIntervalSince1970),duration:3.2)
            DispatchQueue.main.asyncAfter(deadline:.now()+max(0,localStart+3.2-Date().timeIntervalSince1970)) {
                guard epoch==self.generation else{return};self.motion=nil;self.pending=nil
            }
        case "disconnected":
            // The local link is only the effect layer. Losing it never changes who owns the conversation.
            generation+=1;pending=nil;motion=nil;feedback.cancel();registering=false
            updateTracking();refreshSurface()
        case "cancel":
            generation+=1;pending=nil;motion=nil;feedback.cancel()
        default: break
        }
    }
    /// Background or lock. The owner stays the same; only the effect layer rests.
    func pause() {
        accountResolver.invalidate()
        sceneActive=false;link.autoReconnect=false
        server.setActive(false)
        link.send(["type":"inactive"]);updateTracking()
        generation+=1;pending=nil;motion=nil;feedback.cancel()
    }
}

struct PhoneHandoffOverlay: View {
    let model: AppState
    @ObservedObject private var handoff = PhoneHandoff.shared
    @Environment(\.scenePhase) private var phase
    var body: some View {
        ZStack(alignment:.top) {
            // Keeps this view alive when no effect is running, so its lifecycle and alerts fire.
            Color.clear.allowsHitTesting(false)
            if handoff.motionVisible { Color.black.ignoresSafeArea() }
            if let motion=handoff.motion { DuoTransition(payload:motion,onReady:handoff.effectReady).ignoresSafeArea().allowsHitTesting(false) }
            if handoff.registeredToast { RegisteredToast().padding(.top,124-59).transition(.opacity) }
            if handoff.registeringVisible { RegisteringView(session:handoff.tracker.session,cancel:handoff.cancelRegistration).ignoresSafeArea() }
            ProximityMomentView()  // GENITA_PROXIMITY_HANDOFF: the glide + toast of a move by bringing the iPhone close
        }.onAppear { handoff.attach(model);PhoneProximity.shared.attach(handoff) }
        .onChange(of:phase) { _,new in if new != .active { handoff.pause() } else { handoff.resume() } }
        .overlay { if handoff.settings { PhonePairingView().transition(.opacity) } }
        .animation(.easeOut(duration:0.24),value:handoff.settings)
    }
}

/// P03 · Registering: the rear camera looks for MAC-REG on the Mac (board design-flow r01).
struct RegisteringView: View {
    let session: ARSession
    let cancel: () -> Void
    var body: some View {
        ZStack {
            RegisteringPalette.base
            CameraFeed(session: session)
            // the board's navy shows through the camera so the white corners and Cancel always read
            RegisteringPalette.base.opacity(0.32).allowsHitTesting(false)
            // viewfinder corners around where the Mac's screen should sit
            ViewfinderCorners().stroke(.white, style: StrokeStyle(lineWidth: 3, lineCap: .round)).frame(width: 300, height: 196).offset(y: -40)
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    ProgressView().tint(.white)
                    Text("Point at the picture on your Mac").font(.custom("PretendardVariable-Medium", fixedSize: 15)).foregroundStyle(Color(white: 253.0 / 255))
                }
                .padding(.horizontal, 16).frame(minHeight: 44).background(Color(white: 17.0 / 255).opacity(0.84), in: Capsule())
                .padding(.top, 72).accessibilityElement(children: .combine).accessibilityAddTraits(.updatesFrequently)
                Spacer()
                Button(action: cancel) {
                    Text("Cancel").font(.custom("PretendardVariable-Medium", fixedSize: 16)).foregroundStyle(Color(white: 17.0 / 255))
                        .frame(maxWidth: .infinity).frame(height: 50).background(Color(white: 253.0 / 255), in: RoundedRectangle(cornerRadius: 12)).contentShape(Rectangle())
                }.buttonStyle(.plain).padding(.horizontal, 24).padding(.bottom, 58).accessibilityIdentifier("cancelRegistration")
            }
        }
    }
}
private struct ViewfinderCorners: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path(); let l: CGFloat = 28
        for (x, y, dx, dy) in [(r.minX, r.minY, l, l), (r.maxX, r.minY, -l, l), (r.minX, r.maxY, l, -l), (r.maxX, r.maxY, -l, -l)] {
            p.move(to: CGPoint(x: x, y: y + dy)); p.addLine(to: CGPoint(x: x, y: y)); p.addLine(to: CGPoint(x: x + dx, y: y))
        }
        return p
    }
}
/// The tracker's own session on screen, so the person sees what the rear camera sees.
private struct CameraFeed: UIViewRepresentable {
    let session: ARSession
    func makeUIView(context: Context) -> ARSCNView {
        let view = ARSCNView(frame: .zero)
        // The board's navy until the first camera frame (ARKit then draws the camera image as the scene background).
        view.backgroundColor = RegisteringPalette.baseUI
        view.scene.background.contents = RegisteringPalette.baseUI
        view.automaticallyUpdatesLighting = false
        view.rendersCameraGrain = false
        // Assigning the session keeps the tracker as its delegate; the view only draws the camera image.
        view.session = session
        return view
    }
    func updateUIView(_ view: ARSCNView, context: Context) {}
}
/// P04 · Registered: toast for 4 s.
struct RegisteredToast: View {
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "checkmark").font(.system(size: 15, weight: .semibold))
            Text("Mac screen learned. Touch its edge with this iPhone to move.").font(.custom("PretendardVariable-Regular", fixedSize: 15)).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .foregroundStyle(Color(white: 253.0 / 255)).padding(.horizontal, 16).padding(.vertical, 12).frame(minHeight: 52)
        .background(Color(white: 17.0 / 255), in: RoundedRectangle(cornerRadius: 16)).shadow(color: .black.opacity(0.12), radius: 12, y: 8)
        .padding(.horizontal, 24).accessibilityIdentifier("registeredToast")
    }
}

/// P03 board background (design-flow r01): dark navy, not black.
enum RegisteringPalette {
    static let baseUI = UIColor(red: 29.0 / 255, green: 34.0 / 255, blue: 43.0 / 255, alpha: 1)
    static let base = Color(baseUI)
}
