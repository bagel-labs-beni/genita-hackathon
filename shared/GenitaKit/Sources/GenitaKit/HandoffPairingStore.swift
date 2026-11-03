import Foundation

/// A Mac this iPhone paired with once. Later moves use its token, not the code.
struct RememberedMac: Codable, Equatable, Sendable { let mac: String; let token: String }

struct HandoffPairingStore {
    private let store: UserDefaults
    private let baseKey = "genita.handoff.rememberedMac"
    private var key: String?

    init(store: UserDefaults) { self.store = store }

    /// Legacy unscoped tokens have no verified owner. Never assign them to a new account.
    mutating func useAccount(_ accountID: String?) {
        key = HandoffAccountScope.storageKey(base: baseKey, accountID: accountID)
    }

    var remembered: RememberedMac? {
        key.flatMap { store.data(forKey: $0) }.flatMap { try? JSONDecoder().decode(RememberedMac.self, from: $0) }
    }

    func remember(_ mac: RememberedMac) {
        guard let key, let data = try? JSONEncoder().encode(mac) else { return }
        store.set(data, forKey: key)
    }

    func forget() { if let key { store.removeObject(forKey: key) } }
}
