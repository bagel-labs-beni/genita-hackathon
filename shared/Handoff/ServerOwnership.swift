import Foundation
import Security

/// F6-L7 on the apps: the server's conversation layer (genita-server `/v1/presence`, PROTOCOL.md
/// "Handoff"). When the server is reachable it decides who holds the sound and relays Move to Mac /
/// Move to iPhone, so a button move needs no local pairing. The local link stays as the fallback and
/// as the effect layer (position, Duo transition). Both carry the same claims and both devices apply
/// them with `ConversationOwnership.apply`, so it does not matter which one arrives first.

extension ConversationDevice {
    /// The server's spelling (conversations.active_device).
    var serverName: String { self == .phone ? "iphone" : "mac" }
    init?(serverName: String?) {
        switch serverName { case "iphone", "phone": self = .phone; case "mac": self = .mac; default: return nil }
    }
    var other: ConversationDevice { self == .phone ? .mac : .phone }
}

/// What `/v1/presence` sends. Unknown types are ignored, never fatal.
enum PresenceEvent: Equatable {
    /// owner nil = released (nobody has the sound until the next call start)
    case ownership(owner: ConversationDevice?, epoch: Int, trigger: String)
    case claimResult(accepted: Bool, owner: ConversationDevice?, epoch: Int)
    /// `inCall`: the other device has a started call open right now (server 11/4). nil = an older server that does not say.
    case peer(device: ConversationDevice, online: Bool, active: Bool, inCall: Bool? = nil)
    case moveRequest(from: ConversationDevice)
    case moveFailed(reason: String)
    case other(String)

    init?(_ m: [String: Any]) {
        guard let type = m["type"] as? String else { return nil }
        let epoch = m["epoch"] as? Int
        switch type {
        case "ownership":
            guard let epoch else { return nil }
            self = .ownership(owner: ConversationDevice(serverName: m["owner"] as? String), epoch: epoch, trigger: m["trigger"] as? String ?? "")
        case "claim.result":
            guard let epoch, let accepted = m["accepted"] as? Bool else { return nil }
            self = .claimResult(accepted: accepted, owner: ConversationDevice(serverName: m["owner"] as? String), epoch: epoch)
        case "peer":
            guard let d = ConversationDevice(serverName: m["device"] as? String), let online = m["online"] as? Bool else { return nil }
            self = .peer(device: d, online: online, active: m["active"] as? Bool ?? online, inCall: m["inCall"] as? Bool)
        case "move.request":
            guard let d = ConversationDevice(serverName: m["from"] as? String) else { return nil }
            self = .moveRequest(from: d)
        case "move.failed": self = .moveFailed(reason: m["reason"] as? String ?? "")
        default: self = .other(type)
        }
    }
}

/// What the device does with a server event. Pure, so the rules are unit tested.
enum PresenceEffect: Equatable {
    /// hand to `OwnershipCoordinator.receive` (stale claims are ignored there)
    case apply(OwnershipClaim)
    /// the other device asked to move here: claim if this app is in front
    case moveRequested(from: ConversationDevice)
    case moveFailed(reason: String)
    case peerChanged
}

/// The server side of one device's handoff state.
struct PresenceState: Equatable {
    var connected = false
    var peerOnline = false
    var peerActive = false
    /// nil until a server that reports calls says so (older servers never send `inCall`).
    var peerInCall: Bool?
    /// Owner nil means the server released the conversation; the device keeps its own state.
    static func reduce(_ state: inout PresenceState, _ event: PresenceEvent, me: ConversationDevice) -> [PresenceEffect] {
        switch event {
        case let .ownership(owner, epoch, _), let .claimResult(_, owner, epoch):
            guard let owner else { return [] }
            return [.apply(OwnershipClaim(owner: owner, epoch: epoch))]
        case let .peer(device, online, active, inCall):
            guard device != me else { return [] }
            let changed = state.peerOnline != online || state.peerActive != active || state.peerInCall != inCall
            state.peerOnline = online; state.peerActive = active; state.peerInCall = inCall
            return changed ? [.peerChanged] : []
        case let .moveRequest(from):
            return from == me ? [] : [.moveRequested(from: from)]
        case let .moveFailed(reason):
            return [.moveFailed(reason: reason)]
        case .other:
            return []
        }
    }
    /// Message the device sends for a claim it publishes. Its own claim is a `claim` (counted as a move);
    /// a claim it only learned about (reconnect sync) is a `hello` so the server never sees it as a tap.
    static func message(for claim: OwnershipClaim, me: ConversationDevice, trigger: String, active: Bool) -> [String: Any] {
        claim.owner == me && claim.epoch > 0
            ? ["type": "claim", "epoch": claim.epoch, "trigger": trigger]
            : ["type": "hello", "owner": claim.owner.serverName, "epoch": claim.epoch, "active": active]
    }
}

