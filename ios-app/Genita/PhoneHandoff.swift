import SwiftUI
import AVFoundation
import Combine

@MainActor final class PhoneHandoff: ObservableObject {
    static let shared = PhoneHandoff()
    let link: HandoffLink
    let tracker = LidarWorldTracker()
    let media = LocalCallMedia()
    let ownership: OwnershipCoordinator
    private let feedback = HandoffFeedback()
    @Published private(set) var surface = HandoffSurface.active
    @Published var motion: TransitionPayload?
    @Published private(set) var renderedMotionID: String?
    var motionVisible: Bool { motion != nil && renderedMotionID == motion?.id }
    func effectReady(_ id:String) { guard motion?.id == id else{return};renderedMotionID=id }
    @Published var status = ""
    @Published var settings = false
    @Published var code = ""
    @Published private(set) var moving = false
    @Published var moveFailed = false
    /// The position effect needs LiDAR and a known display size. Everything else uses the button.
    var proximitySupported: Bool { LidarWorldTracker.supported && PhoneDisplayGeometry.meters != nil }
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
    private var lastPing=Date().timeIntervalSince1970
    private var timer: Timer?
    private var debugPeerReachable: Bool?
    private var subscriptions = Set<AnyCancellable>()
    init() {
        let args=ProcessInfo.processInfo.arguments
        if args.contains("--uitesting") { for key in ["genita.handoff.ownership","genita.handoff.rememberedMac"] {UserDefaults.standard.removeObject(forKey:key)} }
        link=HandoffLink()
        ownership=OwnershipCoordinator(device:.phone)
        ownership.transport=link
        ownership.onChange = { [weak self] old,new in self?.ownerChanged(from:old,to:new) }
        link.onMessage = { [weak self] in self?.receive($0) }
        link.autoReconnect=true
        tracker.onReading = { [weak self] reading in
            guard let self else { return }; var packet=reading; packet["type"]="reading"
            self.link.send(packet, reliable:false)
        }
        media.beforeCameraStart = { [weak self] in self?.tracker.stop() }
        media.onCameraChange = { [weak self] in self?.updateTracking() }
        link.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in:&subscriptions)
        tracker.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in:&subscriptions)
        refreshSurface()
        timer=Timer.scheduledTimer(withTimeInterval:1,repeats:true){ [weak self] _ in Task { @MainActor in self?.refreshSurface() } }
    }
    func attach(_ model: AppState) {
        self.model=model
        let args=ProcessInfo.processInfo.arguments
        #if DEBUG
        if let i=args.firstIndex(of:"--handoff-state"),args.indices.contains(i+1) {
            if !ownership.isOwner || ownership.state.epoch==0 {ownership.receive(OwnershipClaim(owner:.mac,epoch:1))}
            debugPeerReachable=args[i+1]=="r1"
            refreshSurface()
            return
        }
        #endif
        if !launchConnected,let i=args.firstIndex(of:"--handoff-code"),args.indices.contains(i+1) {launchConnected=true;code=args[i+1];connect();return}
        if !link.connected {link.reconnect()}
    }
    func resume() {
        sceneActive=true;link.autoReconnect=true;lastPing=Date().timeIntervalSince1970
        if !link.connected {link.reconnect()}
        updateTracking();refreshSurface()
    }
    func connect() { registering=proximitySupported;link.join(code) }
    func registerScreen() { registering=true;tracker.resetScreen();link.send(["type":"register"]);updateTracking();settings=false }
    func forgetMac() { registering=false;trackingURL=nil;updateTracking();link.forgetMac();code="";refreshSurface() }
    func snapshotCall() {
        guard let model else { return }
        let renderer=ImageRenderer(content: ConversationView(model:model,handoffEnabled:false).frame(width:390,height:844).environment(\.colorScheme,.light))
        renderer.scale=2
        snapshot=renderer.uiImage?.pngData()?.base64EncodedString() ?? ""
    }
    /// Continue here on R1 or R1-E. The tap wins immediately, with or without the Mac.
    func continueHere() {
        guard !ownership.isOwner else{return}
        generation+=1;pending=nil;motion=nil
        withAnimation(.easeOut(duration:0.24)) { ownership.claimHere() }
        feedback.playConnected()
    }
    /// Move to Mac in the menu. Works on every iPhone and needs no position tracking.
    func moveToMac() {
        guard ownership.isOwner,!moving else{return}
        guard isPaired || link.connected else {settings=true;return}
        moving=true;moveAttempt+=1;let attempt=moveAttempt
        if link.connected {link.send(["type":"moveRequest"])} else {link.reconnect()}
        DispatchQueue.main.asyncAfter(deadline:.now()+5) { [weak self] in
            guard let self,self.moving,self.moveAttempt==attempt else{return}
            self.moving=false;self.moveFailed=true
        }
    }
    private func ownerChanged(from old:ConversationDevice,to new:ConversationDevice) {
        moving=false;moveAttempt+=1
        if new == .mac {media.stopAll()}
        updateTracking();refreshSurface()
        if old != new,new == .mac,motion == nil {feedback.playConnected()}
    }
    /// Tracking only runs while this iPhone has the conversation: it stops the rear camera once moved.
    private func updateTracking() {
        let wanted=sceneActive && ownership.isOwner && link.connected && proximitySupported && trackingURL != nil && !media.cameraOn && (registering || tracker.hasSavedSpace)
        if wanted,let trackingURL {tracker.start(trackingURL)} else if tracker.running {tracker.stop()}
    }
    private func refreshSurface() {
        let reachable=debugPeerReachable ?? (link.connected && Date().timeIntervalSince1970-lastPing<3)
        let next=ownership.surface(peerReachable:reachable)
        if next != surface {withAnimation(.easeOut(duration:0.24)) {surface=next}}
    }
    func receive(_ data:[String:Any]) {
        switch data["type"] as? String {
        case "connected":
            lastPing=Date().timeIntervalSince1970
            snapshotCall()
            var hello:[String:Any]=["type":"hello","image":snapshot,"profile":model?.setup.imageData?.base64EncodedString() ?? "","register":registering && proximitySupported]
            if let size=PhoneDisplayGeometry.meters {hello["phoneHeight"]=size.height;hello["phoneWidth"]=size.width}
            link.send(hello)
            ownership.publishCurrent()
            if moving {link.send(["type":"moveRequest"])}
            if link.pairedWithCode {settings=false}
            refreshSurface()
        case "welcome":
            guard let identity=data["identity"] as? String, let url=URL(string:"genita://"+identity) else{return}
            trackingURL=url;updateTracking()
        case "ping":
            lastPing=Date().timeIntervalSince1970
            link.send(["type":"pong","sent":data["sent"] ?? 0,"phone":lastPing])
            refreshSurface()
        case "clock": clockOffset=data["offset"] as? Double ?? 0
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
        sceneActive=false;link.autoReconnect=false
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
            if handoff.motionVisible { Color.black.ignoresSafeArea() }
            if let motion=handoff.motion { DuoTransition(payload:motion,onReady:handoff.effectReady).ignoresSafeArea().allowsHitTesting(false) }
        }.onAppear { handoff.attach(model) }
        .onChange(of:phase) { _,new in if new != .active { handoff.pause() } else { handoff.resume() } }
        .sheet(isPresented:$handoff.settings) { PhonePairingView().padding(24).presentationDetents([.medium,.large]) }
        .alert("Mac not responding.",isPresented:$handoff.moveFailed) { Button("OK",role:.cancel) {} } message: { Text("It may be asleep or offline. You can keep talking here.") }
    }
}

