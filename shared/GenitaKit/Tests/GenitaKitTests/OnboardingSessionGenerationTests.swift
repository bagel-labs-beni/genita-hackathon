import Testing
@testable import GenitaKit

struct OnboardingSessionGenerationTests {
    @Test func staleSnapshotCannotApplyAfterAccountChanges() {
        var generation = OnboardingSessionGeneration()
        let accountA = generation.snapshot(token: "account-a")

        #expect(generation.isCurrent(accountA, token: "account-a"))
        #expect(!generation.isCurrent(accountA, token: "account-b"))

        generation.invalidate()
        #expect(!generation.isCurrent(accountA, token: "account-a"))
        #expect(generation.isCurrent(generation.snapshot(token: "account-b"), token: "account-b"))
    }
}
