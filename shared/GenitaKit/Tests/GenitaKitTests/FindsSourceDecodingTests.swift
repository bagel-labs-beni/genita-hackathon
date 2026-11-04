import Foundation
import Testing
@testable import GenitaKit

/// Finds r01: `sources[i]` grew optional why / image / favicon. A card from an older server (title · url · domain only)
/// must still decode, and the new fields must round-trip.
struct FindsSourceDecodingTests {
    @Test func testOldServerSourceDecodesWithoutNewFields() throws {
        let json = #"{"title":"Yeontabal — charcoal galbi","url":"https://example.com/a","domain":"example.com"}"#
        let s = try JSONDecoder().decode(FindCard.Source.self, from: Data(json.utf8))
        #expect(s.title == "Yeontabal — charcoal galbi")
        #expect(s.why == nil)
        #expect(s.image == nil)
        #expect(s.favicon == nil)
        // no why: the title stays whole (old servers keep the reason on it)
        #expect(s.displayTitle == "Yeontabal — charcoal galbi")
        // re-encoding an old source adds no keys
        let again = try JSONSerialization.jsonObject(with: JSONEncoder().encode(s)) as! NSDictionary
        #expect(Set(again.allKeys as! [String]) == ["title", "url", "domain"])
    }

    @Test func testNewServerSourceDecodesWhyImageFavicon() throws {
        let json = #"{"title":"Yeontabal — charcoal galbi locals queue for","url":"https://example.com/a","domain":"example.com","why":"charcoal galbi locals queue for","image":{"slot":"source-0","status":"pending"},"favicon":"/v1/finds/f1/images/favicon-0"}"#
        let s = try JSONDecoder().decode(FindCard.Source.self, from: Data(json.utf8))
        #expect(s.why == "charcoal galbi locals queue for")
        #expect(s.image == FindImage(slot: "source-0", status: .pending))
        #expect(s.favicon == "/v1/finds/f1/images/favicon-0")
        #expect(s.displayTitle == "Yeontabal")
        #expect(try JSONDecoder().decode(FindCard.Source.self, from: JSONEncoder().encode(s)) == s)
    }

    @Test func testOldServerCardWithSourcesDecodes() throws {
        let json = #"{"id":"f1","kind":"link","createdAt":"2026-11-04T10:00:00Z","eyebrow":"Finds","title":"Best KBBQ in Suwon","subtitle":"","items":[],"steps":[{"text":"Yeontabal — charcoal galbi"}],"options":[],"why":[],"ask":[],"sources":[{"title":"Yeontabal","url":"https://example.com/a","domain":"example.com"}],"how":[]}"#
        let card = try JSONDecoder().decode(FindCard.self, from: Data(json.utf8))
        #expect(card.sources.count == 1)
        #expect(card.sources[0].why == nil && card.sources[0].image == nil)
    }
}
