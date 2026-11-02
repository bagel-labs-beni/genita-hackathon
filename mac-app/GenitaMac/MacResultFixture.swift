#if DEBUG
import Foundation

/// Debug review only (GENITA_MAC_REVIEW_OUT): MAC-RS-a / MAC-RS-b / MAC-LINK drawn from wire events in the
/// shape #119 sends (`find.started` → `find.created` kind `product`), with the Figma frames' copy.
enum MacResultFixture {
    static let findId = "mac-rs-fixture"
    static let started = #"{"type":"find.started","findId":"mac-rs-fixture","utteranceId":3,"kind":"product","title":"Looking for 2 that match your style…","detail":"Light jacket · this weekend"}"#
    static let created = #"""
    {"type":"find.created","findId":"mac-rs-fixture","card":{"id":"mac-rs-fixture","kind":"product","createdAt":"2026-11-03T10:00:00.000Z",
     "eyebrow":"From what you said","title":"Two for the weekend","subtitle":"Light jackets, matched to your style.",
     "say":"I found two. Their simple cuts match your style.","items":[],
     "steps":[{"text":"Clean, minimal","source":"northline.co"},{"text":"Light for a weekend","source":"northline.co"},
              {"text":"Understated color","source":"fieldandco.com"},{"text":"Easy to layer","source":"fieldandco.com"}],
     "options":[],"why":["“Clean, minimal clothes. Understated colors.” · for this weekend"],"ask":[],
     "sources":[{"title":"Cotton chore jacket · $68","url":"https://northline.co/jackets/cotton-chore-jacket","domain":"northline.co"},
                {"title":"Linen overshirt","url":"https://fieldandco.com/p/linen-overshirt","domain":"fieldandco.com"}],
     "how":["From your import and what you said · northline.co · fieldandco.com"],"saved":false}}
    """#

    static func events(results: Bool) -> [ServerEvent] {
        ([started] + (results ? [created] : [])).compactMap { try? ServerEvent.decode($0) }
    }

    static var firstPick: ProductPick? {
        guard case let .findCreated(c)? = try? ServerEvent.decode(created) else { return nil }
        return ProductPicks.picks(from: c.card).first
    }
}
#endif
