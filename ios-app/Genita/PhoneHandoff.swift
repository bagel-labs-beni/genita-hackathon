import SwiftUI
import AVFoundation
import Combine

@MainActor final class PhoneHandoff: ObservableObject {
    static let shared = PhoneHandoff()
    let link = HandoffLink()
    let tracker = LidarWorldTracker()
    private let feedback = HandoffFeedback()
    @Published var desktop = false
    @Published var motion: TransitionPayload?
    @Published private(set) var renderedMotionID: String?
    var motionVisible: Bool { motion != nil && renderedMotionID == motion?.id }
    func effectReady(_ id:String) { guard motion?.id == id else{return};renderedMotionID=id }
    @Published var status = "Mac으로 이동"
    @Published var settings = false
    @Published var code = ""
    private var pending: [String: Any]?
    private var snapshot = ""
    private var clockOffset = 0.0
    private var generation = 0
    private var model: AppState?
    private var trackingURL: URL?
    private var launchConnected=false
    private var subscriptions = Set<AnyCancellable>()
    init() {
        link.onMessage = { [weak self] in self?.receive($0) }
        tracker.onReading = { [weak self] reading in
            guard let self else { return }; var packet=reading; packet["type"]="reading"
            self.link.send(packet, reliable:false)
        }
        link.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in:&subscriptions)
        tracker.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in:&subscriptions)
    }
    func attach(_ model: AppState) {
        self.model=model
        let args=ProcessInfo.processInfo.arguments
        if !launchConnected,let i=args.firstIndex(of:"--handoff-code"),args.indices.contains(i+1) {launchConnected=true;code=args[i+1];connect()}
    }
    func resume() { if link.connected,let trackingURL {tracker.start(trackingURL)} }
    func connect() { link.join(code) }
    func snapshotCall() {
        guard let model else { return }
        let renderer=ImageRenderer(content: ConversationView(model:model,handoffEnabled:false).frame(width:390,height:844).environment(\.colorScheme,.light))
        renderer.scale=2
        snapshot=renderer.uiImage?.pngData()?.base64EncodedString() ?? ""
    }
    func receive(_ data:[String:Any]) {
        switch data["type"] as? String {
        case "connected":
            guard let size=PhoneDisplayGeometry.meters else {status="이 iPhone 모델의 화면 크기 정보가 필요합니다";return}
            snapshotCall()
            link.send(["type":"hello","image":snapshot,"profile":model?.setup.imageData?.base64EncodedString() ?? "", "phoneHeight":size.height,"phoneWidth":size.width])
            settings=false
        case "welcome":
            guard let identity=data["identity"] as? String, let url=URL(string:"genita://"+identity) else{return}
            trackingURL=url;tracker.start(url);status="Mac 화면 등록 중"
        case "ping":
            link.send(["type":"pong","sent":data["sent"] ?? 0,"phone":Date().timeIntervalSince1970])
        case "clock": clockOffset=data["offset"] as? Double ?? 0
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
            status=outgoing ? "Mac으로 이동 중":"아이폰으로 이동 중"
            // The conversation owns its audio session. Handoff must not change
            // an active call category, microphone route, or speaker selection.
            try? feedback.schedule(delay:max(0,localStart-Date().timeIntervalSince1970),duration:3.2,outgoing:outgoing)
            try? feedback.scheduleNameDrop(delay:max(0,localStart-Date().timeIntervalSince1970),duration:3.2)
            DispatchQueue.main.asyncAfter(deadline:.now()+max(0,localStart+3.2-Date().timeIntervalSince1970)) {
                guard epoch==self.generation else{return};self.desktop=outgoing;self.motion=nil;self.pending=nil
                self.status=outgoing ? "Mac에서 이어지는 중 · 같은 위치에서 가져오기":"아이폰으로 돌아왔어요"
            }
        case "disconnected":
            generation+=1;pending=nil;motion=nil;desktop=false;feedback.cancel();tracker.stop();status="연결 끊김 · 아이폰 화면 복원됨"
        case "cancel":
            generation+=1;pending=nil;motion=nil;desktop=false;feedback.cancel();status="전환 취소 · 아이폰에서 대기"
        default: break
        }
    }
    func pause() { tracker.stop();link.send(["type":"inactive"]);generation+=1;motion=nil;desktop=false;feedback.cancel() }
}

struct PhoneHandoffOverlay: View {
    let model: AppState
    @ObservedObject private var handoff = PhoneHandoff.shared
    @Environment(\.scenePhase) private var phase
    var body: some View {
        ZStack(alignment:.top) {
            if handoff.motionVisible { Color.black.ignoresSafeArea() }
            if handoff.desktop { Color.black.ignoresSafeArea(); VStack(spacing:16) { Image(systemName:"desktopcomputer").font(.largeTitle);Text("Mac에서 이어지는 중");Text("같은 가장자리에 폰을 가져간 뒤\nMac에서 ‘아이폰으로’를 눌러주세요").font(.caption).multilineTextAlignment(.center) }.foregroundStyle(.white).frame(maxHeight:.infinity) }
            if let motion=handoff.motion { DuoTransition(payload:motion,onReady:handoff.effectReady).ignoresSafeArea().allowsHitTesting(false) }
            // Pairing opens from More → Move to Mac; the top of the call is the status line's slot.
        }.onAppear { handoff.attach(model) }
        .onChange(of:phase) { _,new in if new != .active { handoff.pause() } else { handoff.resume() } }
        .sheet(isPresented:$handoff.settings) {
            VStack(spacing:20) {
                Text("Mac으로 이동").font(.title2)
                Text("Mac의 Genita에 표시된 연결 코드 6자리를 입력하세요.")
                TextField("연결 코드",text:$handoff.code).keyboardType(.numberPad).textFieldStyle(.roundedBorder)
                Button("연결",action:handoff.connect).buttonStyle(.borderedProminent)
                Text(handoff.link.status)
                if handoff.link.connected {
                    Text(handoff.tracker.status).font(.caption)
                    Button("화면 다시 등록") { handoff.tracker.resetScreen();handoff.link.send(["type":"register"]);handoff.settings=false }
                    HStack {Text("중앙 보정 ↓ \(Int(handoff.tracker.centerDownMM))mm");Slider(value:Binding(get:{handoff.tracker.centerDownMM},set:{handoff.tracker.centerDownMM=$0}),in:0...90,step:1)}
                    HStack {Text("→ \(Int(handoff.tracker.centerRightMM))mm");Slider(value:Binding(get:{handoff.tracker.centerRightMM},set:{handoff.tracker.centerRightMM=$0}),in:-35...35,step:1)}
                }
                Text("LiDAR 지원 iPhone에서 화면 위치를 한 번 등록합니다. 현재 대화 화면은 데모이며 영상통화는 연결하지 않습니다.").font(.footnote).foregroundStyle(.secondary)
            }.padding(24).presentationDetents([.medium,.large])
        }
    }
}