/// Where `/v1/presence` is. Same keys as the call client (`GENITA_SERVER_URL` / defaults
/// `genita.server.url`, which point at `/v1/session`) and the same session token.
struct PresenceEndpoint: Equatable {
    var url: URL
    var token: String?
    static func current(device: ConversationDevice, environment: [String: String] = ProcessInfo.processInfo.environment, defaults: UserDefaults = .standard) -> PresenceEndpoint? {
        let raw = environment["GENITA_PRESENCE_URL"] ?? defaults.string(forKey: "genita.presence.url") ?? environment["GENITA_SERVER_URL"] ?? defaults.string(forKey: "genita.server.url") ?? "ws://127.0.0.1:8787/v1/session"
        guard var c = URLComponents(string: raw), let scheme = c.scheme, ["ws", "wss"].contains(scheme) else { return nil }
        if c.path.hasSuffix("/v1/session") { c.path = String(c.path.dropLast("/v1/session".count)) + "/v1/presence" }
        else if !c.path.hasSuffix("/v1/presence") { c.path = (c.path.hasSuffix("/") ? String(c.path.dropLast()) : c.path) + "/v1/presence" }
        c.queryItems = (c.queryItems ?? []).filter { $0.name != "device" } + [URLQueryItem(name: "device", value: device.serverName)]
        guard let url = c.url else { return nil }
        let token = PresenceEndpoint.sessionToken() ?? environment["GENITA_SESSION_TOKEN"] ?? defaults.string(forKey: "genita.session.token")
        return PresenceEndpoint(url: url, token: token)
    }
    /// The signed-in user's session JWT saved by GenitaKit's KeychainTokenStore (read-only here).
    static func sessionToken() -> String? {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "ai.thebeni.genita.session",
                                kSecAttrAccount as String: "session", kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        #if os(iOS)
        q[kSecUseDataProtectionKeychain as String] = true
        #endif
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

/// The presence socket. Reconnects with backoff while `wanted`; events arrive on the main queue.
final class ServerOwnershipLink: NSObject, ObservableObject, URLSessionWebSocketDelegate, OwnershipTransport {
    let device: ConversationDevice
    @Published private(set) var state = PresenceState()
    var onEffect: ((PresenceEffect) -> Void)?
    /// Called when the socket opens; the owner of this link answers with `hello` via `publishCurrent`.
    var onConnect: (() -> Void)?
    /// Every message, before the ownership reducer (proximity handoff reads its own types and the move's trigger here).
    var onMessage: (([String: Any]) -> Void)?
    /// The trigger reported with this device's next claim (`button`, `touch`, `continue`).
    var nextTrigger = "continue"
    private(set) var active = true
    private var wanted = false
    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var backoff = 1.0
    private var generation = 0
    private var pingTimer: Timer?
    private let endpoint: () -> PresenceEndpoint?

    init(device: ConversationDevice, endpoint: (() -> PresenceEndpoint?)? = nil) {
        self.device = device
        self.endpoint = endpoint ?? { PresenceEndpoint.current(device: device) }
        super.init()
    }
    var connected: Bool { state.connected }
    /// The other device is running Genita and signed in to the same account.
    var peerOnline: Bool { state.connected && state.peerOnline }
    var peerActive: Bool { peerOnline && state.peerActive }
    /// The other device is in a started call (nil: the server doesn't report calls).
    var peerInCall: Bool? { state.connected ? state.peerInCall : nil }

    func start() {
        guard !wanted else { return }
        wanted = true; connect()
    }
    func stop() {
        wanted = false; generation += 1
        pingTimer?.invalidate(); pingTimer = nil
        task?.cancel(with: .goingAway, reason: nil); task = nil
        session?.invalidateAndCancel(); session = nil
        state = PresenceState(); nextTrigger = "continue"; backoff = 1
    }
    func setActive(_ value: Bool) {
        active = value
        send(["type": "presence", "active": value])
    }
    func moveRequest(to target: ConversationDevice) { send(["type": "move.request", "to": target.serverName]) }
    func publish(_ claim: OwnershipClaim) {
        send(PresenceState.message(for: claim, me: device, trigger: nextTrigger, active: active))
        nextTrigger = "continue"
    }
    func send(_ object: [String: Any]) {
        guard state.connected, let task, let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { _ in }
    }

    private func connect() {
        guard wanted, let endpoint = endpoint() else { return }
        generation += 1; let gen = generation
        var request = URLRequest(url: endpoint.url)
        request.timeoutInterval = 8
        if let token = endpoint.token, !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = false
        let session = URLSession(configuration: config, delegate: self, delegateQueue: .main)
        let task = session.webSocketTask(with: request)
        self.session = session; self.task = task
        task.resume()
        receive(task, gen)
    }
    private func receive(_ task: URLSessionWebSocketTask, _ gen: Int) {
        task.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self, gen == self.generation else { return }
                switch result {
                case let .success(.string(text)):
                    if let data = text.data(using: .utf8), let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        self.onMessage?(object)
                        if let event = PresenceEvent(object) {
                            for effect in PresenceState.reduce(&self.state, event, me: self.device) { self.onEffect?(effect) }
                        }
                    }
                    self.receive(task, gen)
                case .success:
                    self.receive(task, gen)
                case .failure:
                    self.dropped(gen)
                }
            }
        }
    }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        guard webSocketTask === task else { return }
        backoff = 1
        state.connected = true
        onConnect?()
        pingTimer?.invalidate()
        pingTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in self?.send(["type": "ping", "t": Date().timeIntervalSince1970]) }
    }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard webSocketTask === task else { return }
        dropped(generation)
    }
    private func dropped(_ gen: Int) {
        guard gen == generation else { return }
        generation += 1
        pingTimer?.invalidate(); pingTimer = nil
        task = nil; session?.invalidateAndCancel(); session = nil
        let wasConnected = state.connected
        state = PresenceState()
        if wasConnected { onEffect?(.peerChanged) }
        guard wanted else { return }
        let delay = backoff; backoff = min(backoff * 2, 15)
        let retryGeneration = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, self.wanted, self.generation == retryGeneration, self.task == nil else { return }
            self.connect()
        }
    }
}

/// Sends every claim over both the server and the local link. The coordinator holds transports weakly,
/// so the device's handoff object keeps this alive.
final class OwnershipFanout: OwnershipTransport {
    private let transports: [OwnershipTransport]
    init(_ transports: [OwnershipTransport]) { self.transports = transports }
    func publish(_ claim: OwnershipClaim) { for t in transports { t.publish(claim) } }
}

/// Is the conversation in a real call on the iPhone right now? The Mac's home window says "Talking on your iPhone"
/// only then (QA 171: a fresh account's default owner is the phone at epoch 0, which showed "Talking" with no call).
enum PhoneCallPresence {
    static func live(owner: ConversationDevice, epoch: Int, peerActive: Bool, peerInCall: Bool?) -> Bool {
        guard owner == .phone else { return false }
        // a server that reports calls is the truth (a locked iPhone mid-call still counts)
        if let peerInCall { return peerInCall }
        // older server: the iPhone took the conversation (call start or a move) and is open in front
        return epoch > 0 && peerActive
    }
}
