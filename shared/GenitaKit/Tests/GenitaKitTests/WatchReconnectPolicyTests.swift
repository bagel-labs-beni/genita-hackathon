import Testing
@testable import GenitaKit

struct WatchReconnectPolicyTests {
    @Test func retriesWatchLossWithBoundedBackoffWhileTheCallStaysLive() {
        let delays = (0...3).map {
            WatchReconnectPolicy.delay(attempt: $0, isSharing: true, callIsValid: true)
        }
        #expect(delays == [1, 2, 4, nil])
        #expect(WatchReconnectPolicy.delay(attempt: -1, isSharing: true, callIsValid: true) == nil)
    }

    @Test func stoppingOrInvalidatingTheCallPreventsEveryRetry() {
        for attempt in 0...3 {
            #expect(WatchReconnectPolicy.delay(attempt: attempt, isSharing: false, callIsValid: true) == nil)
            #expect(WatchReconnectPolicy.delay(attempt: attempt, isSharing: true, callIsValid: false) == nil)
        }
    }

    @Test func recoveryCannotCrossSessionOwnershipOrAccountBoundaries() {
        #expect(valid())
        #expect(!valid(configured: nil))
        #expect(!valid(configured: ""))
        #expect(!valid(active: nil))
        #expect(!valid(active: "next-call"))
        #expect(!valid(live: false))
        #expect(!valid(owner: false))
        #expect(!valid(signedIn: false))
    }

    private func valid(configured: String? = "call", active: String? = "call",
                       live: Bool = true, owner: Bool = true, signedIn: Bool = true) -> Bool {
        WatchReconnectPolicy.callIsValid(configuredSession: configured, activeSession: active,
                                         isLive: live, isOwner: owner, isSignedIn: signedIn)
    }
}
