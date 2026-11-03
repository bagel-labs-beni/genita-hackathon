import XCTest
@testable import Genita

/// F6-L7 on the app side: what the presence socket's events do to a device, and that two devices plus
/// the server (same rule: highest epoch wins, tie → Mac) always end on the same owner.
final class ServerOwnershipTests: XCTestCase {
    // MARK: events and the reducer

    func testPresenceEventsParse() {
        XCTAssertEqual(PresenceEvent(["type": "ownership", "owner": "mac", "epoch": 3, "trigger": "button"]), .ownership(owner: .mac, epoch: 3, trigger: "button"))
        XCTAssertEqual(PresenceEvent(["type": "ownership", "owner": NSNull(), "epoch": 4]), .ownership(owner: nil, epoch: 4, trigger: ""))
        XCTAssertEqual(PresenceEvent(["type": "claim.result", "accepted": false, "owner": "iphone", "epoch": 2]), .claimResult(accepted: false, owner: .phone, epoch: 2))
        XCTAssertEqual(PresenceEvent(["type": "peer", "device": "iphone", "online": true, "active": false]), .peer(device: .phone, online: true, active: false))
        XCTAssertEqual(PresenceEvent(["type": "move.request", "from": "iphone"]), .moveRequest(from: .phone))
        XCTAssertEqual(PresenceEvent(["type": "move.failed", "to": "mac", "reason": "peer_offline"]), .moveFailed(reason: "peer_offline"))
        XCTAssertEqual(PresenceEvent(["type": "pong", "t": 1]), .other("pong"))
        XCTAssertNil(PresenceEvent(["type": "ownership", "owner": "mac"]), "an ownership without an epoch is dropped")
        XCTAssertNil(PresenceEvent(["owner": "mac"]))
    }

    func testReducerTurnsServerEventsIntoClaimsAndPeerState() {
        var state = PresenceState(connected: true)
        XCTAssertEqual(PresenceState.reduce(&state, .ownership(owner: .mac, epoch: 5, trigger: "button"), me: .phone), [.apply(OwnershipClaim(owner: .mac, epoch: 5))])
        XCTAssertEqual(PresenceState.reduce(&state, .ownership(owner: nil, epoch: 6, trigger: "release"), me: .phone), [], "a release keeps the device's own state")
        XCTAssertEqual(PresenceState.reduce(&state, .claimResult(accepted: false, owner: .mac, epoch: 7), me: .phone), [.apply(OwnershipClaim(owner: .mac, epoch: 7))], "a lost claim adopts the winner")
        XCTAssertEqual(PresenceState.reduce(&state, .peer(device: .mac, online: true, active: true), me: .phone), [.peerChanged])
        XCTAssertEqual(PresenceState.reduce(&state, .peer(device: .mac, online: true, active: true), me: .phone), [], "no change, no refresh")
        XCTAssertEqual(PresenceState.reduce(&state, .peer(device: .phone, online: false, active: false), me: .phone), [], "my own presence is not a peer")
        XCTAssertTrue(state.peerOnline && state.peerActive)
        XCTAssertEqual(PresenceState.reduce(&state, .moveRequest(from: .mac), me: .phone), [.moveRequested(from: .mac)])
        XCTAssertEqual(PresenceState.reduce(&state, .moveRequest(from: .phone), me: .phone), [])
        XCTAssertEqual(PresenceState.reduce(&state, .moveFailed(reason: "peer_inactive"), me: .phone), [.moveFailed(reason: "peer_inactive")])
    }

    func testOwnClaimIsAClaimAndALearnedOneIsAHello() {
        let own = PresenceState.message(for: OwnershipClaim(owner: .phone, epoch: 4), me: .phone, trigger: "continue", active: true)
        XCTAssertEqual(own["type"] as? String, "claim"); XCTAssertEqual(own["epoch"] as? Int, 4); XCTAssertEqual(own["trigger"] as? String, "continue")
        let learned = PresenceState.message(for: OwnershipClaim(owner: .mac, epoch: 4), me: .phone, trigger: "continue", active: false)
        XCTAssertEqual(learned["type"] as? String, "hello"); XCTAssertEqual(learned["owner"] as? String, "mac"); XCTAssertEqual(learned["active"] as? Bool, false)
        let fresh = PresenceState.message(for: OwnershipClaim(owner: .phone, epoch: 0), me: .phone, trigger: "continue", active: true)
        XCTAssertEqual(fresh["type"] as? String, "hello", "the default state at epoch 0 is never sent as a tap")
    }

