import Foundation
import Testing
@testable import GenitaKit

@Suite struct HandoffPairingStoreTests {
    @Test func returningToARestoresItsTokenAfterPairingBAndRestarting() {
        let suite = "handoff-pairing-" + UUID().uuidString
        let store = UserDefaults(suiteName: suite)!
        defer { store.removePersistentDomain(forName: suite) }
        var memory = HandoffPairingStore(store: store)
        let a = RememberedMac(mac: "mac-a", token: "token-a")
        let b = RememberedMac(mac: "mac-b", token: "token-b")
        memory.useAccount("a"); memory.remember(a)
        memory.useAccount("b")
        #expect(memory.remembered == nil)
        memory.remember(b)
        memory.useAccount("a")
        #expect(memory.remembered == a)
        memory = HandoffPairingStore(store: store)
        memory.useAccount("a")
        #expect(memory.remembered == a)
        memory.useAccount("b")
        #expect(memory.remembered == b)
        memory.forget()
        #expect(memory.remembered == nil)
        memory.useAccount("a")
        #expect(memory.remembered == a)
    }

    @Test func signedOutAndLegacyPairingsCannotBeAdoptedByAnotherAccount() throws {
        let suite = "handoff-pairing-" + UUID().uuidString
        let store = UserDefaults(suiteName: suite)!
        defer { store.removePersistentDomain(forName: suite) }
        let legacy = RememberedMac(mac: "legacy", token: "legacy-token")
        store.set(try JSONEncoder().encode(legacy), forKey: "genita.handoff.rememberedMac")
        var memory = HandoffPairingStore(store: store)
        #expect(memory.remembered == nil)
        memory.useAccount("a")
        #expect(memory.remembered == nil)
        let a = RememberedMac(mac: "mac-a", token: "token-a")
        memory.remember(a)
        memory.useAccount(nil)
        #expect(memory.remembered == nil)
        memory.remember(legacy) // Signed-out callbacks must not persist a token.
        memory.forget()
        memory.useAccount("a")
        #expect(memory.remembered == a)
    }
}