/// First pairing and position-effect registration. Later moves do not come here.
struct PhonePairingView: View {
    @ObservedObject private var handoff = PhoneHandoff.shared
    var body: some View {
        VStack(spacing:20) {
            Text(handoff.isPaired ? "Your Mac" : "Pair with your Mac").font(.title2)
            if handoff.isPaired {
                Text(handoff.link.status)
            } else {
                Text("Enter the six-digit code shown in Genita on your Mac. You only do this once.").multilineTextAlignment(.center)
                TextField("Code",text:$handoff.code).keyboardType(.numberPad).textFieldStyle(.roundedBorder).accessibilityIdentifier("pairingCode")
                Button("Pair",action:handoff.connect).buttonStyle(.borderedProminent)
                Text(handoff.link.status)
            }
            if handoff.link.connected && handoff.proximitySupported {
                Text(handoff.tracker.status).font(.caption)
                Button("Register Mac screen",action:handoff.registerScreen)
                HStack {Text("Center down \(Int(handoff.tracker.centerDownMM)) mm");Slider(value:Binding(get:{handoff.tracker.centerDownMM},set:{handoff.tracker.centerDownMM=$0}),in:0...90,step:1)}
                HStack {Text("Right \(Int(handoff.tracker.centerRightMM)) mm");Slider(value:Binding(get:{handoff.tracker.centerRightMM},set:{handoff.tracker.centerRightMM=$0}),in:-35...35,step:1)}
            }
            Text(handoff.proximitySupported ? "Registering your Mac’s screen once lets you start a move by bringing this iPhone next to it. Move to Mac in the menu works without it." : "Use Move to Mac in the menu to move the conversation.").font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            if handoff.isPaired { Button("Forget this Mac",role:.destructive,action:handoff.forgetMac) }
        }
    }
}
