import Foundation
import Security

/// Where the 30-day session JWT lives. Keychain in the apps, memory in tests.
public protocol GenitaTokenStore: AnyObject, Sendable {
    func load() -> String?
    func save(_ token: String)
    func clear()
    /// Clears the current session only when it is the request's session.
    func clear(ifMatching token: String)
}

public final class InMemoryTokenStore: GenitaTokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var token: String?
    public init(_ token: String? = nil) { self.token = token }
    public func load() -> String? { lock.withLock { token } }
    public func save(_ token: String) { lock.withLock { self.token = token } }
    public func clear() { lock.withLock { token = nil } }
    public func clear(ifMatching token: String) { lock.withLock { if self.token == token { self.token = nil } } }
}

/// Generic-password item, readable after first unlock, never synced or backed up to another device.
public final class KeychainTokenStore: GenitaTokenStore, @unchecked Sendable {
    public static let defaultService = "ai.thebeni.genita.session"
    private let service: String
    private let account: String
    private let lock = NSLock()

    public init(service: String = KeychainTokenStore.defaultService, account: String = "session") {
        self.service = service
        self.account = account
    }

    private var query: [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        #if os(iOS)
        q[kSecUseDataProtectionKeychain as String] = true
        #endif
        return q
    }

    private func loadUnlocked() -> String? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func saveUnlocked(_ token: String) {
        let data = Data(token.utf8)
        let attrs: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        if SecItemUpdate(query as CFDictionary, attrs as CFDictionary) == errSecItemNotFound {
            var add = query
            add.merge(attrs) { _, new in new }
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    private func clearUnlocked() { SecItemDelete(query as CFDictionary) }

    public func load() -> String? { lock.withLock { loadUnlocked() } }
    public func save(_ token: String) { lock.withLock { saveUnlocked(token) } }
    public func clear() { lock.withLock { clearUnlocked() } }
    public func clear(ifMatching token: String) { lock.withLock { if loadUnlocked() == token { clearUnlocked() } } }
}
