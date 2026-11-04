import Testing
@testable import GenitaKit

struct ScreenShareRestartPolicyTests {
    typealias P = ScreenShareRestartPolicy

    @Test func systemStopRestartsWithBackoffThreeTimesAMinute() {
        // QA 11/4 watch-2136: -3821 twice, after 1.1 s and after 2m43s. Each one restarts instead of ending the share.
        #expect(P.action(isStreamError: true, code: P.systemStoppedCode, restarts: [], now: 100) == .restart(after: 0.5))
        #expect(P.action(isStreamError: true, code: P.systemStoppedCode, restarts: [100], now: 101) == .restart(after: 1))
        #expect(P.action(isStreamError: true, code: P.systemStoppedCode, restarts: [100, 101], now: 103) == .restart(after: 2))
        // a 4th stop inside the minute: tell the person
        #expect(P.action(isStreamError: true, code: P.systemStoppedCode, restarts: [100, 101, 103], now: 110) == .giveUp)
        // the minute passes: the budget is back
        #expect(P.action(isStreamError: true, code: P.systemStoppedCode, restarts: [100, 101, 103], now: 160.5) == .restart(after: 2))
        #expect(P.action(isStreamError: true, code: P.systemStoppedCode, restarts: [100, 101, 103], now: 170) == .restart(after: 0.5))
    }

    @Test func aStopFromTheSystemUIIsThePersonsChoice() {
        #expect(P.action(isStreamError: true, code: P.userStoppedCode, restarts: [], now: 0) == .userStopped)
        // even with no restart budget left it is a stop, not an error
        #expect(P.action(isStreamError: true, code: P.userStoppedCode, restarts: [0, 1, 2], now: 3) == .userStopped)
    }

    @Test func refusalsARestartCannotFixEndTheShare() {
        #expect(P.action(isStreamError: true, code: P.userDeclinedCode, restarts: [], now: 0) == .giveUp)
        #expect(P.action(isStreamError: true, code: P.missingEntitlementsCode, restarts: [], now: 0) == .giveUp)
    }

    @Test func unknownStopsCountAsSystemStops() {
        // another domain or code (-3805 connection interrupted, an NSError from replayd) is not the person's stop
        #expect(P.action(isStreamError: true, code: -3805, restarts: [], now: 0) == .restart(after: 0.5))
        #expect(P.action(isStreamError: false, code: P.userStoppedCode, restarts: [], now: 0) == .restart(after: 0.5))
    }

    @Test func fallbackOrderWindowThenAppThenDisplay() {
        #expect(P.candidates(style: .window, sourceStillThere: true) == [.same, .application, .display])
        #expect(P.candidates(style: .window, sourceStillThere: false) == [.application, .display])
        #expect(P.candidates(style: .application, sourceStillThere: true) == [.same, .display])
        #expect(P.candidates(style: .application, sourceStillThere: false) == [.display])
        #expect(P.candidates(style: .display, sourceStillThere: true) == [.same, .display])
        #expect(P.candidates(style: .display, sourceStillThere: false) == [.display])
    }

    @Test func futureTimestampsDoNotEatTheBudget() {
        #expect(P.recentRestarts([50, 200], now: 100) == [50])
    }
}
