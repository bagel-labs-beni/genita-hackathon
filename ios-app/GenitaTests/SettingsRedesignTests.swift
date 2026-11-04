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
                       AboutYouSummary(preview: "“You want two good options, a laugh, and the final\u{00A0}say.”", counts: "5 things · 3 still learning"))
        // no report: the row says what the page behind it shows (QA: "still getting to know you" over five known lines)
        let noticed = AboutYouPage.noticed("Communication style\n• Warm, direct.\nBoundaries\n• Ask first.")
        XCTAssertEqual(AboutYouSummary(noticed: noticed, companion: "Jin"), AboutYouSummary(preview: "“Warm,\u{00A0}direct.”", counts: "2 things"))
        XCTAssertEqual(AboutYouSummary(noticed: [], companion: "Jin").preview, "Jin is still getting to know you.")
        XCTAssertEqual(AboutYouSummary.make(headline: "You keep it light.", known: 1, learning: 0, companion: "Lou").counts, "1 thing")
    }

    /// "How {name} shows up": Help with first (the first screen shows it), then the onboarding order.
    func testShowsUpOrder() {
        let keys = SettingsShowsUpPage.keys(["tempo": "2", "help": "Think with me", "zzz": "x", "relationship": "Friend"])
        XCTAssertEqual(keys, ["help", "relationship", "tempo", "zzz"])
    }

    /// UI QA b10 (CI `preview-10b-about-you` / `10c-shows-up`): a full Finds state left behind turned the app dark under the
    /// settings sheet, so the sub-page titles were white on #F2F2F7. A full sheet darkens only when Settings isn't up.
    func testAFullFindsSheetNeverDarkensSettings() {
        XCTAssertTrue(GenitaApp.findsFullDark(.full, settingsUp: false), "PF-1b: the dark band over a full sheet")
        XCTAssertFalse(GenitaApp.findsFullDark(.full, settingsUp: true), "red on b10: Settings over a leftover full state went dark")
        for state in SheetState.allCases where state != .full {
            XCTAssertFalse(GenitaApp.findsFullDark(state, settingsUp: false), state.rawValue)
        }
    }
}
