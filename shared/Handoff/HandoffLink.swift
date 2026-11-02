import Foundation
import MultipeerConnectivity
import Combine

/// Encrypted local peer connection. The Mac advertises a session code; the phone
/// only invites the Mac whose code the user entered. No web server is required.
final class HandoffLink: NSObject, ObservableObject, MCSessionDelegate, MCNearbyServiceAdvertiserDelegate, MCNearbyServiceBrowserDelegate {
    @Published var connected = false
    @Published var status = "연결 대기"
    @Published var code = ""
    var onMessage: (([String: Any]) -> Void)?
    private let peer = MCPeerID(displayName: String(ProcessInfo.processInfo.hostName.prefix(40)))
    private lazy var session = MCSession(peer: peer, securityIdentity: nil, encryptionPreference: .required)
    private var advertiser: MCNearbyServiceAdvertiser?
    private var browser: MCNearbyServiceBrowser?
    private var invited = false
    private let service = "genita-handoff"
    override init() { super.init(); session.delegate = self }
    func host() {
        code = String(Int.random(in: 100000...999999))
        advertiser = MCNearbyServiceAdvertiser(peer: peer, discoveryInfo: ["code": code], serviceType: service)
        advertiser?.delegate = self; advertiser?.startAdvertisingPeer()
        status = "아이폰에 연결 코드 입력"
    }
    func join(_ code: String) {
        guard code.count == 6 else { status = "Mac의 숫자 6자리를 입력하세요"; return }
        self.code = code; invited = false; session.disconnect(); browser?.stopBrowsingForPeers()
        browser = MCNearbyServiceBrowser(peer: peer, serviceType: service)
        browser?.delegate = self; browser?.startBrowsingForPeers(); status = "Mac 찾는 중"
    }
    func send(_ object: [String: Any], reliable: Bool = true) {
        guard !session.connectedPeers.isEmpty, let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        do { try session.send(data, toPeers: session.connectedPeers, with: reliable ? .reliable : .unreliable) }
        catch { DispatchQueue.main.async { self.status = "전송 실패 · 연결 확인 중" } }
    }
    func browser(_ browser: MCNearbyServiceBrowser, foundPeer peerID: MCPeerID, withDiscoveryInfo info: [String: String]?) {
        guard info?["code"] == code, !invited else { return }; invited = true
        browser.invitePeer(peerID, to: session, withContext: code.data(using: .utf8), timeout: 15)
    }
    func browser(_ browser: MCNearbyServiceBrowser, lostPeer peerID: MCPeerID) { if !connected { invited = false } }
    func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didReceiveInvitationFromPeer peerID: MCPeerID, withContext context: Data?, invitationHandler: @escaping (Bool, MCSession?) -> Void) {
        let allowed = session.connectedPeers.isEmpty && context.flatMap { String(data: $0, encoding: .utf8) } == code
        invitationHandler(allowed, allowed ? session : nil)
    }
    func session(_ session: MCSession, peer peerID: MCPeerID, didChange state: MCSessionState) {
        DispatchQueue.main.async {
            self.connected = state == .connected
            self.status = state == .connected ? "연결됨" : state == .connecting ? "연결 중" : "연결 끊김 · 다시 연결하세요"
            if state == .notConnected { self.invited = false }
            if state == .connected { self.onMessage?(["type": "connected", "peer": peerID.displayName]) }
            if state == .notConnected { self.onMessage?(["type": "disconnected"]) }
        }
    }
    func session(_ session: MCSession, didReceive data: Data, fromPeer peerID: MCPeerID) {
        guard data.count < 12_000_000, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        DispatchQueue.main.async { self.onMessage?(object) }
    }
    func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didNotStartAdvertisingPeer error: Error) { DispatchQueue.main.async { self.status = error.localizedDescription } }
    func browser(_ browser: MCNearbyServiceBrowser, didNotStartBrowsingForPeers error: Error) { DispatchQueue.main.async { self.status = error.localizedDescription } }
    func session(_ session: MCSession, didReceive stream: InputStream, withName streamName: String, fromPeer peerID: MCPeerID) {}
    func session(_ session: MCSession, didStartReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, with progress: Progress) {}
    func session(_ session: MCSession, didFinishReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, at localURL: URL?, withError error: Error?) {}
}
