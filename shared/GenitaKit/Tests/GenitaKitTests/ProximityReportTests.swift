import Testing
@testable import GenitaKit

/// #377 follow-up: the Mac's one proximity report in flight must free itself when no answer comes,
/// or a later approach never reports until the Mac reconnects.
@Suite struct ProximityReportTests {
    @Test func oneReportAtATimeAndTheAnswerFreesIt() {
        var report = ProximityReport()
        #expect(report.canReport)
        report.sent("7K2M9QXA", at: 10)
        #expect(!report.canReport)
        #expect(report.answered() == "7K2M9QXA")
        #expect(report.canReport)
        #expect(report.answered() == nil, "a second (late) answer has no report to settle")
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
        report.sent("7K2M9QXA", at: 10)
        report.reset()
        #expect(report.canReport)
        #expect(report.expire(at: 100) == nil)
    }
}
