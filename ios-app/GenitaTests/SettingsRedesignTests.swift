import XCTest
@testable import Genita

/// M02 r01 C (춘식이 prefs, build 8): the settings first screen and the About you page.
final class SettingsRedesignTests: XCTestCase {
    /// As-is: "• Not enough information yet." four to six times. To-be: known lines as rows, unknowns in one block.
    func testAboutYouDropsTheRepeatedNotEnoughLines() {
        let text = "Communication style\n• Warm, direct.\nInterests\n• Not enough information yet.\nBoundaries\n• Ask first.\nHumor\n• Not enough information yet."
        let rows = AboutYouPage.noticed(text)
        XCTAssertEqual(rows.map(\.category), ["Communication style", "Boundaries"])
        XCTAssertEqual(rows.map(\.claims), [["Warm, direct."], ["Ask first."]])
        XCTAssertTrue(AboutYouPage.noticed("Interests\n• Not enough information yet.").isEmpty, "nothing known: no rows, only Still learning")
        XCTAssertEqual(AboutYouPage.noticed("Just a pasted paragraph.").map(\.claims), [["Just a pasted paragraph."]])
    }

    func testAboutYouRowSummary() {
        XCTAssertEqual(AboutYouSummary.make(headline: nil, known: 0, learning: 3, companion: "Lou"), AboutYouSummary(preview: "Lou is still getting to know you.", counts: nil))
        XCTAssertEqual(AboutYouSummary.make(headline: "You want two good options, a laugh, and the final say.", known: 5, learning: 3, companion: "Lou"),
                       AboutYouSummary(preview: "“You want two good options, a laugh, and the final say.”", counts: "5 things · 3 still learning"))
        XCTAssertEqual(AboutYouSummary.make(headline: "You keep it light.", known: 1, learning: 0, companion: "Lou").counts, "1 thing")
    }

    /// "How {name} shows up": Help with first (the first screen shows it), then the onboarding order.
    func testShowsUpOrder() {
        let keys = SettingsShowsUpPage.keys(["tempo": "2", "help": "Think with me", "zzz": "x", "relationship": "Friend"])
        XCTAssertEqual(keys, ["help", "relationship", "tempo", "zzz"])
    }
}
