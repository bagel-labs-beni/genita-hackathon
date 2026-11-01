import SwiftUI
import AppKit
import Combine

@MainActor final class MacHandoff: ObservableObject {
    static let shared = MacHandoff()
    let link = HandoffLink()
    @Published var status = "아이폰 연결 대기"
    @Published var desktop = false
    @Published var motion: TransitionPayload?
    @Published private(set) var renderedMotionID:String?
    var motionVisible:Bool { motion != nil && renderedMotionID == motion?.id }
    func effectReady(_ id:String) { guard motion?.id==id else{return};renderedMotionID=id }
    private var returnOrigin:NSPoint?
    @Published var canReturn = false
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
    private var identity:String {
        let key="genita.handoff.identity"
        if let value=UserDefaults.standard.string(forKey:key){return value}
        let value=UUID().uuidString.lowercased();UserDefaults.standard.set(value,forKey:key);return value
    }
    init() {
        link.onMessage = { [weak self] in self?.receive($0) }
        link.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in:&subscriptions)
        link.host()
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
        status="아이폰 후면 카메라로 이 화면 전체를 한 번 비춰주세요"
    }
    func closeRegistration() { guard registration != nil else{return};registration?.close();registration=nil;NSApp.presentationOptions=[] }
    private func ensureCompanion() {
        guard companion == nil else{return}
        let window=NSWindow(contentRect:NSRect(x:0,y:0,width:390,height:844),styleMask:.borderless,backing:.buffered,defer:false)
        window.isReleasedWhenClosed=false;window.isOpaque=false;window.backgroundColor = .clear;window.hasShadow=false;window.level = .floating
        window.collectionBehavior=[.fullScreenAuxiliary];window.contentView=NSHostingView(rootView:MacHandoffSurface())
        companion=window
    }
    func receive(_ message:[String:Any]) {
        let now=Date().timeIntervalSince1970
        switch message["type"] as? String {
        case "connected": lastPong=now;bestRTT = .infinity;status="아이폰 연결됨"
        case "hello":
            image=message["image"] as? String ?? "";profile=(message["profile"] as? String).flatMap { Data(base64Encoded:$0) }
            if let h=message["phoneHeight"] as? Double,let w=message["phoneWidth"] as? Double,(0.09...0.2).contains(h),(0.04...0.1).contains(w){phoneHeight=h;phoneWidth=w}
            showRegistration()
            let display=screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
            link.send(["type":"welcome","identity":identity+"-"+(display?.stringValue ?? "main")])
        case "register": showRegistration()
        case "pong":
            lastPong=now
            if let sent=message["sent"] as? Double,let phone=message["phone"] as? Double {
                let rtt=now-sent
                if rtt>=0 && rtt<bestRTT {bestRTT=rtt;link.send(["type":"clock","offset":phone-(sent+now)/2])}
            }
        case "reading":
            guard let p=HandoffPosition(message) else {last=nil;candidate=nil;canReturn=false;status=message["reason"] as? String ?? "화면 위치 찾는 중";return}
            last=p;lastAt=now;closeRegistration()
            let edge=p.touchesEdge(phoneHeight:phoneHeight)
            status="\(p.right ? "오른쪽":"왼쪽") · 화면 중앙에서 \(Int(p.y*100))cm · \(desktop ? "Mac에서 이어지는 중":"아이폰에서 대기")"
            if !edge {armed=true;candidate=nil;return}
            guard !desktop,motion == nil,pending == nil,armed,!image.isEmpty else{return}
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
            ensureCompanion();companion?.orderFrontRegardless();self.pending=nil;epoch+=1;let e=epoch
            DispatchQueue.main.asyncAfter(deadline:.now()+4) {
                guard self.epoch==e else{return}
                self.desktop=pending.outgoing;self.motion=nil;self.candidate=nil
                if !pending.outgoing {self.companion?.orderOut(nil);self.armed=false}
            }
        case "disconnected": reset(notify:false);status="아이폰 연결 중단 · 화면 복원됨"
        case "inactive":
            if desktop || motion != nil {reset(notify:false)}
            else {last=nil;candidate=nil;canReturn=false}
        default:break
        }
    }
    func returnToPhone() { guard canReturn else{return};prepare(outgoing:false) }
    private func prepare(outgoing:Bool) {
        guard link.connected,nowFresh,motion == nil,pending == nil else{return}
        let id=UUID().uuidString;pending=(id,outgoing,Date().timeIntervalSince1970);canReturn=false
        link.send(["type":"prepare","id":id,"outgoing":outgoing])
    }
    private var nowFresh:Bool { Date().timeIntervalSince1970-lastAt<1 && Date().timeIntervalSince1970-lastPong<3 }
    func reset(notify:Bool=true) {
        epoch+=1;motion=nil;pending=nil;desktop=false;candidate=nil;last=nil;canReturn=false;armed=true
        companion?.orderOut(nil);closeRegistration();if notify {link.send(["type":"cancel"])}
    }
    private func tick() {
        let now=Date().timeIntervalSince1970
        if now-diagnosticAt>0.5 {
            diagnosticAt=now
            let root=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("Genita/Handoff")
            try? FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
            var data:[String:Any] = ["at":now,"code":link.code,"connected":link.connected,"status":status,"desktop":desktop,"canReturn":canReturn,"imageReady":!image.isEmpty,"rtt":bestRTT.isFinite ? bestRTT : -1]
            if let last {data["position"]=["x":last.x,"y":last.y,"z":last.z,"width":last.width,"height":last.height]}
            if let bytes=try? JSONSerialization.data(withJSONObject:data,options:.prettyPrinted) {try? bytes.write(to:root.appendingPathComponent("state.json"),options:.atomic)}
        }
        if link.connected,now-pingAt>0.5 {pingAt=now;link.send(["type":"ping","sent":now])}
        if link.connected,now-lastPong>3,(desktop || motion != nil || pending != nil){reset();status="아이폰 응답 없음 · 전환 취소"}
        if let pending,now-pending.time>2 {self.pending=nil;candidate=nil;link.send(["type":"cancel"]);status="아이폰 전환 준비 시간 초과"}
        canReturn=desktop && motion == nil && pending == nil && nowFresh && last.map { p in dock.map { p.sameDock($0) && p.touchesEdge(phoneHeight:phoneHeight) } ?? false } == true
        if let motion,!motion.outgoing,now<motion.start,let last,last.touchesEdge(phoneHeight:phoneHeight),last.right==dock?.right {dock=last}
        guard let screen,let dock,let window=companion,desktop || motion != nil else{return}
        if desktop && motion == nil {return} // Preserve native mouse dragging after arrival.
        let display=(screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? CGMainDisplayID()
        let mm=CGDisplayScreenSize(display)
        // The same physical phone size, independent of Retina backing pixels.
        let pointsPerM=mm.height>0 ? screen.frame.height/(mm.height/1000) : screen.frame.height/dock.height
        let size=NSSize(width:phoneWidth*pointsPerM,height:phoneHeight*pointsPerM)
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
            VStack(spacing:14){Text("Genita 화면 연결").font(.title);Text("아이폰 후면 카메라로 화면 전체를 한 번 비춰주세요.\n등록되면 이 화면이 닫히고, 실제 데스크탑에서 이동할 수 있어요.").multilineTextAlignment(.center);Button("닫기"){MacHandoff.shared.closeRegistration()}}
                .padding(24).background(.black.opacity(0.6),in:RoundedRectangle(cornerRadius:16)).foregroundStyle(.white)
        }.ignoresSafeArea()
    }
}
struct MacHandoffSurface: View {
    @ObservedObject private var handoff=MacHandoff.shared
    var body:some View {
        GeometryReader { geometry in
            ZStack {
                if handoff.desktop {MacConversationView().opacity(handoff.motionVisible ? 0 : 1).scaleEffect(x:geometry.size.width/390,y:geometry.size.height/844,anchor:.topLeading).frame(width:geometry.size.width,height:geometry.size.height,alignment:.topLeading)}
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
            Text("아이폰의 ‘Mac으로 이동’에 입력").foregroundStyle(.secondary)
            Text(handoff.link.code).font(.system(size:40,weight:.medium,design:.monospaced)).textSelection(.enabled)
            Text(handoff.link.status)
            Text(handoff.status).font(.callout).multilineTextAlignment(.center)
            HStack {Button("화면 등록"){handoff.showRegistration()}.disabled(!handoff.link.connected);Button("아이폰으로"){handoff.returnToPhone()}.disabled(!handoff.canReturn)}
            Text("통화 연결 전 프로토타입 · Mac으로 이동한 뒤 화면공유 가능").font(.caption).foregroundStyle(.secondary)
        }.padding(28).frame(width:420)
    }
}
