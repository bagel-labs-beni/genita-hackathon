import XCTest
@testable import Genita

/// F9 · #118 / #121: the pure parts of the Mac call client — what it sends in `start` (from the account's
/// companion on the server, never a hard-coded name) and what the MAC-RS sheet reads off a product card.
/// Also runs without Xcode: `tests/mac-call/run.sh`.
final class MacCallPlanTests: XCTestCase {
    private func companion(_ json: String) -> CompanionCallPlan? { CompanionCallPlan(companionJSON: Data(json.utf8)) }

    private let full = """
    {"id":"c1","type":"human","name":"Mina","voiceId":"v1","imageId":"i1","createdAt":"2026-11-02T00:00:00Z",
     "prep":{"status":"ready","sceneUrl":"/v1/companion/scene.jpg"},
     "persona":{"card":{"name":"Mina","kind":"human","traits":["Calm","Witty"],"speakingStyle":"short"}},
     "session":{"persona":{"name":"Mina","kind":"human","traits":["Calm","Witty"],"speakingStyle":"short"},
                "user":{"profile":"Likes: clean, minimal clothes."},"voiceId":"v1","lip":"atlas"}}
    """

    func testStartUsesTheServerCompanionName() throws {
        let plan = try XCTUnwrap(companion(full))
        XCTAssertEqual(plan.name, "Mina")
        XCTAssertEqual(plan.start.persona.name, "Mina")
        XCTAssertEqual(plan.start.persona.traits ?? [], ["Calm", "Witty"])
        XCTAssertEqual(plan.start.user?.profile, "Likes: clean, minimal clothes.")
        XCTAssertEqual(plan.start.voiceId, "v1")
    }

    func testRenamedCompanionWinsOverAnOlderPersonaCard() throws {
        // PATCH /v1/companion {name} renames the record; the card can still carry the old name
        let plan = try XCTUnwrap(companion(full.replacingOccurrences(of: "\"name\":\"Mina\",\"voiceId\"", with: "\"name\":\"Max\",\"voiceId\"")))
        XCTAssertEqual(plan.name, "Max")
        XCTAssertEqual(plan.start.persona.name, "Max")
    }