    func testPresenceEndpointFollowsTheCallServer() {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        func url(_ env: [String: String]) -> String? { PresenceEndpoint.current(device: .phone, environment: env, defaults: defaults)?.url.absoluteString }
        XCTAssertEqual(url(["GENITA_SERVER_URL": "wss://genita-api.thebeni.ai/v1/session"]), "wss://genita-api.thebeni.ai/v1/presence?device=iphone")
        XCTAssertEqual(url(["GENITA_SERVER_URL": "ws://10.0.0.2:8787"]), "ws://10.0.0.2:8787/v1/presence?device=iphone")
        XCTAssertEqual(url(["GENITA_PRESENCE_URL": "ws://h/v1/presence?device=mac"]), "ws://h/v1/presence?device=iphone", "the device is always this app's")
        XCTAssertNil(url(["GENITA_SERVER_URL": "https://genita-api.thebeni.ai"]))
        XCTAssertNotNil(PresenceEndpoint.current(device: .mac, environment: ["GENITA_SESSION_TOKEN": "dev"], defaults: defaults)?.token, "dev token fallback")
    }

    // MARK: two devices and a server

    /// The server's rule, as genita-server/src/handoff applies it.
    private final class FakeServer {
        var state = ConversationOwnership()
        var devices: [ConversationDevice: Wire] = [:]
        var online: Set<ConversationDevice> = []
        func receive(_ m: [String: Any], from device: ConversationDevice) {
            guard online.contains(device) else { return }
            let type = m["type"] as? String
            let claim: OwnershipClaim?
            switch type {
            case "claim": claim = (m["epoch"] as? Int).map { OwnershipClaim(owner: device, epoch: $0) }
            case "hello": claim = (m["epoch"] as? Int).flatMap { e in ConversationDevice(serverName: m["owner"] as? String).map { OwnershipClaim(owner: $0, epoch: e) } }
            default: claim = nil
            }
            let changed = claim.map { $0.epoch > 0 && state.apply($0) } ?? false
            let event: [String: Any] = ["type": "ownership", "owner": state.owner.serverName, "epoch": state.epoch, "trigger": changed ? (type == "hello" ? "sync" : "button") : "current"]
            if type == "claim" { devices[device]?.deliver(["type": "claim.result", "accepted": state.owner == device, "owner": state.owner.serverName, "epoch": state.epoch]) }
            for target in changed ? Array(online) : (type == "hello" ? [device] : []) { devices[target]?.deliver(event) }
        }
    }
    private final class Wire: OwnershipTransport {
        let device: ConversationDevice
        let coordinator: OwnershipCoordinator
        let server: FakeServer
        var presence = PresenceState()
        var held = [[String: Any]]()
        /// true = deliver as soon as sent; false = hold until `flush` (to interleave two taps)
        var instant = true
        init(_ device: ConversationDevice, _ server: FakeServer) {
            self.device = device; self.server = server
            coordinator = OwnershipCoordinator(device: device, store: UserDefaults(suiteName: UUID().uuidString)!)
            coordinator.transport = self
            server.devices[device] = self
        }
        func publish(_ claim: OwnershipClaim) {
            let m = PresenceState.message(for: claim, me: device, trigger: "continue", active: true)
            if instant { server.receive(m, from: device) } else { held.append(m) }
        }
        func flush() { let out = held; held = []; out.forEach { server.receive($0, from: device) } }
        func deliver(_ m: [String: Any]) {
            guard let e = PresenceEvent(m) else { return }
            for effect in PresenceState.reduce(&presence, e, me: device) { if case let .apply(c) = effect { coordinator.receive(c) } }
        }
        func connect() { server.online.insert(device); coordinator.publishCurrent() }
        func disconnect() { server.online.remove(device) }
    }

