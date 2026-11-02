#if DEBUG
import Foundation

/// Debug review only (GENITA_MAC_REVIEW_OUT): MF-1~3 (MAC-RS-a / MAC-RS-b / MAC-LINK) drawn from wire events in
/// the shape server #171 sends (`find.started` → `find.created` kind `product` with `products[]` + `evidence`),
/// with the Figma frames' copy. Pictures stay pending (the renders have no server), so the cards show the bag.
enum MacResultFixture {
    static let findId = "mac-rs-fixture"
    static let started = #"{"type":"find.started","findId":"mac-rs-fixture","utteranceId":3,"kind":"product","title":"Finding 2 for your style…","detail":"Light jacket · searching shops"}"#
    static let created = card(id: findId)
    /// PF-1d: the server's search_failed line (product.ts), split "Title. Body" by the shared model.
    static let failed = #"{"type":"find.failed","findId":"mac-rs-fixture","reason":"search_failed","message":"Couldn’t find a good match. Try a color or a price, or ask me again."}"#
    /// An earlier product answer in the same call — MF-1 shows what a refine ("match my style") stands on.
    static let earlier = card(id: "mac-rs-earlier")
    /// FindsModel keeps a card only after its own find.started.
    static let earlierStarted = started.replacingOccurrences(of: "mac-rs-fixture", with: "mac-rs-earlier")

    private static func card(id: String) -> String {
        #"""
        {"type":"find.created","findId":"\#(id)","card":{"id":"\#(id)","kind":"product","createdAt":"2026-11-03T10:00:00.000Z",
         "eyebrow":"From what you said","title":"Two for the weekend","subtitle":"Light jackets, matched to your style.",
         "status":"2 links · northline.co, fieldandco.com","say":"I found two. Their simple cuts match your style.",
         "items":[],"steps":[],"options":[],"why":[],"ask":[],
         "sources":[{"title":"Cotton chore jacket","url":"https://northline.co/jackets/cotton-chore-jacket","domain":"northline.co"},
                    {"title":"Linen overshirt","url":"https://fieldandco.com/p/linen-overshirt","domain":"fieldandco.com"}],
         "how":["Blue: your style, from your import. Grey: what you said.","Searched the web · northline.co, fieldandco.com"],
         "products":[{"id":"p1","name":"Cotton chore jacket","url":"https://northline.co/jackets/cotton-chore-jacket","domain":"northline.co",
                      "store":"Northline","price":"$68","image":{"slot":"product-1","status":"pending"},"taste":"Clean, minimal","situation":"Light for a weekend"},
                     {"id":"p2","name":"Linen overshirt","url":"https://fieldandco.com/p/linen-overshirt","domain":"fieldandco.com",
                      "store":"Field & Co.","image":{"slot":"product-2","status":"pending"},"taste":"Understated color","situation":"Easy to layer"}],
         "evidence":{"style":"Clean, minimal clothes. Understated colors.","situation":"for this weekend"}}}
        """#
    }

    enum Scene: String, CaseIterable { case searching, refining, results, failed }

    static func events(_ scene: Scene) -> [ServerEvent] {
        let wire: [String] = switch scene {
        case .searching: [started]
        case .refining: [earlierStarted, earlier, started]
        case .results: [started, created]
        case .failed: [started, failed]
        }
        return wire.compactMap { try? ServerEvent.decode($0) }
    }

    /// Loads a scene into the call's Finds model and shows the newest find (a refine's search, not the earlier card).
    @MainActor static func load(_ scene: Scene, into finds: FindsModel, state: SheetState) {
        finds.latestQuestion = "Find a couple that match my style, and send me the links." // the ask Retry repeats
        finds.load(recorded: events(scene), frames: [])
        finds.page = max(0, finds.entries.count - 1)
        finds.force(state)
    }

    static var firstPick: ProductPick? {
        guard case let .findCreated(c)? = try? ServerEvent.decode(created) else { return nil }
        return ProductPicks.picks(from: c.card).first
    }
}
#endif