    func testCompanionWithoutPersonaStillCallsByItsName() throws {
        let plan = try XCTUnwrap(companion(#"{"id":"c1","type":"animal","name":"Bori","voiceId":"v2","prep":{"status":"running","sceneUrl":null},"persona":null,"session":null}"#))
        XCTAssertEqual(plan.start.persona.name, "Bori")
        XCTAssertEqual(plan.start.persona.kind, .animal)
        XCTAssertNil(plan.start.user?.profile)
        XCTAssertNil(plan.faceURL)
    }

    func testNoNameMeansNoCall() {
        XCTAssertNil(companion(#"{"id":"c1","type":"human","name":"  ","prep":{}}"#))
        XCTAssertNil(companion("not json"))
    }

    func testFaceURLResolvesAgainstTheServer() throws {
        let plan = try XCTUnwrap(companion(full))
        XCTAssertEqual(plan.faceURL(base: URL(string: "https://d72kt0jfmscyj.cloudfront.net")!)?.absoluteString, "https://d72kt0jfmscyj.cloudfront.net/v1/companion/scene.jpg")
        let absolute = try XCTUnwrap(companion(full.replacingOccurrences(of: "/v1/companion/scene.jpg", with: "https://cdn.example.com/s.jpg")))
        XCTAssertEqual(absolute.faceURL(base: URL(string: "https://d72kt0jfmscyj.cloudfront.net")!)?.absoluteString, "https://cdn.example.com/s.jpg")
    }

    // MARK: MAC-RS product picks (#171 payload: card.products + card.evidence)

    /// `shared/protocol-samples/server/find.created.product.json` (#171), as the server sends it.
    private let productSample = #"""
    {"type":"find.created","findId":"4c2d9b10","card":{"id":"4c2d9b10","kind":"product","createdAt":"2026-11-03T06:10:00.000Z",
     "eyebrow":"From what you said","title":"Two for the weekend","subtitle":"Light jackets, matched to your style.",
     "status":"2 links · northline.example.com, fieldandco.example.com","say":"Two options. Simple cuts, like you prefer.",
     "items":[],"steps":[],"options":[],"why":[],"ask":[],
     "sources":[{"title":"Cotton chore jacket","url":"https://northline.example.com/products/cotton-chore-jacket-navy","domain":"northline.example.com"},
                {"title":"Linen overshirt","url":"https://fieldandco.example.com/product/linen-overshirt-123456.html","domain":"fieldandco.example.com"}],
     "how":["Blue: your style, from your import. Grey: what you said.","Searched the web · northline.example.com, fieldandco.example.com"],
     "products":[{"id":"p1","name":"Cotton chore jacket","url":"https://northline.example.com/products/cotton-chore-jacket-navy","domain":"northline.example.com",
                  "store":"Northline","price":"$68","image":{"slot":"product-1","status":"pending"},"taste":"Clean, minimal","situation":"Light for a weekend"},
                 {"id":"p2","name":"Linen overshirt","url":"https://fieldandco.example.com/product/linen-overshirt-123456.html","domain":"fieldandco.example.com",
                  "store":"Field & Co.","taste":"Understated color","situation":"Easy to layer"}],
     "evidence":{"style":"Clean, minimal clothes. Understated colors.","situation":"Mild and dry this weekend, 18°C"}}}
    """#

    private func sampleCard() throws -> FindCard {
        guard case let .findCreated(c) = try ServerEvent.decode(productSample) else { throw NSError(domain: "not find.created", code: 1) }
        return c.card
    }

    func testPicksAreTheServerProducts() throws {
        let picks = ProductPicks.picks(from: try sampleCard())
        XCTAssertEqual(picks.map(\.name), ["Cotton chore jacket", "Linen overshirt"])
        XCTAssertEqual(picks.map(\.brandLine), ["Northline · $68", "Field & Co. · Price on site"])
        XCTAssertEqual(picks.map(\.taste), ["Clean, minimal", "Understated color"])
        XCTAssertEqual(picks.map(\.situation), ["Light for a weekend", "Easy to layer"])
        XCTAssertEqual(picks[0].url.absoluteString, "https://northline.example.com/products/cotton-chore-jacket-navy")
        XCTAssertEqual(picks[0].image?.slot, "product-1")
        XCTAssertNil(picks[1].image)
    }

    func testOnlyWebPagesAndAtMostTwo() throws {
        var c = try sampleCard()
        let p = c.products![0]
        c.products = ["javascript:alert(1)", "file:///etc/hosts", "genita://auth?code=1", "https://shop.example/c", "http://shop.example/d", "https://shop.example/e"].enumerated().map { i, url in
            FindCard.Product(id: "p\(i)", name: "N\(i)", url: url, domain: "shop.example", store: "", taste: p.taste, situation: p.situation)
        }
        let picks = ProductPicks.picks(from: c)
        XCTAssertEqual(picks.map(\.name), ["N3", "N4"])
        XCTAssertEqual(picks[0].brandLine, "shop.example · Price on site") // no store name → the domain
        XCTAssertNil(ExternalLink.web("genita://auth?code=1"))
        XCTAssertNil(ExternalLink.web("https://"))
        XCTAssertEqual(ExternalLink.web("https://northline.co/x")?.host, "northline.co")
    }

    func testAProductCardWithoutProductsHasNoPicks() throws {
        var c = try sampleCard()
        c.products = nil
        XCTAssertEqual(ProductPicks.picks(from: c), [])
    }

    func testEvidenceQuotesTheServerStyleAndSituation() throws {
        let e = ProductPicks.evidence(from: try sampleCard())
        XCTAssertEqual(e.lines, ["“Clean, minimal clothes. Understated colors.” · Mild and dry this weekend, 18°C",
                                 "From your style and what you said · northline.example.com +1"])
    }

    func testNoImportMeansNoStyleQuote() throws {
        var c = try sampleCard()
        c.evidence = .init(style: "", situation: "Mild and dry this weekend, 18°C")
        XCTAssertEqual(ProductPicks.evidence(from: c).lines, ["Mild and dry this weekend, 18°C",
                                                              "From what you said · northline.example.com +1"])
    }

    /// D4: the colour legend never shows; the marks on the chips say where each came from.
    func testNoColourLegend() throws {
        var c = try sampleCard()
        c.evidence = nil
        XCTAssertFalse(ProductPicks.evidence(from: c).lines.contains { $0.hasPrefix("Blue:") || $0.hasPrefix("Grey:") })
        XCTAssertTrue(ProductPicks.isLegend("Blue: your style, from your import. Grey: what you said."))
        XCTAssertTrue(ProductPicks.isLegend("Grey: what you said. I don’t know your style yet."))
        XCTAssertFalse(ProductPicks.isLegend("Searched the web · northline.example.com +1"))
    }

    func testOlderCardsShowTheirWhyAndHow() throws {
        var c = try sampleCard()
        c.evidence = nil
        c.why = ["Because"]
        XCTAssertEqual(ProductPicks.evidence(from: c).lines, ["Because"] + c.how)
    }

    func testSearchingWhyIsTheEarlierImportLine() throws {
        // MF-1: the import line the last product answer stood on (not its situation — a new ask may be another thing);
        // a first search has no line yet
        let earlier = try sampleCard()
        XCTAssertEqual(ProductPicks.searchingWhy(after: [earlier]), "“Clean, minimal clothes. Understated colors.”")
        var noImport = earlier
        noImport.evidence = .init(style: "", situation: "Mild and dry this weekend, 18°C")
        XCTAssertNil(ProductPicks.searchingWhy(after: [noImport]))
        XCTAssertNil(ProductPicks.searchingWhy(after: []))
        var noEvidence = earlier
        noEvidence.evidence = nil
        XCTAssertNil(ProductPicks.searchingWhy(after: [noEvidence]))
        var recipe = earlier
        recipe.kind = .recipe
        XCTAssertNil(ProductPicks.searchingWhy(after: [recipe]))
    }

    // MARK: call pill — one line (#211, Chelsea 11/3)

    func testLongSpokenLineFallsBackToItsFirstSentence() {
        // "I found two. Their simple cuts / match your style." wrapped in the pill; the pill shows the first sentence
        XCTAssertEqual(CueLine.summaries("I found two. Their simple cuts match your style."), ["I found two."])
        XCTAssertEqual(CueLine.summaries("Two options! Simple cuts, like you prefer."), ["Two options!"])
        XCTAssertEqual(CueLine.summaries("Right here?  We're looking for a jacket."), ["Right here?"])
        // a dot inside a price or a name is not a sentence end
        XCTAssertEqual(CueLine.summaries("It's $68.50 at Northline. Want the link?"), ["It's $68.50 at Northline."])
        XCTAssertEqual(CueLine.summaries("Field & Co. has one in linen."), [])
    }

    func testOneSentenceHasNoSummary() {
        // one sentence: the pill shortens by whole words (OneLineText) — nothing to add here
        XCTAssertEqual(CueLine.summaries("Mina is talking"), [])
        XCTAssertEqual(CueLine.summaries("Two options that fit your style."), [])
        XCTAssertEqual(CueLine.summaries("  "), [])
    }

    // MARK: A02-J on the Mac (#166 POST /auth/judge)

    func testJudgeCodeAnswersBecomeOneLine() {
        XCTAssertEqual(JudgeAccess.message(status: 401), "That code didn’t work. Check it and try again.")
        XCTAssertEqual(JudgeAccess.message(status: 429), "Too many tries. Wait 10 minutes and try again.")
        XCTAssertEqual(JudgeAccess.message(status: 429, retryAfterSec: 125), "Too many tries. Try again in 3 min.", "the server's wait (11/4)")
        XCTAssertEqual(JudgeAccess.message(status: 429, retryAfterSec: 2), "Too many tries. Try again in 1 min.")
        XCTAssertEqual(JudgeAccess.message(status: 404), "Judge access isn’t available right now.")
        XCTAssertEqual(JudgeAccess.message(status: nil), "Couldn’t reach the server. Check your connection.")
        XCTAssertNil(JudgeAccess.message(status: 200))
    }

    func testJudgeRequestCarriesTheTrimmedCodeAndTheMac() throws {
        let req = try XCTUnwrap(JudgeAccess.request(code: "  ABCD-1234 \n", base: URL(string: "https://d72kt0jfmscyj.cloudfront.net")!))
        XCTAssertEqual(req.url?.absoluteString, "https://d72kt0jfmscyj.cloudfront.net/auth/judge")
        XCTAssertEqual(req.httpMethod, "POST")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(req.httpBody)) as? [String: String])
        XCTAssertEqual(body, ["code": "ABCD-1234", "device": "mac"])
        XCTAssertNil(JudgeAccess.request(code: "   ", base: URL(string: "https://x.example")!))
    }
}
