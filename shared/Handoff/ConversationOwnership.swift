import Foundation

enum ConversationDevice: String, Codable { case phone, mac }

/// One device saying "the conversation is on `owner`" at a point in the epoch order.
struct OwnershipClaim: Equatable, Codable {
    let owner: ConversationDevice
    let epoch: Int
    init(owner: ConversationDevice, epoch: Int) { self.owner = owner; self.epoch = epoch }
    init?(_ message: [String: Any]) {
        guard let owner = (message["owner"] as? String).flatMap(ConversationDevice.init(rawValue:)), let epoch = message["epoch"] as? Int else { return nil }
        self.init(owner: owner, epoch: epoch)
    }
    var message: [String: Any] { ["type": "ownership", "owner": owner.rawValue, "epoch": epoch] }
}

/// What a device shows for the current owner. Losing the link never changes the owner, only this.
enum HandoffSurface: Equatable { case active, waiting, waitingPeerUnreachable }

/// Which device holds the conversation. The newest claim wins, so a device that
/// reconnects with an old epoch adopts the newer owner and moves to its waiting screen.
struct ConversationOwnership: Equatable, Codable {
    private(set) var owner = ConversationDevice.phone
    private(set) var epoch = 0
    mutating func claim(for device: ConversationDevice) -> OwnershipClaim {
        epoch += 1; owner = device
        return OwnershipClaim(owner: owner, epoch: epoch)
    }
    /// Returns true if `claim` replaced the current state. Equal epochs with different
    /// owners cannot come from one history, so a fixed rule makes both devices converge.
    @discardableResult mutating func apply(_ claim: OwnershipClaim) -> Bool {
        guard claim.epoch > epoch || (claim.epoch == epoch && claim.owner != owner && claim.owner == .mac) else { return false }
        epoch = claim.epoch; owner = claim.owner
        return true
    }
    func surface(on device: ConversationDevice, peerReachable: Bool) -> HandoffSurface {
        owner == device ? .active : peerReachable ? .waiting : .waitingPeerUnreachable
    }
}

/// How a claim reaches the other device. Today this is the local link; a server replaces it later.
protocol OwnershipTransport: AnyObject { func publish(_ claim: OwnershipClaim) }

/// Holds one device's view of ownership, persists it and talks to the transport.
final class OwnershipCoordinator {
    let device: ConversationDevice
    weak var transport: OwnershipTransport?
    var onChange: ((_ old: ConversationDevice, _ new: ConversationDevice) -> Void)?
    private(set) var state: ConversationOwnership { didSet { save() } }
    private let store: UserDefaults
    private let baseKey: String
    private var key: String?
    init(device: ConversationDevice, store: UserDefaults = .standard, key: String = "genita.handoff.ownership") {
        self.device = device; self.store = store; self.baseKey = key; self.key = key
        state = store.data(forKey: key).flatMap { try? JSONDecoder().decode(ConversationOwnership.self, from: $0) } ?? ConversationOwnership()
    }
    /// Account switches load only that user's epoch. Unscoped legacy data is never migrated blindly.
    /// The caller stops the old transports before selecting another account.
    func useAccount(_ accountID: String?) {
        key = HandoffAccountScope.storageKey(base: baseKey, accountID: accountID)
        state = key.flatMap { store.data(forKey: $0) }.flatMap { try? JSONDecoder().decode(ConversationOwnership.self, from: $0) } ?? ConversationOwnership()
    }
    var isOwner: Bool { state.owner == device }
    /// The tap that moves the conversation here. It takes effect at once, with or without a link.
    func claimHere() {
        let old = state.owner
        let claim = state.claim(for: device)
        transport?.publish(claim)
        onChange?(old, state.owner)
    }
    /// A claim from the other device. Stale claims are ignored.
    func receive(_ claim: OwnershipClaim) {
        let old = state.owner
        guard state.apply(claim) else { return }
        onChange?(old, state.owner)
    }
    /// Sent on every (re)connect so the device with the older epoch learns the newest claim.
    func publishCurrent() { transport?.publish(OwnershipClaim(owner: state.owner, epoch: state.epoch)) }
    func surface(peerReachable: Bool) -> HandoffSurface { state.surface(on: device, peerReachable: peerReachable) }
    private func save() { if let key, let data = try? JSONEncoder().encode(state) { store.set(data, forKey: key) } }
}
