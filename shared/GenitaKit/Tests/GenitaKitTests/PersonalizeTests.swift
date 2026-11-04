import Foundation
import Testing
@testable import GenitaKit

// Lane 개인화 (D47 HISY v2 / D48): the "How I see you" cards, C1 corrections, the in-call chips and Finds
// reason chips — against genita-server/PREP_API.md "How I see you + corrections (D47 HISY v2)" and PROTOCOL.md (11/3).

/// The six cards in the server's order (src/personalize/story.ts, HISY-1~6 copy).
let storyCardsJSON = #"""
[{"id":"think","eyebrow":"How you think","headline":"You decide by comparing, not by guessing.","items":[{"text":"When a choice matters, you line up two real options and pick between them.","evidence":"observed"},{"text":"You talk big decisions through out loud before you commit.","evidence":"explicit"}],"evidence":"explicit"},
{"id":"talk","eyebrow":"How you like to talk","headline":"Warm, direct, and short.","items":[{"text":"You like a friendly tone, but you want the answer first.","evidence":"explicit"}],"promise":"So I'll lead with the answer.","evidence":"explicit"},
{"id":"taste","eyebrow":"What you're into","headline":"Clean lines, slow stories, home cooking.","items":[],"evidence":"memory","tags":[{"group":"style","text":"Clean, minimal","dislike":false},{"group":"food","text":"Cilantro","dislike":true},{"group":"watch","text":"Slow-burn dramas","dislike":false}]},
{"id":"help","eyebrow":"How I can help","headline":"Where I'll actually be useful.","items":[],"evidence":"observed","help":[{"label":"Find clothes that fit your style","sub":"Two picks, with links","mode":"ask_first"},{"label":"Cook with what's in your fridge","sub":"One recipe and what to buy","mode":"just_do_it"}]},
{"id":"lines","eyebrow":"Lines I won't cross","headline":"Some things I'll leave alone.","items":[{"text":"No advice you didn't ask for.","evidence":"explicit"}],"evidence":"explicit"},
{"id":"unknowns","eyebrow":"Still getting to know you","headline":"A few things I don't know yet.","subline":"Your reply didn't say. I'll ask you in our calls, one at a time.","items":[],"evidence":"explicit","unknowns":[{"item":"Budget","topic":"What you spend on clothes","sub":"So my picks fit your budget"}]}]
"""#

private let rowsJSON = #"""
[{"key":"communication","title":"Communication style","items":[{"text":"Warm, direct.","label":"explicit"}]},
{"key":"response","title":"Response preferences","items":[]},
{"key":"help","title":"How Genita can help","items":[]},
{"key":"interests","title":"Interests","items":[]},
{"key":"likes","title":"Likes & dislikes","items":[{"text":"Loves cilantro.","label":"explicit"}]},
{"key":"boundaries","title":"Boundaries","items":[]}]
"""#

private func importJSON(story: String) -> String {
    #"{"status":"ready","profile":"How the user wants to be treated:\n- Talk: Warm.","style":{"version":1,"source":"import","partial":false,"toConfirm":[],"display":"# + rowsJSON + #"},"story":"# + story + "}"
}

/// Its own URLProtocol: OnbStub / StubProtocol belong to suites that run in parallel with this one.
final class PersonalizeStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) -> (Int, Data))?
    nonisolated(unsafe) static var seen: [URLRequest] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var req = request
        if req.httpBody == nil, let stream = req.httpBodyStream {
            stream.open(); var data = Data(); var buf = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable { let n = stream.read(&buf, maxLength: buf.count); if n <= 0 { break }; data.append(buf, count: n) }
            stream.close(); req.httpBody = data
        }
        Self.seen.append(req)
        let (status, body) = Self.handler?(req) ?? (500, Data())
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: req.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@Suite(.serialized) struct PersonalizeClientTests {
    let client: OnboardingClient

    init() {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [PersonalizeStub.self]
        client = OnboardingClient(auth: GenitaAuthClient(baseURL: URL(string: "https://api.test")!, store: InMemoryTokenStore("tok"), session: URLSession(configuration: cfg)))
        PersonalizeStub.seen = []
    }

    @Test func importCarriesTheSixCardsInOrder() async throws {
        PersonalizeStub.handler = { _ in (200, Data(importJSON(story: storyCardsJSON).utf8)) }
        let s = try await client.importReply("my reply")
        let story = try #require(s.story)
        #expect(story.map(\.id) == ["think", "talk", "taste", "help", "lines", "unknowns"])
        let think = story[0]
        #expect(think.eyebrow == "How you think" && think.headline.hasPrefix("You decide"))
        #expect(think.items.map(\.evidenceLabel) == ["You did this often", "You said this"])
        #expect(story[1].promise == "So I'll lead with the answer.")
        let taste = story[2]
        #expect(taste.evidenceLabel == "From your memories")
        #expect(taste.tags?.first { $0.dislike }?.text == "Cilantro")
        #expect(taste.tagGroups.map(\.title) == ["Style", "Food", "Watch & listen"])
        #expect(story[3].help?.map(\.mode) == [.askFirst, .justDoIt] && story[3].help?.first?.sub == "Two picks, with links")
        #expect(story[5].subline?.hasPrefix("Your reply didn't say") == true && story[5].unknowns?.first?.topic == "What you spend on clothes")
        #expect(s.rows.count == 6, "the six I04 rows are still stored")
    }

    /// C1 offers the card's own texts in the server's `cardTexts` order; a dislike reads "Not for you: <tag lowercased>".
    @Test func correctionChoicesAreTheCardsOwnTexts() throws {
        let cards = try JSONDecoder().decode([StoryCard].self, from: Data(storyCardsJSON.utf8))
        #expect(cards[0].correctionChoices == ["When a choice matters, you line up two real options and pick between them.", "You talk big decisions through out loud before you commit."])
        #expect(cards[2].correctionChoices == ["Clean, minimal", "Not for you: cilantro", "Slow-burn dramas"])
        #expect(cards[3].correctionChoices == ["Find clothes that fit your style", "Cook with what's in your fridge"])
        #expect(cards[5].correctionChoices == ["What you spend on clothes"])
        let dislike = try #require(cards[2].tags?.first { $0.dislike })
        #expect(dislike.choiceText == "Not for you: cilantro")
    }

    @Test func importWithoutAStoryOrWithABrokenOneStillLands() async throws {
        PersonalizeStub.handler = { _ in (200, Data(importJSON(story: "null").utf8)) }
        #expect(try await client.importReply("x").story == nil, "story null: read it later with GET /v1/profile/story")
        PersonalizeStub.handler = { _ in (200, Data(importJSON(story: #"[{"id":7}]"#).utf8)) }
        let s = try await client.importReply("x")
        #expect(s.story == nil && s.rows.count == 6, "a story the app can't read never fails the import")
        // one bad card drops only that card
        let mixed = "[" + #"{"id":"think","eyebrow":"How you think","headline":"H","items":[],"evidence":"explicit"},{"id":"talk"}"# + "]"
        PersonalizeStub.handler = { _ in (200, Data(importJSON(story: mixed).utf8)) }
        #expect(try await client.importReply("x").story?.map(\.id) == ["think"])
    }

    @Test func storyAsksTheServerToWait() async throws {
        PersonalizeStub.handler = { _ in (200, Data((#"{"status":"ready","source":"skip","cards":"# + storyCardsJSON + "}").utf8)) }
        let r = try await client.story(wait: 8)
        let req = try #require(PersonalizeStub.seen.last)
        #expect(req.httpMethod == "GET" && req.url?.path == "/v1/profile/story" && req.url?.query == "wait=8")
        #expect(req.timeoutInterval >= 18, "the server holds the answer up to `wait` seconds")
        #expect(r.status == .ready && r.source == "skip" && r.cards.count == 6)
        PersonalizeStub.handler = { _ in (200, Data(#"{"status":"processing","source":"import","cards":[]}"#.utf8)) }
        #expect(try await client.story(wait: 8).status == .processing)
    }

    @Test func correctionSendsTheCardTheMarkedItemsAndTheTextAndReadsChanged() async throws {
        let card = #"{"id":"taste","eyebrow":"What you're into","headline":"Clean lines, slow stories, home cooking.","items":[],"evidence":"memory","tags":[{"group":"food","text":"Cilantro","dislike":false},{"group":"food","text":"Raw onion","dislike":true}]}"#
        PersonalizeStub.handler = { _ in (200, Data((#"{"card":"# + card + #","ack":"Got it. I'll remember that.","changed":["Cilantro","Not for you: raw onion"],"profile":"- Likes: cilantro","rows":"# + rowsJSON + "}").utf8)) }
        let r = try await client.correct(cardId: "taste", items: ["Not for you: cilantro"], text: "  I actually love cilantro. Raw onion is the one I skip.  ")
        let req = try #require(PersonalizeStub.seen.last)
        #expect(req.httpMethod == "PATCH" && req.url?.path == "/v1/profile")
        let body = try JSONSerialization.jsonObject(with: try #require(req.httpBody)) as! [String: Any]
        #expect(body["cardId"] as? String == "taste" && body["items"] as? [String] == ["Not for you: cilantro"])
        #expect(body["text"] as? String == "I actually love cilantro. Raw onion is the one I skip.")
        #expect(body["pick"] == nil)
        #expect(r.card?.tags?.count == 2 && r.ack == "Got it. I'll remember that." && r.changed == ["Cilantro", "Not for you: raw onion"])
        #expect(r.rows.first { $0.key == "likes" }?.items.first?.text == "Loves cilantro.")
        let raw = try #require(r.card?.tags?.last)
        let first = try #require(r.card?.tags?.first)
        #expect(r.isChanged(raw) && r.isChanged(first))
    }

    @Test func correctionLeavesOutEmptyItemsOrTextAndReadsANullCard() async throws {
        PersonalizeStub.handler = { _ in (200, Data((#"{"card":null,"ack":"Got it. I'll remember that.","changed":[],"profile":"","rows":"# + rowsJSON + "}").utf8)) }
        let r = try await client.correct(cardId: "lines", items: ["No advice you didn't ask for."], text: "   ")
        let body = try JSONSerialization.jsonObject(with: try #require(PersonalizeStub.seen.last?.httpBody)) as! [String: Any]
        #expect(body["text"] == nil && (body["items"] as? [String])?.count == 1)
        #expect(r.card == nil, "the correction emptied the card")
        _ = try await client.correct(cardId: "talk", items: [], text: "shorter please")
        let body2 = try JSONSerialization.jsonObject(with: try #require(PersonalizeStub.seen.last?.httpBody)) as! [String: Any]
        #expect(body2["items"] == nil && body2["text"] as? String == "shorter please")
    }

    /// The server counts `text.length` (UTF-16): 101 emoji are 202 there, so the app cuts at 100.
    @Test func correctionTextIsCappedInUTF16LikeTheServer() async throws {
        #expect(OnboardingClient.correctionText(String(repeating: "😀", count: 101)).utf16.count == 200)
        #expect(OnboardingClient.correctionText(String(repeating: "😀", count: 101)).count == 100)
        #expect(OnboardingClient.correctionText("  hi  ") == "hi")
        PersonalizeStub.handler = { _ in (400, Data()) }
        _ = try? await client.correct(cardId: "talk", items: [], text: String(repeating: "😀", count: 150))
        let body = try JSONSerialization.jsonObject(with: try #require(PersonalizeStub.seen.last?.httpBody)) as! [String: Any]
        #expect((body["text"] as? String)?.utf16.count == 200)
    }

    @Test func cardNotShownIsAServerError() async {
        PersonalizeStub.handler = { _ in (409, Data(#"{"error":"card_not_shown"}"#.utf8)) }
        await #expect(throws: GenitaAuthError.self) { try await client.correct(cardId: "help", items: ["x"], text: nil) }
    }
}

struct PersonalizeProtocolTests {
    @Test func profileEventsDecodeAndRoundTrip() throws {
        let e = try JSONDecoder().decode(ServerEvent.self, from: Data(#"{"type":"profile.updated","text":"Noted: quiet company","fields":["communication"]}"#.utf8))
        #expect(e == .profileUpdated(.init(text: "Noted: quiet company", fields: ["communication"])))
        let a = try JSONDecoder().decode(ServerEvent.self, from: Data(#"{"type":"profile.asking","topic":"How chatty calls should be"}"#.utf8))
        guard case let .profileAsking(p) = a else { Issue.record("profile.asking"); return }
        #expect(p.topic == "How chatty calls should be")
    }

    /// CW-02 (춘식이 11/4): the outfit card's occasion chip copy.
    @Test func outfitOccasionChipCopy() throws {
        func card(_ situation: String?, kind: String = "outfit", why: [String] = []) throws -> FindCard {
            let ev = situation.map { #","evidence":{"style":"camel, clean","situation":"\#($0)"}"# } ?? ""
            let w = "[" + why.map { "\"\($0)\"" }.joined(separator: ",") + "]"
            return try JSONDecoder().decode(FindCard.self, from: Data(#"{"id":"f1","kind":"\#(kind)","createdAt":"t","eyebrow":"From your camera","title":"Wear the trench.","subtitle":"camel, clean","items":[],"steps":[],"options":[],"why":\#(w),"ask":[],"sources":[],"how":[]\#(ev)}"#.utf8))
        }
        #expect(try card("Easy to wear all weekend.").occasionChip?.text == "Easy to wear all weekend", "the server's reason line, as is")
        #expect(try card("Easy to wear all weekend").occasionChip?.accessibilityLabel == "Occasion: Easy to wear all weekend")
        #expect(try card("beige trench for dinner tonight.").occasionChip?.text == "Beige trench for dinner tonight")
        #expect(try card("   ").occasionChip == nil)
        #expect(try card(" . ").occasionChip == nil)
        #expect(try card(nil).occasionChip == nil)
        #expect(try card("Light for a weekend", kind: "product").occasionChip == nil, "product cards keep their own chips")
        // the train's server also appends the reason to `why`: listed once, as the chip
        let both = try card("Easy to wear all weekend.", why: ["Clean camel, totally you.", "Casual blue, less you.", "Easy to wear all weekend."])
        #expect(both.whyLines == ["Clean camel, totally you.", "Casual blue, less you."])
        #expect(try card(nil, why: ["Clean camel."]).whyLines == ["Clean camel."])
        #expect(try card("Easy to layer", kind: "product", why: ["Easy to layer"]).whyLines == ["Easy to layer"])
    }

    @Test func findCardReadsReasonChipsWithTheirSourceAndOlderCardsWithout() throws {
        let card = #"{"id":"f1","kind":"recipe","createdAt":"t","eyebrow":"From your fridge","title":"Egg fried rice","subtitle":"","items":[],"steps":[],"options":[],"why":[],"ask":[],"sources":[],"how":[]"#
        let with = try JSONDecoder().decode(FindCard.self, from: Data((card + #","reasons":[{"text":"Your taste: quick weeknight food","source":"Quick meals.","from":"profile"},{"text":"You said: no cilantro","source":"no cilantro","from":"call"}]}"#).utf8))
        #expect(with.reasons?.map(\.from) == ["profile", "call"])
        #expect(try JSONDecoder().decode(FindCard.self, from: Data((card + "}").utf8)).reasons == nil)
    }
}
