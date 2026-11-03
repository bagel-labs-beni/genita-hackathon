import Testing
@testable import GenitaKit

/// The waiting slot may expire, but that approach remains unconfirmed and only its own reply can settle it.
@Suite struct ProximityReportTests {
    @Test func oneReportAtATimeAndTheAnswerFreesIt() {
        var report = ProximityReport()
        #expect(report.canReport)
        let id = report.sent("7K2M9QXA", at: 10)
        #expect(!report.canReport)
        #expect(report.answered(requestID: id, token: "7K2M9QXA") == "7K2M9QXA")
        #expect(report.canReport)
        #expect(report.answered(requestID: id, token: "7K2M9QXA") == nil, "a duplicate answer has no report to settle")
    }

    @Test func noAnswerInTimeGivesTheReportUp() {
        var report = ProximityReport()
        report.sent("7K2M9QXA", at: 10)
        #expect(report.expire(at: 10 + ProximityReport.answerTimeout - 0.1) == nil, "still waiting")
        #expect(!report.canReport)
        #expect(report.expire(at: 10 + ProximityReport.answerTimeout) == "7K2M9QXA")
        #expect(report.canReport, "a later approach can report again without a reconnect")
        #expect(report.expire(at: 100) == nil, "nothing in flight")
    }

    @Test func aReconnectDropsTheReport() {
        var report = ProximityReport()
        let id = report.sent("7K2M9QXA", at: 10)
        report.reset()
        #expect(report.canReport)
        #expect(report.expire(at: 100) == nil)
        #expect(report.answered(requestID: id, token: "7K2M9QXA") == nil)
    }

    @Test func timeoutIsUnconfirmedAndALateSuccessStillBelongsToItsApproach() {
        var report = ProximityReport()
        let id = report.sent("7K2M9QXA", at: 10)
        #expect(report.expire(at: 15) == "7K2M9QXA")
        #expect(report.canReport)
        #expect(report.answered(requestID: id, token: "7K2M9QXA") == "7K2M9QXA", "timeout is not a refusal: retain the approach for its late result")
        #expect(report.answered(requestID: id, token: "7K2M9QXA") == nil)
    }

    @Test func lateUnknownTokenCannotCompleteTheNextPhonesReport() {
        var report = ProximityReport()
        let a = report.sent("7K2M9QXA", at: 0)
        #expect(report.expire(at: 5) == "7K2M9QXA")
        let b = report.sent("8K2M9QXA", at: 11)
        // A's late unknown_token must neither exclude B nor release B's leave-range latch.
        #expect(report.answered(requestID: a, token: "7K2M9QXA") == nil)
        #expect(!report.canReport)
        #expect(report.token == "8K2M9QXA")
        #expect(report.answered(requestID: b, token: "8K2M9QXA") == "8K2M9QXA", "B's real success still counts")
    }

    @Test func retryOfTheSameTokenRequiresItsOwnAttemptID() {
        var report = ProximityReport()
        let a = report.sent("7K2M9QXA", at: 0)
        #expect(report.expire(at: 5) == "7K2M9QXA")
        let b = report.sent("7K2M9QXA", at: 11)
        #expect(a != b)
        #expect(report.answered(requestID: a, token: "7K2M9QXA") == nil)
        #expect(!report.canReport)
        #expect(report.answered(requestID: b, token: "7K2M9QXA") == "7K2M9QXA")
    }

    @Test func matchingIDWithTheWrongTokenAndLegacyUncorrelatedRepliesAreIgnored() {
        var report = ProximityReport()
        let id = report.sent("7K2M9QXA", at: 0)
        #expect(report.answered(requestID: id, token: "8K2M9QXA") == nil)
        #expect(report.answered(requestID: nil, token: "7K2M9QXA") == nil)
        #expect(report.answered(requestID: id, token: nil) == nil)
        #expect(report.answered(requestID: nil, token: nil) == nil)
        #expect(!report.canReport)
        #expect(report.answered(requestID: id, token: "7K2M9QXA") == "7K2M9QXA")
    }

    @Test func anUnconfirmedApproachCanStillReceiveItsOwnDefinitiveRefusal() {
        var report = ProximityReport()
        let id = report.sent("7K2M9QXA", at: 0)
        #expect(report.expire(at: 5) == "7K2M9QXA")
        #expect(report.answered(requestID: "other-attempt", token: "7K2M9QXA") == nil)
        #expect(report.answered(requestID: id, token: "7K2M9QXA") == "7K2M9QXA", "only the matching refusal may release this approach")
    }

    @Test func confirmedMacOwnershipMakesLateRefusalsHarmless() {
        var report = ProximityReport()
        let id = report.sent("7K2M9QXA", at: 0)
        #expect(report.expire(at: 5) == "7K2M9QXA")
        report.reset() // Mac ownership confirms the move, without clearing the detector's latch.
        #expect(report.answered(requestID: id, token: "7K2M9QXA") == nil, "a later refusal cannot undo a confirmed move's latch")
        #expect(report.canReport)
    }

    @Test func reconnectCannotReuseAnOldAttemptsReplyEvenForTheSameToken() {
        var report = ProximityReport()
        let a = report.sent("7K2M9QXA", at: 0)
        report.reset()
        let b = report.sent("7K2M9QXA", at: 1)
        #expect(report.answered(requestID: a, token: "7K2M9QXA") == nil)
        #expect(!report.canReport)
        #expect(report.answered(requestID: b, token: "7K2M9QXA") == "7K2M9QXA")
    }
}
