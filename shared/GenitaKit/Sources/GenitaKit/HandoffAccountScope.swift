import Foundation

/// Local handoff state and delayed work belong to one verified account at a time.
struct HandoffAccountScope: Sendable {
    private(set) var accountID: String?
    private(set) var generation = 0

    /// Rechecking /me for the same account keeps its connection. Logout and each account switch
    /// invalidate work even when the user later signs back into the original account.
    @discardableResult mutating func select(_ accountID: String?) -> Bool {
        guard self.accountID != accountID else { return false }
        generation += 1
        self.accountID = accountID
        return true
    }

    func accepts(_ generation: Int) -> Bool { accountID != nil && self.generation == generation }

    /// Nil is deliberately not persisted. Never assign an unscoped legacy epoch to a new account.
    static func storageKey(base: String, accountID: String?) -> String? {
        accountID.map { base + ".account." + Data($0.utf8).base64EncodedString() }
    }
}
