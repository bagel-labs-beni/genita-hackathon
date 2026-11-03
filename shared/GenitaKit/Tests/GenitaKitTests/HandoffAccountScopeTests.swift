import Testing
@testable import GenitaKit

@Suite struct HandoffAccountScopeTests {
    @Test func accountStorageNeverUsesLegacyOrAnotherAccountsKey() {
        let base = "genita.handoff.ownership"
        let a = HandoffAccountScope.storageKey(base: base, accountID: "account-a")
        let b = HandoffAccountScope.storageKey(base: base, accountID: "account-b")
        #expect(a != nil && b != nil)
        #expect(a != base && a != b)
        #expect(a == HandoffAccountScope.storageKey(base: base, accountID: "account-a"))
        #expect(HandoffAccountScope.storageKey(base: base, accountID: nil) == nil)
    }

    @Test func logoutAndAccountSwitchInvalidateLateEventsIncludingReturnToA() {
        var scope = HandoffAccountScope()
        #expect(!scope.accepts(scope.generation))
        let signedInA = scope.select("account-a")
        #expect(signedInA)
        let a = scope.generation
        #expect(scope.accepts(a))
        let recheckedA = scope.select("account-a")
        #expect(!recheckedA)
        #expect(scope.generation == a)
        let loggedOut = scope.select(nil)
        #expect(loggedOut)
        #expect(!scope.accepts(a))
        let signedInB = scope.select("account-b")
        #expect(signedInB)
        let b = scope.generation
        #expect(!scope.accepts(a))
        #expect(scope.accepts(b))
        let returnedToA = scope.select("account-a")
        #expect(returnedToA)
        #expect(!scope.accepts(a) && !scope.accepts(b))
    }
}
