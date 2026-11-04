import Foundation
import Testing
@testable import GenitaKit

@Suite struct CompanionTogetherTests {
    private var cal: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "UTC")!; return c }
    private func at(_ s: String) -> Date { ISO8601DateFormatter().date(from: s)! }

    @Test func daysTogether() {
        let made = "2026-10-23T22:30:00.000Z"
        #expect(CompanionTogether.label(createdAt: made, now: at("2026-11-04T09:00:00Z"), calendar: cal) == "Together 12 days")
        #expect(CompanionTogether.label(createdAt: made, now: at("2026-10-23T23:59:00Z"), calendar: cal) == "Met today")
        #expect(CompanionTogether.label(createdAt: made, now: at("2026-10-24T08:00:00Z"), calendar: cal) == "Met today")
        #expect(CompanionTogether.label(createdAt: made, now: at("2026-10-25T08:00:00Z"), calendar: cal) == "Together 2 days")
    }

    @Test func nothingWhenUnknown() {
        #expect(CompanionTogether.label(createdAt: nil) == nil)
        #expect(CompanionTogether.label(createdAt: "yesterday") == nil)
        #expect(CompanionTogether.label(createdAt: "2030-01-01T00:00:00Z", now: at("2026-11-04T00:00:00Z"), calendar: cal) == nil)
    }

    @Test func companionInfoDecodesCreatedAt() throws {
        let info = try JSONDecoder().decode(CompanionInfo.self, from: Data(#"{"id":"c1","name":"Mira","createdAt":"2026-10-23T22:30:00.000Z"}"#.utf8))
        #expect(info.createdAt == "2026-10-23T22:30:00.000Z")
        let old = try JSONDecoder().decode(CompanionInfo.self, from: Data(#"{"id":"c1","name":"Mira"}"#.utf8))
        #expect(old.createdAt == nil)
    }
}