    func testButtonMovesAndRacingTapsConvergeOnBothDevicesAndTheServer() {
        let server = FakeServer()
        let phone = Wire(.phone, server), mac = Wire(.mac, server)
        phone.connect(); mac.connect()
        for round in 0..<10 {
            mac.coordinator.claimHere()
            XCTAssertTrue(mac.coordinator.isOwner); XCTAssertFalse(phone.coordinator.isOwner, "round \(round): one owner")
            phone.coordinator.claimHere()
            XCTAssertTrue(phone.coordinator.isOwner); XCTAssertFalse(mac.coordinator.isOwner)
            // both tap Continue here before either hears the other
            phone.instant = false; mac.instant = false
            phone.coordinator.claimHere(); mac.coordinator.claimHere()
            phone.flush(); mac.flush(); phone.instant = true; mac.instant = true
            XCTAssertEqual(server.state.owner, .mac, "round \(round): tie → Mac")
            XCTAssertEqual(phone.coordinator.state, server.state)
            XCTAssertEqual(mac.coordinator.state, server.state)
            XCTAssertTrue(mac.coordinator.isOwner != phone.coordinator.isOwner, "never two owners")
        }
    }

    func testOpeningTheAppDoesNotStealAndAnOfflineTapWinsOnReconnect() {
        let server = FakeServer()
        let phone = Wire(.phone, server), mac = Wire(.mac, server)
        mac.connect(); phone.connect()
        mac.coordinator.claimHere()
        XCTAssertEqual(phone.coordinator.surface(peerReachable: true), .waiting, "R1")
        // the iPhone app is reopened: it reconnects with what it knows, nothing moves
        phone.disconnect(); phone.connect()
        XCTAssertTrue(mac.coordinator.isOwner); XCTAssertFalse(phone.coordinator.isOwner)
        // offline, the iPhone taps Continue here (R1-E): it takes effect at once
        phone.disconnect()
        phone.coordinator.claimHere()
        XCTAssertTrue(phone.coordinator.isOwner)
        XCTAssertTrue(mac.coordinator.isOwner, "the Mac hasn't heard yet")
        phone.connect()
        XCTAssertEqual(server.state.owner, .phone)
        XCTAssertFalse(mac.coordinator.isOwner, "the server told the Mac")
        XCTAssertEqual(mac.coordinator.surface(peerReachable: true), .waiting, "R2")
    }

    func testLockedOwnerKeepsTheConversation() {
        let server = FakeServer()
        let phone = Wire(.phone, server), mac = Wire(.mac, server)
        phone.connect(); mac.connect()
        phone.coordinator.claimHere()
        phone.disconnect() // locked: the socket goes away, nothing is claimed
        mac.disconnect(); mac.connect() // the Mac app is reopened
        XCTAssertEqual(server.state.owner, .phone)
        XCTAssertFalse(mac.coordinator.isOwner)
        XCTAssertEqual(mac.coordinator.surface(peerReachable: false), .waitingPeerUnreachable, "R2-E while the iPhone is away")
    }

    // MARK: registration picture

    func testRegistrationPictureHasTheScreensAspectAndGeometryIsValidated() throws {
        let image = try XCTUnwrap(RegistrationPattern.image(width: 1280, aspect: 1512.0 / 982.0))
        XCTAssertEqual(image.width, 1280); XCTAssertEqual(image.height, 831)
        XCTAssertEqual(RegistrationPattern.shapes.count, 178)
        XCTAssertEqual(RegistrationGeometry(["widthM": 0.302, "heightM": 0.196])?.widthM, 0.302)
        XCTAssertNil(RegistrationGeometry(widthM: 0, heightM: 0.2))
        XCTAssertNil(RegistrationGeometry(["widthM": "0.3"]))
        XCTAssertEqual(RegistrationGeometry(widthM: 0.3, heightM: 0.2)?.message["type"] as? String, "registration")
    }

    func testEveryA12iPhoneHasADisplaySize() {
        let bounds = CGRect(x: 0, y: 0, width: 1170, height: 2532)
        XCTAssertNotNil(PhoneDisplayGeometry.meters(model: "iPhone14,7", nativeBounds: bounds), "iPhone 14 (no LiDAR)")
        XCTAssertNotNil(PhoneDisplayGeometry.meters(model: "iPhone11,8", nativeBounds: bounds), "XR, A12")
        XCTAssertNotNil(PhoneDisplayGeometry.meters(model: "iPhone19,1", nativeBounds: bounds), "a newer model assumes 460 ppi")
        XCTAssertNil(PhoneDisplayGeometry.meters(model: "iPhone10,3", nativeBounds: bounds), "iPhone X is A11")
        let h = try? XCTUnwrap(PhoneDisplayGeometry.meters(model: "iPhone14,7", nativeBounds: bounds)).height
        XCTAssertEqual(h ?? 0, 2532 / 460 * 0.0254, accuracy: 0.0001)
    }
}
