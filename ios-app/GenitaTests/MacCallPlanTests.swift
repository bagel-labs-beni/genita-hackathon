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

    // MARK: MAC-RS product picks

    private func card(_ sources: [(String, String, String)], steps: [(String, String?)] = [], why: [String] = [], how: [String] = []) -> FindCard {
        FindCard(id: "f1", kind: .product, createdAt: "2026-11-03T10:00:00Z", eyebrow: "From what you said", title: "Two for the weekend",
                 subtitle: "Light jackets, matched to your style.", status: nil, say: nil, hero: nil, camera: nil, items: [],
                 steps: steps.map { .init(text: $0.0, source: $0.1) }, options: [], why: why, ask: [],
                 sources: sources.map { .init(title: $0.0, url: $0.1, domain: $0.2) }, how: how, page: nil, saved: false)
    }

    func testTwoProductsWithTheirReasonChips() {
        let c = card([("Cotton chore jacket · $68", "https://northline.co/jackets/cotton-chore-jacket", "northline.co"),
                      ("Linen overshirt", "https://fieldandco.com/p/linen-overshirt", "fieldandco.com")],
                     steps: [("Clean, minimal", "northline.co"), ("Understated color", "fieldandco.com"), ("Light for a weekend", "northline.co"), ("Easy to layer", "fieldandco.com")])
        let picks = ProductPicks.picks(from: c)
        XCTAssertEqual(picks.map(\.name), ["Cotton chore jacket", "Linen overshirt"])
        XCTAssertEqual(picks.map(\.price), ["$68", nil])
        XCTAssertEqual(picks[0].reasons, ["Clean, minimal", "Light for a weekend"])
        XCTAssertEqual(picks[1].reasons, ["Understated color", "Easy to layer"])
        XCTAssertEqual(picks[1].brandLine, "fieldandco.com · Price on site")
        XCTAssertEqual(picks[0].brandLine, "northline.co · $68")
    }

    func testOnlyWebPagesAndAtMostTwo() {
        let c = card([("A", "javascript:alert(1)", "x"), ("B", "file:///etc/hosts", "y"), ("C", "https://shop.example/c", "shop.example"),
                      ("D", "http://shop.example/d", "shop.example"), ("E", "https://shop.example/e", "shop.example")])
        XCTAssertEqual(ProductPicks.picks(from: c).map(\.name), ["C", "D"])
        XCTAssertNil(ExternalLink.web("genita://auth?code=1"))
        XCTAssertNil(ExternalLink.web("https://"))
        XCTAssertEqual(ExternalLink.web("https://northline.co/x")?.host, "northline.co")
    }

    func testEvidenceIsTheServerLinesVerbatim() {
        let why = ["“Clean, minimal clothes. Understated colors.” · for this weekend"]
        let how = ["From your import and what you said · northline.co · fieldandco.com"]
        let e = ProductPicks.evidence(from: card([], why: why, how: how))
        XCTAssertEqual(e.lines, why + how)
    }

    // MARK: A02-J on the Mac (#166 POST /auth/judge)

    func testJudgeCodeAnswersBecomeOneLine() {
        XCTAssertEqual(JudgeAccess.message(status: 401), "That code didn’t work. Check it and try again.")
        XCTAssertEqual(JudgeAccess.message(status: 429), "Too many tries. Wait 10 minutes and try again.")
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
