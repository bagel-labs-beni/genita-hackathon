import Testing
@testable import GenitaKit

struct WatchReconnectPolicyTests {
    @Test func callRecoveryWaitsWithoutStoppingCaptureOrConsumingWatchRetries() {
        // Both notification orders: the old watch config is still set, or the view cleared it.
        for configured in ["call", nil] as [String?] {
            let callIsValid = valid(configured: configured, live: false)
            for attempt in 0...3 {
                #expect(WatchReconnectPolicy.recoveryAction(attempt: attempt, isSharing: true,
                    callIsValid: callIsValid, isCallActive: true, isOwner: true, isSignedIn: true) == .waitForCall)
            }
        }
        // A ready event can precede the view updating watchConfig with the new session.
        #expect(WatchReconnectPolicy.recoveryAction(attempt: 0, isSharing: true,
            callIsValid: valid(active: "next-call"), isCallActive: true, isOwner: true, isSignedIn: true) == .waitForCall)
        #expect(WatchReconnectPolicy.recoveryAction(attempt: 0, isSharing: true,
            callIsValid: valid(), isCallActive: true, isOwner: true, isSignedIn: true) == .retry(after: 1))
    }

    @Test func waitingCannotSurviveStopOwnershipTransferOrSignOut() {
        #expect(WatchReconnectPolicy.recoveryAction(attempt: 0, isSharing: false,
            callIsValid: false, isCallActive: true, isOwner: true, isSignedIn: true) == .stop)
        #expect(WatchReconnectPolicy.recoveryAction(attempt: 0, isSharing: true,
            callIsValid: false, isCallActive: false, isOwner: true, isSignedIn: true) == .stop)
        #expect(WatchReconnectPolicy.recoveryAction(attempt: 0, isSharing: true,
            callIsValid: false, isCallActive: true, isOwner: false, isSignedIn: true) == .stop)
        #expect(WatchReconnectPolicy.recoveryAction(attempt: 0, isSharing: true,
            callIsValid: false, isCallActive: true, isOwner: true, isSignedIn: false) == .stop)
        #expect(WatchReconnectPolicy.recoveryAction(attempt: 3, isSharing: true,
            callIsValid: true, isCallActive: true, isOwner: true, isSignedIn: true) == .stop)
    }

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
