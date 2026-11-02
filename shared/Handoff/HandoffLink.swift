import Foundation
import MultipeerConnectivity
import Combine
#if canImport(UIKit)
import UIKit
#endif

/// A Mac this iPhone paired with once. Later moves reconnect with the token, not the code.
struct RememberedMac: Codable, Equatable { let mac: String; let token: String }

/// Encrypted local peer connection. The Mac advertises a session code and a stable
/// ID. The phone invites the Mac whose code the user entered once, then the Mac whose
/// ID it remembers. No web server is required.
final class HandoffLink: NSObject, ObservableObject, MCSessionDelegate, MCNearbyServiceAdvertiserDelegate, MCNearbyServiceBrowserDelegate {
    @Published var connected = false
    @Published var status = "Not connected"
    @Published var code = ""
    @Published private(set) var remembered: RememberedMac?
    var onMessage: (([String: Any]) -> Void)?
    /// The phone keeps looking for its remembered Mac while this is on.
    var autoReconnect = false
    /// True for the connection that was made with the six-digit code.
    private(set) var pairedWithCode = false
    // ProcessInfo.hostName does a blocking reverse-DNS lookup on the main thread (37 s on launch).
    private let peer = MCPeerID(displayName: String(HandoffLink.deviceName.prefix(40)))
    private static var deviceName: String {
        #if os(macOS)
        return Host.current().localizedName ?? "Mac"
        #else
        return UIDevice.current.name
        #endif
    }
    private lazy var session = makeSession()
    private var advertiser: MCNearbyServiceAdvertiser?
    private var browser: MCNearbyServiceBrowser?
    private var invited = false
    private var incomingUsedCode = false
    private let service = "genita-handoff"
    private let store: UserDefaults
    private let rememberedKey = "genita.handoff.rememberedMac"
    private let tokensKey = "genita.handoff.pairedTokens"
    private let macIDKey = "genita.handoff.macID"
    init(store: UserDefaults = .standard) {
        self.store = store
        super.init()
        remembered = store.data(forKey: rememberedKey).flatMap { try? JSONDecoder().decode(RememberedMac.self, from: $0) }
    }
    private func makeSession() -> MCSession {
        let session = MCSession(peer: peer, securityIdentity: nil, encryptionPreference: .required)
        session.delegate = self
        return session
    }
    /// Stable ID of this Mac across launches. Advertised in the clear; it is not a secret.
    var macID: String {
        if let value = store.string(forKey: macIDKey) { return value }
        let value = UUID().uuidString.lowercased(); store.set(value, forKey: macIDKey); return value
    }
    func host() {
        code = String(Int.random(in: 100000...999999))
        advertiser = MCNearbyServiceAdvertiser(peer: peer, discoveryInfo: ["code": code, "mac": macID], serviceType: service)
        advertiser?.delegate = self; advertiser?.startAdvertisingPeer()
        status = "Waiting for your iPhone"
    }
    func join(_ code: String) {
        guard code.count == 6 else { status = "Enter the six digits shown on your Mac"; return }
        self.code = code
        startBrowsing()
    }
    /// Look for the remembered Mac again. Does nothing if there is none or the link is up.
    func reconnect() {
        guard remembered != nil, !connected else { return }
        code = ""
        startBrowsing()
    }
    func forgetMac() {
        remembered = nil; store.removeObject(forKey: rememberedKey)
        autoReconnect = false; code = ""
        browser?.stopBrowsingForPeers(); browser = nil
        session.disconnect()
        status = "Not connected"
    }
    private func startBrowsing() {
        invited = false
        browser?.stopBrowsingForPeers()
        // A session that has been dropped does not always accept a new connection.
        session.disconnect(); session = makeSession()
        browser = MCNearbyServiceBrowser(peer: peer, serviceType: service)
        browser?.delegate = self; browser?.startBrowsingForPeers(); status = "Looking for your Mac"
    }
    func send(_ object: [String: Any], reliable: Bool = true) {
        guard !session.connectedPeers.isEmpty, let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        do { try session.send(data, toPeers: session.connectedPeers, with: reliable ? .reliable : .unreliable) }
        catch { DispatchQueue.main.async { self.status = "Couldn’t send. Checking the connection." } }
    }
    func browser(_ browser: MCNearbyServiceBrowser, foundPeer peerID: MCPeerID, withDiscoveryInfo info: [String: String]?) {
        guard !invited else { return }
        let context: String
        if !code.isEmpty, info?["code"] == code { context = "code:" + code }
        else if let remembered, code.isEmpty, info?["mac"] == remembered.mac { context = "token:" + remembered.token }
        else { return }
        invited = true
        browser.invitePeer(peerID, to: session, withContext: context.data(using: .utf8), timeout: 15)
    }
    func browser(_ browser: MCNearbyServiceBrowser, lostPeer peerID: MCPeerID) { if !connected { invited = false } }
    func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didReceiveInvitationFromPeer peerID: MCPeerID, withContext context: Data?, invitationHandler: @escaping (Bool, MCSession?) -> Void) {
        let text = context.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        let byCode = text == "code:" + code && session.connectedPeers.isEmpty
        // A remembered phone may return before the session has noticed its old connection is gone.
        let byToken = text.hasPrefix("token:") && pairedTokens.contains(String(text.dropFirst(6)))
        if byCode { incomingUsedCode = true }
        invitationHandler(byCode || byToken, byCode || byToken ? session : nil)
    }
    private var pairedTokens: [String] { store.stringArray(forKey: tokensKey) ?? [] }
    /// Give the phone a token after a code pairing so it never needs the code again.
    private func issueToken() {
        let token = UUID().uuidString.lowercased()
        store.set(pairedTokens + [token], forKey: tokensKey)
        send(["type": "paired", "mac": macID, "token": token])
    }
    func session(_ session: MCSession, peer peerID: MCPeerID, didChange state: MCSessionState) {
        DispatchQueue.main.async {
            guard session === self.session else { return }
            self.connected = !session.connectedPeers.isEmpty
            self.status = self.connected ? "Connected" : state == .connecting ? "Connecting" : "Not connected"
            if state == .connected {
                self.pairedWithCode = self.incomingUsedCode || !self.code.isEmpty
                if self.incomingUsedCode { self.incomingUsedCode = false; self.issueToken() }
                self.onMessage?(["type": "connected", "peer": peerID.displayName])
            }
            if state == .notConnected {
                self.invited = false
                if !self.connected { self.onMessage?(["type": "disconnected"]); self.retryIfWanted() }
            }
        }
    }
    private func retryIfWanted() {
        guard autoReconnect else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, self.autoReconnect else { return }
            self.reconnect()
        }
    }
    func session(_ session: MCSession, didReceive data: Data, fromPeer peerID: MCPeerID) {
        guard data.count < 12_000_000, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        DispatchQueue.main.async {
            if object["type"] as? String == "paired", let mac = object["mac"] as? String, let token = object["token"] as? String { self.remember(RememberedMac(mac: mac, token: token)) }
            self.onMessage?(object)
        }
    }
    private func remember(_ mac: RememberedMac) {
        remembered = mac; code = ""
        if let data = try? JSONEncoder().encode(mac) { store.set(data, forKey: rememberedKey) }
    }
    func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didNotStartAdvertisingPeer error: Error) { DispatchQueue.main.async { self.status = error.localizedDescription } }
    func browser(_ browser: MCNearbyServiceBrowser, didNotStartBrowsingForPeers error: Error) { DispatchQueue.main.async { self.status = error.localizedDescription } }
    func session(_ session: MCSession, didReceive stream: InputStream, withName streamName: String, fromPeer peerID: MCPeerID) {}
    func session(_ session: MCSession, didStartReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, with progress: Progress) {}
    func session(_ session: MCSession, didFinishReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, at localURL: URL?, withError error: Error?) {}
}

extension HandoffLink: OwnershipTransport {
    func publish(_ claim: OwnershipClaim) { send(claim.message) }
}
