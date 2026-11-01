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
    var canMoveToPhone:Bool { ownership.isOwner && phoneReachable && motion == nil }
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
    private var phoneReachable:Bool { link.connected && Date().timeIntervalSince1970-lastPong<3 }
    init() {
        ownership.transport=link
        ownership.onChange = { [weak self] old,new in self?.ownerChanged(from:old,to:new) }
        link.onMessage = { [weak self] in self?.receive($0) }
        link.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in:&subscriptions)
        sharing.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in:&subscriptions)
        link.host()
        if ownership.isOwner && ownership.state.epoch>0 {showCompanion()}
        refreshSurface()
        timer=Timer.scheduledTimer(withTimeInterval:1/30,repeats:true){ [weak self] _ in Task { @MainActor in self?.tick() } }
    }
    func showRegistration() {
        screen = screen ?? NSScreen.main
        guard let screen else{return}
        registration?.close()
        let window=NSWindow(contentRect:screen.frame,styleMask:.borderless,backing:.buffered,defer:false)
        window.isReleasedWhenClosed=false;window.level = .floating;window.backgroundColor = NSColor(red:0.027,green:0.592,blue:0.592,alpha:1)
        window.contentView=NSHostingView(rootView:RegistrationView())
        window.setFrame(screen.frame,display:true);window.makeKeyAndOrderFront(nil);registration=window
        NSApp.presentationOptions=[.autoHideDock,.autoHideMenuBar]
        status="Point your iPhone’s rear camera at this whole screen once"
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
        ownership.claimHere()
        status="Conversation on this Mac"
        if atEdge {prepare(outgoing:true)}
    }
    func moveToPhone() { guard canMoveToPhone else{return};link.send(["type":"moveRequest"]);status="Moving to your iPhone" }
    private func ownerChanged(from old:ConversationDevice,to new:ConversationDevice) {
        if new == .mac {
            sharingStopped=false;showCompanion()
        } else {
            if old == .mac {sharingStopped=sharing.isSharing}
            // The conversation left: sharing stops now and does not come back by itself.
            sharing.stop();sharing.permissionRequired=false;media.stopAll()
            candidate=nil;armed=false
            status="Conversation on your iPhone"
        }
        refreshSurface()
    }
    private func refreshSurface() {
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
            let display=(screen ?? NSScreen.main)?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
            link.send(["type":"welcome","identity":link.macID+"-"+(display?.stringValue ?? "main")])
        case "register": showRegistration()
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
            guard let p=HandoffPosition(message) else {last=nil;candidate=nil;status=message["reason"] as? String ?? "Finding the screen position";return}
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
            if pending.outgoing,!ownership.isOwner {ownership.claimHere()}
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

struct RegistrationView: View {
    var body:some View {
        ZStack {
            Color(red:0.027,green:0.592,blue:0.592)
            Rectangle().stroke(.white,lineWidth:7).padding(4)
            VStack(spacing:14){Text("Register this screen").font(.title);Text("Point your iPhone’s rear camera at this whole screen once.\nIt closes by itself when it’s registered.").multilineTextAlignment(.center);Button("Close"){MacHandoff.shared.closeRegistration()}}
                .padding(24).background(.black.opacity(0.6),in:RoundedRectangle(cornerRadius:16)).foregroundStyle(.white)
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
struct MacHandoffControls:View {
    @ObservedObject private var handoff=MacHandoff.shared
    var body:some View {
        VStack(spacing:16) {
            Text("Genita").font(.largeTitle)
            Text("First time? Enter this code on your iPhone.").foregroundStyle(.secondary)
            Text(handoff.link.code).font(.system(size:40,weight:.medium,design:.monospaced)).textSelection(.enabled)
            Text(handoff.link.status)
            Text(handoff.status).font(.callout).multilineTextAlignment(.center)
            HStack {Button("Register screen"){handoff.showRegistration()}.disabled(!handoff.link.connected);Button("Move to iPhone"){handoff.moveToPhone()}.disabled(!handoff.canMoveToPhone)}
            Text("The conversation itself isn’t connected yet. Screen sharing is available while the conversation is on this Mac.").font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }.padding(28).frame(width:420)
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
        exit(0)
    }
}
#endif
