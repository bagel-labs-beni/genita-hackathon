import SwiftUI
import AppKit
import Combine

/// A borderless window that still takes clicks and keyboard focus for its controls and sheets.
private final class CompanionWindow:NSWindow { override var canBecomeKey:Bool {true} }

@MainActor final class MacHandoff: ObservableObject {
    static let shared = MacHandoff()
    let link = HandoffLink()
    let sharing = ScreenSharingController()
    let media = LocalCallMedia()
    let ownership = OwnershipCoordinator(device:.mac)
    /// F6-L7: the server's conversation layer; the local link stays as fallback and effect layer.
    let server = ServerOwnershipLink(device:.mac)
    private var fanout: OwnershipFanout?
    @Published var status = "Waiting for your iPhone"
    @Published fileprivate(set) var surface = HandoffSurface.active
    @Published private(set) var companionVisible = false
    /// R2 says "Screen sharing stopped." only when sharing was on as the conversation left.
    @Published fileprivate(set) var sharingStopped = false
    @Published var motion: TransitionPayload?
    @Published private(set) var renderedMotionID:String?
    var motionVisible:Bool { motion != nil && renderedMotionID == motion?.id }
    func effectReady(_ id:String) { guard motion?.id==id else{return};renderedMotionID=id }
    /// An arriving window shows only the effect; a departing one stays visible until its first frame.
    var conversationHidden:Bool { guard let motion else{return false};return motion.outgoing ? motionVisible : true }
    /// Only when a request can actually reach an iPhone that is in front (local link, or the server says active).
    var canMoveToPhone:Bool {
        #if DEBUG
        if let review=reviewCanMove {return review}
        #endif
        return ownership.isOwner && (linkReachable || server.peerActive) && motion == nil
    }
    #if DEBUG
    /// CI review only: pins "an iPhone is in front" so MC-M and MAC-4 render their enabled state.
    var reviewCanMove:Bool?
    #endif
    private var linkReachable:Bool { link.connected && Date().timeIntervalSince1970-lastPong<3 }
    private var returnOrigin:NSPoint?
    @Published var profile: Data?
    private var image = ""
    private var screen: NSScreen?
    private var registration: NSWindow?
    private var companion: NSWindow?
    private var last: HandoffPosition?
    private var lastAt = 0.0
    private var dock: HandoffPosition?
    private var candidate: HandoffPosition?
    private var candidateAt = 0.0
    private var armed = true
    private var pending: (id:String,outgoing:Bool,time:Double)?
    private var phoneHeight=0.14478,phoneWidth=0.066592
    private var timer: Timer?
    private var diagnosticAt=0.0
    private var pingAt=0.0
    private var lastPong=0.0
    private var epoch=0
    private var bestRTT=Double.infinity
    private var subscriptions=Set<AnyCancellable>()
    /// The iPhone counts as reachable over the local link (pongs) or the server (presence).
    private var phoneReachable:Bool { (link.connected && Date().timeIntervalSince1970-lastPong<3) || server.peerOnline }
    init() {
        let fanout=OwnershipFanout([link,server]);self.fanout=fanout
        ownership.transport=fanout
        server.onEffect = { [weak self] in self?.serverEffect($0) }
        server.onConnect = { [weak self] in
            guard let self else{return}
            self.server.send(["type":"hello","owner":self.ownership.state.owner.serverName,"epoch":self.ownership.state.epoch,"active":true])
        }
        server.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in:&subscriptions)
        if ProcessInfo.processInfo.environment["GENITA_MAC_REVIEW_OUT"] == nil {server.start()}
        ownership.onChange = { [weak self] old,new in self?.ownerChanged(from:old,to:new) }
        link.onMessage = { [weak self] in self?.receive($0) }
        link.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in:&subscriptions)
        link.host()
        // Not synchronously: the window's views read MacHandoff.shared, which is still initializing here.
        if ownership.isOwner && ownership.state.epoch>0 {DispatchQueue.main.async { self.showCompanion();MacCall.shared.conversationArrived() }}
        refreshSurface()
        timer=Timer.scheduledTimer(withTimeInterval:1/30,repeats:true){ [weak self] _ in Task { @MainActor in self?.tick() } }
    }
    func showRegistration() {
        screen = screen ?? NSScreen.main
        guard let screen else{return}
        registration?.close()
        let window=NSWindow(contentRect:screen.frame,styleMask:.borderless,backing:.buffered,defer:false)
        window.isReleasedWhenClosed=false;window.level = .floating;window.backgroundColor = .white
        window.contentView=NSHostingView(rootView:RegistrationView(aspect:screen.frame.width/screen.frame.height))
        window.setFrame(screen.frame,display:true);window.makeKeyAndOrderFront(nil);registration=window
        NSApp.presentationOptions=[.autoHideDock,.autoHideMenuBar]
        // MAC-REG fills the screen, so the picture's physical size is the screen's (CGDisplayScreenSize, mm).
        if let geometry=registrationGeometry(screen) {link.send(geometry.message)}
        status="Point your iPhone’s rear camera at this whole screen once"
    }
    private func registrationGeometry(_ screen:NSScreen)->RegistrationGeometry? {
        let display=(screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? CGMainDisplayID()
        let mm=CGDisplayScreenSize(display)
        return RegistrationGeometry(widthM:mm.width/1000,heightM:mm.height/1000)
    }
    func closeRegistration() { guard registration != nil else{return};registration?.close();registration=nil;NSApp.presentationOptions=[] }
    private func ensureCompanion() {
        guard companion == nil else{return}
        let window=CompanionWindow(contentRect:NSRect(x:0,y:0,width:390,height:844),styleMask:.borderless,backing:.buffered,defer:false)
        window.isReleasedWhenClosed=false;window.isOpaque=false;window.backgroundColor = .clear;window.hasShadow=false;window.level = .floating
        window.collectionBehavior=[.fullScreenAuxiliary];window.contentView=NSHostingView(rootView:MacHandoffSurface())
        companion=window
        placeAtRest(window)
    }
    /// A move by button has no recorded edge: rest at the right of the screen at the phone's physical size.
    private func placeAtRest(_ window:NSWindow) {
        screen = screen ?? NSScreen.main
        guard let screen else{return}
        let size=phoneSize(on:screen)
        window.setFrame(NSRect(origin:NSPoint(x:screen.visibleFrame.maxX-size.width-24,y:screen.visibleFrame.midY-size.height/2),size:size),display:true)
    }
    private func phoneSize(on screen:NSScreen)->NSSize {
        let display=(screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? CGMainDisplayID()
        let mm=CGDisplayScreenSize(display)
        // The same physical phone size, independent of Retina backing pixels.
        let pointsPerM=mm.height>0 ? screen.frame.height/(mm.height/1000) : 844/phoneHeight
        return NSSize(width:phoneWidth*pointsPerM,height:phoneHeight*pointsPerM)
    }
    /// Once shown, this window stays. The conversation leaving turns it into the waiting screen.
    private func showCompanion() {
        ensureCompanion();companionVisible=true;companion?.orderFrontRegardless()
    }
    /// Continue here on R2 or R2-E. The tap wins immediately; the effect is only an extra.
    func continueHere() {
        guard !ownership.isOwner else{return}
        let atEdge=freshAtDock
        server.nextTrigger = atEdge ? "touch" : "continue"
        ownership.claimHere()
        status="Conversation on this Mac"
        if atEdge {prepare(outgoing:true)}
    }
    func moveToPhone() {
        guard canMoveToPhone else{return}
        // One channel per request, so a late duplicate can't undo a later Continue here.
        if server.peerActive {server.moveRequest(to:.phone)} else {link.send(["type":"moveRequest"])}
        status="Moving to your iPhone"
    }
    private func serverEffect(_ effect:PresenceEffect) {
        switch effect {
        case let .apply(claim):
            // Same as the iPhone: never let the server's copy of a claim land in the middle of the effect.
            if pending != nil || motion != nil {
                DispatchQueue.main.asyncAfter(deadline:.now()+1.2) { [weak self] in self?.ownership.receive(claim) }
            } else {ownership.receive(claim)}
        case .moveRequested:
            if !ownership.isOwner {server.nextTrigger="move";ownership.claimHere();status="Conversation on this Mac"}
        case .moveFailed:
            status="Your iPhone isn’t available. Still on this Mac."
        case .peerChanged: refreshSurface()
        }
    }
    private func ownerChanged(from old:ConversationDevice,to new:ConversationDevice) {
        if new == .mac {
            sharingStopped=false;showCompanion()
            MacCall.shared.conversationArrived()  // #118: the live call follows the conversation here
        } else {
            if old == .mac {sharingStopped=sharing.isSharing}
            // The conversation left: sharing stops now and does not come back by itself.
            sharing.stop();sharing.permissionRequired=false;media.stopAll();CallController.shared.suspend()
            MacCall.shared.conversationLeft()
            candidate=nil;armed=false
            status="Conversation on your iPhone"
        }
        refreshSurface()
    }
    private func refreshSurface() {
        #if DEBUG
        if ProcessInfo.processInfo.environment["GENITA_MAC_REVIEW_OUT"] != nil {return}
        #endif
        let next=ownership.surface(peerReachable:phoneReachable)
        if next != surface {surface=next}
    }
    private var freshAtDock:Bool { nowFresh && last.map { p in dock.map { p.sameDock($0) && p.touchesEdge(phoneHeight:phoneHeight) } ?? false } == true }
    func receive(_ message:[String:Any]) {
        let now=Date().timeIntervalSince1970
        switch message["type"] as? String {
        case "connected":
            lastPong=now;bestRTT = .infinity;status=ownership.isOwner && ownership.state.epoch>0 ? "Conversation on this Mac" : "iPhone connected"
            ownership.publishCurrent();refreshSurface()
        case "hello":
            image=message["image"] as? String ?? "";profile=(message["profile"] as? String).flatMap { Data(base64Encoded:$0) }
            if let h=message["phoneHeight"] as? Double,let w=message["phoneWidth"] as? Double,(0.09...0.2).contains(h),(0.04...0.1).contains(w){phoneHeight=h;phoneWidth=w}
            if message["register"] as? Bool == true {showRegistration()}
            else if let screen=screen ?? NSScreen.main,let geometry=registrationGeometry(screen) {link.send(geometry.message)}
            let display=(screen ?? NSScreen.main)?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
            link.send(["type":"welcome","identity":link.macID+"-"+(display?.stringValue ?? "main")])
        case "register": showRegistration()
        case "registerCancel": closeRegistration()
        case "ownership":
            if let claim=OwnershipClaim(message) {ownership.receive(claim)}
        case "moveRequest":
            if !ownership.isOwner {ownership.claimHere();status="Conversation on this Mac"}
        case "pong":
            lastPong=now
            if let sent=message["sent"] as? Double,let phone=message["phone"] as? Double {
                let rtt=now-sent
                if rtt>=0 && rtt<bestRTT {bestRTT=rtt;link.send(["type":"clock","offset":phone-(sent+now)/2])}
            }
        case "reading":
            guard let p=HandoffPosition(message) else {
                last=nil;candidate=nil
                if message["state"] as? String != "stopped" {status=message["reason"] as? String ?? "Finding the screen position"}
                return
            }
            last=p;lastAt=now;closeRegistration()
            let edge=p.touchesEdge(phoneHeight:phoneHeight)
            status="\(p.right ? "Right":"Left") · \(Int(p.y*100)) cm from screen center · \(ownership.isOwner ? "on this Mac":"on your iPhone")"
            if !edge {armed=true;candidate=nil;return}
            guard !ownership.isOwner,motion == nil,pending == nil,armed,!image.isEmpty else{return}
            if let c=candidate,c.right==p.right,abs(c.y-p.y)<0.025 {
                if now-candidateAt>=0.45 {dock=p;prepare(outgoing:true)}
            } else {candidate=p;candidateAt=now}
        case "ready":
            guard let pending,message["id"] as? String == pending.id,now-pending.time<2,let dock else{return}
            let start=now+0.8
            link.send(["type":"start","id":pending.id,"start":start,"outgoing":pending.outgoing,"right":dock.right])
            returnOrigin=pending.outgoing ? nil : companion?.frame.origin
            renderedMotionID=nil
            motion=TransitionPayload(id:pending.id,image:image,start:start,outgoing:!pending.outgoing,reverse:(!pending.outgoing) != dock.right)
            // The move commits as the effect starts. The effect only decorates it.
            if pending.outgoing,!ownership.isOwner {server.nextTrigger="touch";ownership.claimHere()}
            showCompanion();self.pending=nil;epoch+=1;let e=epoch
            DispatchQueue.main.asyncAfter(deadline:.now()+4) {
                guard self.epoch==e else{return}
                self.motion=nil;self.candidate=nil
            }
        case "disconnected":
            // Losing the local link never ends the conversation on this Mac.
            pending=nil;last=nil;candidate=nil;status="iPhone not connected";refreshSurface()
        case "inactive":
            last=nil;candidate=nil
        default:break
        }
    }
    private func prepare(outgoing:Bool) {
        guard link.connected,nowFresh,motion == nil,pending == nil else{return}
        let id=UUID().uuidString;pending=(id,outgoing,Date().timeIntervalSince1970)
        link.send(["type":"prepare","id":id,"outgoing":outgoing])
    }
    private var nowFresh:Bool { Date().timeIntervalSince1970-lastAt<1 && phoneReachable }
    private func tick() {
        let now=Date().timeIntervalSince1970
        if now-diagnosticAt>0.5 {
            diagnosticAt=now
            let root=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("Genita/Handoff")
            try? FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
            var data:[String:Any] = ["at":now,"code":link.code,"connected":link.connected,"status":status,"owner":ownership.state.owner.rawValue,"epoch":ownership.state.epoch,"imageReady":!image.isEmpty,"rtt":bestRTT.isFinite ? bestRTT : -1]
            if let last {data["position"]=["x":last.x,"y":last.y,"z":last.z,"width":last.width,"height":last.height]}
            if let bytes=try? JSONSerialization.data(withJSONObject:data,options:.prettyPrinted) {try? bytes.write(to:root.appendingPathComponent("state.json"),options:.atomic)}
            refreshSurface()
        }
        if link.connected,now-pingAt>0.5 {pingAt=now;link.send(["type":"ping","sent":now])}
        if let pending,now-pending.time>2 {self.pending=nil;candidate=nil;link.send(["type":"cancel"]);status="iPhone didn’t get ready in time"}
        if let motion,!motion.outgoing,now<motion.start,let last,last.touchesEdge(phoneHeight:phoneHeight),last.right==dock?.right {dock=last}
        // A settled window stays where the user dragged it. Only a running effect positions it.
        guard let screen,let dock,let window=companion,motion != nil else{return}
        let size=phoneSize(on:screen)
        var inset=24.0
        if let motion {
            let t=now-motion.start
            if motion.outgoing { let u=max(0,min(1,(t+0.8)/0.8));inset=24*(1-u*u*(3-2*u)) }
            else {let u=max(0,min(1,(t-1.6)/1.6));inset=24*u*u*(3-2*u)}
        }
        var x=dock.right ? screen.frame.maxX-size.width-inset : screen.frame.minX+inset
        // Keep the accepted gravity-aligned coordinate; never clamp y at corners.
        var y=screen.frame.midY+dock.y/dock.height*screen.frame.height-size.height/2
        if let motion,motion.outgoing,let origin=returnOrigin {
            let u=max(0,min(1,(now-motion.start+0.8)/0.8)), eased=u*u*(3-2*u)
            let edgeX=dock.right ? screen.frame.maxX-size.width : screen.frame.minX
            x=origin.x+(edgeX-origin.x)*eased;y=origin.y+(y-origin.y)*eased
        }
        window.setFrame(NSRect(origin:NSPoint(x:x,y:y),size:size),display:true)
    }
}

/// MAC-REG (design-flow r01): the feature-rich picture fills the screen; the note sits in the bottom-right
/// corner only, so the middle of the picture stays visible to the iPhone. It closes by itself once the
/// iPhone has found the screen.
struct RegistrationView: View {
    let aspect: CGFloat
    var body:some View {
        ZStack(alignment:.bottomTrailing) {
            if let image=RegistrationPattern.image(width:1600,aspect:aspect) {
                Image(decorative:image,scale:1).resizable().interpolation(.high).ignoresSafeArea()
            }
            HStack(spacing:16) {
                Text("Show this to your iPhone").font(.custom("KMUTTF-SungkokSemiSerif",fixedSize:22)).foregroundStyle(Color(white:253.0/255)).fixedSize()
                Button { MacHandoff.shared.closeRegistration() } label: {
                    Text("Close").font(.custom("PretendardVariable-Medium",fixedSize:16)).foregroundStyle(Color(white:17.0/255))
                        .padding(.horizontal,24).frame(height:44).background(Color(white:253.0/255),in:RoundedRectangle(cornerRadius:12)).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityIdentifier("closeRegistration")
            }
            .padding(EdgeInsets(top:8,leading:16,bottom:8,trailing:8))
            .background(Color(white:17.0/255).opacity(0.84),in:UnevenRoundedRectangle(topLeadingRadius:20))
        }.ignoresSafeArea()
    }
}
struct MacHandoffSurface: View {
    @ObservedObject private var handoff=MacHandoff.shared
    var body:some View {
        GeometryReader { geometry in
            ZStack {
                if handoff.companionVisible {MacConversationView().opacity(handoff.conversationHidden ? 0 : 1).scaleEffect(x:geometry.size.width/390,y:geometry.size.height/844,anchor:.topLeading).frame(width:geometry.size.width,height:geometry.size.height,alignment:.topLeading)}
                if let motion=handoff.motion {DuoTransition(payload:motion,onReady:handoff.effectReady).allowsHitTesting(false)}
            }.clipShape(RoundedRectangle(cornerRadius:geometry.size.width*0.085))
        }
    }
}
/// The Mac's home window: MAC-2 (no companion yet), MAC-3 (conversation on the iPhone), MAC-4 (conversation here).
/// Figma rp1wR9pxV0IsgyjvOcwo92 87:2 / 88:2 / 89:2: 420 wide, 32 pt padding, serif 28 title, one status row, 50 pt button.
enum MacHomeKind: Equatable { case noCompanion, onPhone, here, offline(String) }
struct MacHandoffControls:View {
    @ObservedObject private var handoff=MacHandoff.shared
    @ObservedObject private var call=MacCall.shared
    private let tick=Timer.publish(every:10,on:.main,in:.common).autoconnect()
    private var kind:MacHomeKind {
        switch call.account {
        case .offline(let reason): return .offline(reason)
        case .noCompanion,.checking,.signingIn: return .noCompanion   // "Checking for your companion"
        default: return handoff.ownership.isOwner && handoff.ownership.state.epoch>0 ? .here : .onPhone
        }
    }
    var body:some View {
        MacHomeView(kind:kind,name:call.companionName ?? "Your companion",handoff:handoff)
            // 4401 → MAC-1, 4403 → CS01 (this window is always there, so it sees every stop of the call)
            .onChange(of:CallController.shared.stopped) { _,stop in if let stop {call.callStopped(stop)} }
            // MAC-2 / offline: the window coming to the front, and every 10 s while it waits, asks /me again
            .onReceive(NotificationCenter.default.publisher(for:NSApplication.didBecomeActiveNotification)) { _ in recheck() }
            .onReceive(tick) { _ in recheck() }
    }
    private func recheck() {
        switch call.account { case .noCompanion,.offline: Task { await call.refresh() }; default: break }
    }
}
struct MacHomeView:View {
    let kind:MacHomeKind
    let name:String
    @ObservedObject var handoff:MacHandoff
    private static let blue=Color(red:0,green:162.0/255,blue:1)
    private var paired:Bool { handoff.link.connected }
    private var spacedCode:String { let c=handoff.link.code;return c.count==6 ? String(c.prefix(3))+" "+String(c.suffix(3)) : c }
    /// MAC-3 v2: "Pair it" opens MAC-P in place (paired users never see a code).
    @State private var pairing=false
    var body:some View {
        if MacDesignV2.enabled { v2Body } else { v1Body }
    }
    // MARK: Mac v2 (Figma 282:2 · MAC-2 / MAC-P / MAC-3 / MAC-4 / MAC-OFF): title → status row → body → buttons, one rhythm.
    private enum V2Screen:Equatable { case setup, pair, onPhone, here, offline(String) }
    private var v2Screen:V2Screen {
        switch kind {
        case .noCompanion: .setup
        case .onPhone: pairing && !paired ? .pair : .onPhone
        case .here: paired ? .here : .pair
        case .offline(let reason): .offline(reason)
        }
    }
    private var v2Title:String {
        switch v2Screen { case .setup: "Set up on your iPhone."; case .pair: "Pair with your iPhone."; case .onPhone: "\(name) is on your iPhone."; case .here: "\(name) is on this Mac."; case .offline: "Can’t reach Genita." }
    }
    private var v2Status:(String,MacV2Status.Kind) {
        switch v2Screen {
        case .setup: ("Waiting for your companion",.waiting)
        case .pair: ("Looking for your iPhone",.waiting)
        case .onPhone: ("Talking on your iPhone",.live)
        case .here: ("Paired with your iPhone",.live)
        case .offline: ("No connection",.idle)
        }
    }
    private func v2Para(_ text:String)->some View {
        Text(text).font(MacSheetInk.sans(15)).foregroundStyle(MacSheetInk.ink).lineSpacing(7).fixedSize(horizontal:false,vertical:true).frame(width:356,alignment:.leading)
    }
    private var v2Body:some View {
        VStack(alignment:.leading,spacing:0) {
            MacV2Title(text:v2Title)
            MacV2Status(text:v2Status.0,kind:v2Status.1,id:"macHomeStatus").padding(.top,10)
            switch v2Screen {
            case .setup:
                v2Para("Your companion is made on iPhone: face, voice and setup. They’ll show up here when you’re done.").padding(.top,16)
                MacV2Button(label:"Get Genita for iPhone",style:.secondary,id:"macGetGenita") { if let url=URL(string:"https://testflight.apple.com/join/Ybqh482p") {NSWorkspace.shared.open(url)} }.padding(.top,24)
            case .pair:
                MacPairingCode(code:handoff.link.code,connected:paired).padding(.top,16)
                if kind == .here && handoff.canMoveToPhone {
                    MacV2Button(label:"Move to iPhone",style:.secondary,id:"macMoveToPhone") { handoff.moveToPhone() }.padding(.top,24)
                }
                if kind == .onPhone {
                    MacV2Button(label:"Not now",style:.text,id:"macPairNotNow") { pairing=false }.frame(maxWidth:.infinity).padding(.top,12)
                }
            case .onPhone:
                MacV2Button(label:"Continue on this Mac",id:"macContinueHere") { handoff.continueHere() }.padding(.top,24)
                if !paired {
                    Rectangle().fill(Color(white:232.0/255)).frame(height:1).padding(.top,20)
                    HStack(spacing:6) {
                        Text("First time with this iPhone?").font(MacSheetInk.sans(14)).foregroundStyle(MacSheetInk.mute)
                        Button("Pair it") { pairing=true }.buttonStyle(.plain).font(MacSheetInk.sans(14)).foregroundStyle(MacSheetInk.ink).underline()
                            .padding(.horizontal,4).frame(height:44).contentShape(Rectangle()).accessibilityIdentifier("macPairIt")
                    }.frame(height:44).padding(.top,4)
                }
            case .here:
                HStack(spacing:12) {
                    if handoff.canMoveToPhone { MacV2Button(label:"Move to iPhone",style:.secondary,id:"macMoveToPhone") { handoff.moveToPhone() } }
                    MacV2Button(label:"Show screen",style:.secondary,id:"macShowScreen") { handoff.showRegistration() }
                }.padding(.top,24)
                Text("Show screen helps your iPhone find this display, so you can pass the call across.")
                    .font(MacSheetInk.sans(13)).foregroundStyle(MacSheetInk.mute).lineSpacing(5).fixedSize(horizontal:false,vertical:true).frame(width:356,alignment:.leading).padding(.top,16)
            case .offline(let reason):
                v2Para(reason).padding(.top,16)
                MacV2Button(label:"Try again",id:"macTryAgain") { Task { await MacCall.shared.refresh() } }.padding(.top,24)
            }
        }
        .padding(.horizontal,32).padding(.top,24).padding(.bottom,28).frame(width:420,alignment:.topLeading)
        .background(MacSheetInk.sheet)
        .animation(.easeOut(duration:0.2),value:v2Screen)
    }
    private var v1Body:some View {
        VStack(alignment:.leading,spacing:12) {
            Text(title).font(MacSheetInk.serif(28)).tracking(-0.28).foregroundStyle(MacSheetInk.ink).frame(height:34,alignment:.leading)
                .fixedSize(horizontal:true,vertical:false).accessibilityAddTraits(.isHeader)
            switch kind {
            case .noCompanion:
                Text("Your companion is made on iPhone: face, voice and setup. Open Genita there. They’ll show up here when you’re done.")
                    .font(MacSheetInk.sans(15)).foregroundStyle(MacSheetInk.ink).lineSpacing(3.5).fixedSize(horizontal:false,vertical:true).frame(width:356,alignment:.leading)
                HStack(spacing:8) {
                    Circle().strokeBorder(Color(white:227.0/255),lineWidth:2).frame(width:16,height:16)
                    Text("Checking for your companion").font(MacSheetInk.sans(15)).foregroundStyle(MacSheetInk.mute)
                }.frame(height:22)
                button("Get Genita for iPhone",filled:false,id:"macGetGenita") { if let url=URL(string:"https://testflight.apple.com/join/Ybqh482p") {NSWorkspace.shared.open(url)} }
            case .onPhone:
                statusRow("Conversation on your iPhone",live:true)
                button("Continue on this Mac",filled:true,id:"macContinueHere") { handoff.continueHere() }
                pairingBlock
            case .here:
                // MAC-4 (89:2). Only what works right now is shown — no greyed-out buttons (Chelsea 11/3).
                statusRow(paired ? "Paired with your iPhone" : "Signed in on this Mac",live:true)
                if handoff.canMoveToPhone || paired {
                    HStack(spacing:8) {
                        if handoff.canMoveToPhone { button("Move to iPhone",filled:false,height:44,id:"macMoveToPhone") { handoff.moveToPhone() } }
                        if paired { button("Show screen",filled:false,height:44,id:"macShowScreen") { handoff.showRegistration() } }
                    }
                }
                if paired {
                    Text("Show screen lets your iPhone learn where this screen is, so touching its edge moves the conversation.")
                        .font(MacSheetInk.sans(14)).foregroundStyle(MacSheetInk.mute).lineSpacing(3).fixedSize(horizontal:false,vertical:true).frame(width:356,alignment:.leading)
                } else { pairingBlock }   // first time, before any iPhone is paired: the code must stay reachable (MAC-3's block)
            case .offline(let reason):
                statusRow(reason,live:false)
                button("Try again",filled:true,id:"macTryAgain") { Task { await MacCall.shared.refresh() } }
            }
            // Sign out lives in the app menu (Genita ▸ Sign Out) and the call's Settings — not in this window (Figma).
        }
        .padding(.horizontal,32).padding(.top,32).padding(.bottom,28).frame(width:420,alignment:.topLeading)
        .background(MacSheetInk.sheet)
    }
    private var title:String {
        switch kind { case .noCompanion: "Set up on your iPhone."; case .onPhone: "\(name) is on your iPhone."; case .here: "\(name) is on this Mac."; case .offline: "Can’t reach Genita." }
    }
    /// "First time with this iPhone?" + the six digits (MAC-3 88:19 / 88:21).
    @ViewBuilder private var pairingBlock:some View {
        pairingBlockV1
    }
    @ViewBuilder private var pairingBlockV1:some View {
        Text("First time with this iPhone? Enter this code in Genita on your iPhone.")
            .font(MacSheetInk.sans(14)).foregroundStyle(MacSheetInk.mute).lineSpacing(3).fixedSize(horizontal:false,vertical:true).frame(width:356,alignment:.leading).padding(.top,8)
        Text(spacedCode).font(.system(size:15,design:.monospaced)).tracking(4).foregroundStyle(MacSheetInk.ink).textSelection(.enabled)
            .frame(maxWidth:.infinity).padding(.vertical,16).background(Color(white:241.0/255),in:RoundedRectangle(cornerRadius:12))
            .accessibilityLabel("Pairing code "+spacedCode).accessibilityIdentifier("macPairingCode")
    }
    private func statusRow(_ text:String,live:Bool)->some View {
        HStack(spacing:8) {
            Circle().fill(live ? Self.blue : Color(white:227.0/255)).frame(width:8,height:8)
            Text(text).font(MacSheetInk.sans(15)).foregroundStyle(MacSheetInk.mute)
        }.frame(height:22).accessibilityElement(children:.combine)
    }
    private func button(_ label:String,filled:Bool,height:CGFloat=50,id:String,action:@escaping()->Void)->some View {
        Button(action:action) {
            Text(label).font(MacSheetInk.sans(16,.medium)).foregroundStyle(filled ? MacSheetInk.onInk : MacSheetInk.ink)
                .frame(maxWidth:.infinity).frame(height:height).background(filled ? MacSheetInk.ink : Color.white,in:RoundedRectangle(cornerRadius:12))
        }.buttonStyle(.plain).accessibilityIdentifier(id)
    }
}

#if DEBUG
extension MacHandoff {
    /// CI review only: GENITA_MAC_REVIEW_OUT=<dir> writes the waiting screens as PNGs, then quits.
    func renderReviewScreens() async {
        guard let out=ProcessInfo.processInfo.environment["GENITA_MAC_REVIEW_OUT"] else{return}
        let dir=URL(fileURLWithPath:out);try? FileManager.default.createDirectory(at:dir,withIntermediateDirectories:true)
        for (name,next,stopped) in [("R2-mac",HandoffSurface.waiting,false),("R2-mac-sharing-stopped",.waiting,true),("R2E-mac",.waitingPeerUnreachable,false)] {
            surface=next;sharingStopped=stopped
            let host=NSHostingView(rootView:MacConversationView().frame(width:390,height:844))
            let window=NSWindow(contentRect:NSRect(x:0,y:0,width:390,height:844),styleMask:.borderless,backing:.buffered,defer:false)
            window.contentView=host;window.orderFront(nil)
            try? await Task.sleep(for:.seconds(1))
            if let rep=host.bitmapImageRepForCachingDisplay(in:host.bounds) {
                host.cacheDisplay(in:host.bounds,to:rep)
                try? rep.representation(using:.png,properties:[:])?.write(to:dir.appendingPathComponent(name+".png"))
            }
            window.orderOut(nil)
        }
        // #118 / #121: the call window's cue and MAC-RS / MAC-LINK, from wire events (no server)
        let call=CallController.shared
        call.companionName="Mina"
        for (name,scene,state,review) in [("C01-mac-thinking",MacResultFixture.Scene.searching,SheetState.idle,""),("MAC-RS-a",.searching,.searching,""),("MAC-RS-a-why",.refining,.searching,""),("MAC-RS-b",.results,.full,""),("MAC-RS-half",.results,.half,""),("MAC-RS-failed",.failed,.searching,""),("MAC-LINK-prompt",.results,.half,"link")] {
            surface = .active;sharingStopped=false
            if let ready=try? ServerEvent.decode(#"{"type":"ready","protocol":1,"sessionId":"review","mode":"chat","audio":{"in":"pcm_s16le_24000_mono","out":"pcm_s16le_24000_mono","frameHeaderBytes":8},"lip":{"requested":"none","active":"none"},"voiceId":"v","bargeIn":{"minMs":400,"minWords":2}}"#) {call.handle(ready)}
            if let thinking=try? ServerEvent.decode(#"{"type":"state","state":"thinking"}"#) {call.handle(thinking)}
            if state == .idle {call.finds.reset()} else {MacResultFixture.load(scene,into:call.finds,state:state)}
            let host=NSHostingView(rootView:MacConversationView(reviewOverride:review).frame(width:390,height:844))
            let window=NSWindow(contentRect:NSRect(x:0,y:0,width:390,height:844),styleMask:.borderless,backing:.buffered,defer:false)
            window.contentView=host;window.orderFront(nil)
            try? await Task.sleep(for:.seconds(1))
            if let rep=host.bitmapImageRepForCachingDisplay(in:host.bounds) {
                host.cacheDisplay(in:host.bounds,to:rep)
                try? rep.representation(using:.png,properties:[:])?.write(to:dir.appendingPathComponent(name+".png"))
            }
            window.orderOut(nil)
        }
        // MAC-2 / MAC-3 / MAC-4 home windows (420 wide, height follows the content) and MC-M (the menu over the call)
        call.companionName="Mina"
        do {
            reviewCanMove=true
            for (name,kind) in [("MAC-2",MacHomeKind.noCompanion),("MAC-3",.onPhone),("MAC-4",.here)] {
                let host=NSHostingView(rootView:MacHomeView(kind:kind,name:"Mina",handoff:self))
                let size=host.fittingSize
                host.frame=NSRect(origin:.zero,size:size)
                let window=NSWindow(contentRect:NSRect(origin:.zero,size:size),styleMask:.borderless,backing:.buffered,defer:false)
                window.contentView=host;window.orderFront(nil)
                try? await Task.sleep(for:.seconds(1))
                if let rep=host.bitmapImageRepForCachingDisplay(in:host.bounds) {
                    host.cacheDisplay(in:host.bounds,to:rep)
                    try? rep.representation(using:.png,properties:[:])?.write(to:dir.appendingPathComponent(name+".png"))
                }
                window.orderOut(nil)
            }
            surface = .active;sharingStopped=false
            let host=NSHostingView(rootView:MacConversationView(reviewOverride:"menu").frame(width:390,height:844))
            let window=NSWindow(contentRect:NSRect(x:0,y:0,width:390,height:844),styleMask:.borderless,backing:.buffered,defer:false)
            window.contentView=host;window.orderFront(nil)
            try? await Task.sleep(for:.seconds(1))
            if let rep=host.bitmapImageRepForCachingDisplay(in:host.bounds) {
                host.cacheDisplay(in:host.bounds,to:rep)
                try? rep.representation(using:.png,properties:[:])?.write(to:dir.appendingPathComponent("MC-M.png"))
            }
            window.orderOut(nil)
        }
        // MAC-REG at a 14-inch MacBook Pro's point size
        let size=NSSize(width:1512,height:982)
        let host=NSHostingView(rootView:RegistrationView(aspect:size.width/size.height).frame(width:size.width,height:size.height))
        let window=NSWindow(contentRect:NSRect(origin:.zero,size:size),styleMask:.borderless,backing:.buffered,defer:false)
        window.contentView=host;window.orderFront(nil)
        try? await Task.sleep(for:.seconds(1))
        if let rep=host.bitmapImageRepForCachingDisplay(in:host.bounds) {
            host.cacheDisplay(in:host.bounds,to:rep)
            try? rep.representation(using:.png,properties:[:])?.write(to:dir.appendingPathComponent("MAC-REG.png"))
        }
        exit(0)
    }
}
#endif
