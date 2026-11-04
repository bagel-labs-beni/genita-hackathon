import XCTest
@testable import Genita

@MainActor final class HandoffAccountResolverTests: XCTestCase {
    func testTransientMeFailureResolvesWithoutRelaunchWithBoundedBackoff() async {
        let resolver = HandoffAccountResolver()
        let snapshot = LaunchAuthSnapshot(token: "token-a", generation: 0)
        var attempts = 0, accounts: [String] = [], delays: [Duration] = []
        let task = resolver.resolve(snapshot: snapshot, current: { snapshot }, fetch: {
            attempts += 1
            return attempts < 3 ? .offline : .active(self.me("a"))
        }, adopt: { accounts.append($0) }, expired: { XCTFail("Transient failure must not sign out") }, sleep: { delays.append($0) })
        await task?.value
        XCTAssertEqual(attempts, 3)
        XCTAssertEqual(delays, [.seconds(1), .seconds(2)])
        XCTAssertEqual(accounts, ["a"])
    }

    func testExhaustedRetriesCanBeTriggeredAgainByResumeOrCallReconnect() async {
        let resolver = HandoffAccountResolver()
        let snapshot = LaunchAuthSnapshot(token: "token-a", generation: 0)
        var attempts = 0, accounts: [String] = []
        let fetch: () async -> GenitaSessionState = {
            attempts += 1
            return attempts <= 3 ? .offline : .active(self.me("a"))
        }
        let first = resolver.resolve(snapshot: snapshot, current: { snapshot }, fetch: fetch,
                                     adopt: { accounts.append($0) }, expired: {}, sleep: { _ in })
        await first?.value
        XCTAssertEqual(attempts, 3, "No unbounded polling while offline")
        XCTAssertTrue(accounts.isEmpty)
        let retry = resolver.resolve(snapshot: snapshot, current: { snapshot }, fetch: fetch,
                                     adopt: { accounts.append($0) }, expired: {}, sleep: { _ in })
        await retry?.value
        XCTAssertEqual(attempts, 4)
        XCTAssertEqual(accounts, ["a"])
    }

    func testConcurrentConnectionRequestsShareOneResolution() async {
        let resolver = HandoffAccountResolver()
        let snapshot = LaunchAuthSnapshot(token: "token-a", generation: 0)
        var attempts = 0, accounts: [String] = []
        let fetch: () async -> GenitaSessionState = { attempts += 1; return .active(self.me("a")) }
        let first = resolver.resolve(snapshot: snapshot, current: { snapshot }, fetch: fetch,
                                     adopt: { accounts.append($0) }, expired: {}, sleep: { _ in })
        let second = resolver.resolve(snapshot: snapshot, current: { snapshot }, fetch: fetch,
                                      adopt: { accounts.append($0) }, expired: {}, sleep: { _ in })
        await first?.value
        await second?.value
        XCTAssertEqual(attempts, 1)
        XCTAssertEqual(accounts, ["a"])
    }

    func testLateSuccessCannotAdoptAfterLogoutAccountSwitchOrReturnToSameAccount() async {
        let original = LaunchAuthSnapshot(token: "token-a", generation: 0)
        for replacement in [LaunchAuthSnapshot(token: nil, generation: 1),
                            LaunchAuthSnapshot(token: "token-b", generation: 2),
                            LaunchAuthSnapshot(token: "token-a", generation: 3),
                            LaunchAuthSnapshot(token: "token-b", generation: 0)] {
            let resolver = HandoffAccountResolver()
            var current = original
            let task = resolver.resolve(snapshot: original, current: { current }, fetch: {
                current = replacement
                return .active(self.me("a"))
            }, adopt: { _ in XCTFail("Stale /me must never re-adopt A") }, expired: { XCTFail("Stale /me must not sign out B") })
            await task?.value
        }
    }

    func testLogoutDuringBackoffStopsFurtherFetchesEvenBeforeTokenClears() async {
        let resolver = HandoffAccountResolver()
        var current = LaunchAuthSnapshot(token: "token-a", generation: 0)
        var attempts = 0
        let task = resolver.resolve(snapshot: current, current: { current }, fetch: {
            attempts += 1
            return .offline
        }, adopt: { _ in XCTFail("Logged out") }, expired: {}, sleep: { _ in
            current = LaunchAuthSnapshot(token: "token-a", generation: 1)
        })
        await task?.value
        XCTAssertEqual(attempts, 1)
    }

    func testInvalidationIgnoresFetcherThatReturnsAfterCancellation() async {
        let resolver = HandoffAccountResolver()
        let snapshot = LaunchAuthSnapshot(token: "token-a", generation: 0)
        let task = resolver.resolve(snapshot: snapshot, current: { snapshot }, fetch: {
            resolver.invalidate()
            return .active(self.me("a"))
        }, adopt: { _ in XCTFail("Cancelled resolution cannot change the scope") }, expired: {})
        await task?.value
    }

    func testCurrentExpiredSessionSignsOutWithoutRetrying() async {
        let resolver = HandoffAccountResolver()
        var current = LaunchAuthSnapshot(token: "token-a", generation: 0)
        var expired = 0
        let task = resolver.resolve(snapshot: current, current: { current }, fetch: {
            current = LaunchAuthSnapshot(token: nil, generation: 0)
            return .expired
        }, adopt: { _ in XCTFail("401 cannot authorize handoff") }, expired: { expired += 1 },
                                    sleep: { _ in XCTFail("401 must not retry") })
        await task?.value
        XCTAssertEqual(expired, 1)
    }

    func testPauseCancelsBackoffAndResumeStartsFreshResolution() async {
        let resolver = HandoffAccountResolver()
        let snapshot = LaunchAuthSnapshot(token: "token-a", generation: 0)
        var attempts = 0, accounts: [String] = []
        let paused = resolver.resolve(snapshot: snapshot, current: { snapshot }, fetch: {
            attempts += 1
            return .offline
        }, adopt: { _ in XCTFail("Paused resolution cannot adopt") }, expired: {}, sleep: { _ in
            resolver.invalidate()
        })
        await paused?.value
        XCTAssertEqual(attempts, 1)
        let resumed = resolver.resolve(snapshot: snapshot, current: { snapshot }, fetch: {
            attempts += 1
            return .active(self.me("a"))
        }, adopt: { accounts.append($0) }, expired: {})
        await resumed?.value
        XCTAssertEqual(attempts, 2)
        XCTAssertEqual(accounts, ["a"])
    }

    func testLateExpiryCannotSignOutNewerLogin() async {
        let resolver = HandoffAccountResolver()
        var current = LaunchAuthSnapshot(token: "token-a", generation: 0)
        let task = resolver.resolve(snapshot: current, current: { current }, fetch: {
            current = LaunchAuthSnapshot(token: nil, generation: 2)
            return .expired
        }, adopt: { _ in XCTFail("Expired") }, expired: { XCTFail("Newer login must survive") })
        await task?.value
    }

    func testSignedOutDoesNotFetch() async {
        let resolver = HandoffAccountResolver()
        let snapshot = LaunchAuthSnapshot(token: nil, generation: 0)
        let task = resolver.resolve(snapshot: snapshot, current: { snapshot }, fetch: {
            XCTFail("No /me without a token")
            return .signedOut
        }, adopt: { _ in XCTFail("Signed out") }, expired: {})
        XCTAssertNil(task)
    }

    private func me(_ id: String) -> GenitaMe {
        GenitaMe(user: .init(id: id, provider: "apple", createdAt: ""), consented: true,
                 hasCompanion: true, prepStatus: .ready, conversation: nil)
    }
}
