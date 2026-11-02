import Foundation
import Testing
@testable import GenitaKit

// Lane 개인화 (D47 / D48): the "How I see you" story, corrections, the in-call `profile.updated` chip and
// Finds reason chips — against genita-server/PREP_API.md "How I see you + corrections" and PROTOCOL.md (11/3).

/// The seven cards in the server's order (src/personalize/story.ts TITLES / PICKS).
let storyCardsJSON = #"""
[{"id":"opener","title":"How I see you","observation":"You come to me to think out loud and find things that fit you.","promise":"So I'll keep it short, honest and on your side.","evidence":"explicit","later":false,"picks":["That's not why I'm here","Something's missing"]},
{"id":"think","title":"How you think things through","observation":"You like two or three options with one picked for you.","promise":"So I'll always say which one I'd choose.","evidence":"explicit","later":false,"picks":["That's not how I decide","Something's missing"]},
{"id":"talk","title":"How you like to talk","observation":"You want it warm, direct and informal.","promise":"So I'll lead with the answer.","evidence":"observed","later":false,"picks":["Shorter replies","More back-and-forth","Less joking","Something else"]},
{"id":"taste","title":"Your taste","observation":"You lean clean and minimal.","promise":"So I'll pick things with that in mind.","evidence":"explicit","later":false,"picks":["I don't like one of these","My taste changed","Something's missing"],"tags":{"style":["Clean, minimal","Understated colors"],"food":[],"watch":["Design talks"],"dislikes":["Loud logos"]}},
{"id":"help","title":"How I can help","observation":"You want help finding things that fit your style.","promise":"So I'll find them and send the links.","evidence":"observed","later":false,"picks":["Ask me first","Just do it","I don't need this"],"help":[{"label":"Find what fits","mode":"just_do_it"},{"label":"Buy something","mode":"ask_first"}]},
{"id":"lines","title":"Your lines","observation":"I don't know this part of you yet.","promise":"So tell me when it comes up, and I'll remember.","evidence":"suggested","later":true,"picks":["That's fine with me","Something's missing"]},
{"id":"unknowns","title":"Still getting to know you","observation":"There's still a little I don't know about you.","promise":"So I'll ask about one of these on our next call, in passing.","evidence":"suggested","later":false,"picks":["Let me tell you now","Don't ask about these"],"unknowns":["Budget","Food you love"]}]
"""#

private let rowsJSON = #"""
[{"key":"communication","title":"Communication style","items":[{"text":"Warm, direct.","label":"explicit"}]},
{"key":"response","title":"Response preferences","items":[]},
{"key":"help","title":"How Genita can help","items":[]},
{"key":"interests","title":"Interests","items":[]},
{"key":"likes","title":"Likes & dislikes","items":[{"text":"No cilantro.","label":"explicit"}]},
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

    @Test func importCarriesTheSevenStoryCardsInOrder() async throws {
        PersonalizeStub.handler = { _ in (200, Data(importJSON(story: storyCardsJSON).utf8)) }
        let s = try await client.importReply("my reply")
        let story = try #require(s.story)
        #expect(story.map(\.id) == ["opener", "think", "talk", "taste", "help", "lines", "unknowns"])
        let taste = try #require(story.first { $0.id == "taste" })
        #expect(taste.tags?.style == ["Clean, minimal", "Understated colors"] && taste.tags?.dislikes == ["Loud logos"] && taste.tags?.food == [])
        #expect(taste.evidenceLabel == "You said so")
        let help = try #require(story.first { $0.id == "help" })
        #expect(help.help?.map(\.mode) == [.justDoIt, .askFirst])
        #expect(help.help?.first?.badge == "Just do it" && help.help?.last?.badge == "Ask first")
        #expect(story.first { $0.id == "lines" }?.later == true)
        #expect(story.last?.unknowns == ["Budget", "Food you love"])
        #expect(story.first?.picks == ["That's not why I'm here", "Something's missing"])
        #expect(s.rows.count == 6, "the six I04 rows are still stored")
    }

    @Test func importWithoutAStoryOrWithABrokenOneStillLands() async throws {
        PersonalizeStub.handler = { _ in (200, Data(importJSON(story: "null").utf8)) }
        #expect(try await client.importReply("x").story == nil, "story null: read it later with GET /v1/profile/story")
        PersonalizeStub.handler = { _ in (200, Data(importJSON(story: #"[{"id":7}]"#).utf8)) }
        let s = try await client.importReply("x")
        #expect(s.story == nil && s.rows.count == 6, "a story the app can't read never fails the import")
    }

    @Test func storyAsksTheServerToWait() async throws {
        PersonalizeStub.handler = { _ in (200, Data((#"{"status":"ready","source":"skip","cards":"# + storyCardsJSON + "}").utf8)) }
        let r = try await client.story(wait: 8)
        let req = try #require(PersonalizeStub.seen.last)
        #expect(req.httpMethod == "GET" && req.url?.path == "/v1/profile/story" && req.url?.query == "wait=8")
        #expect(req.timeoutInterval >= 18, "the server holds the answer up to `wait` seconds")
        #expect(r.status == .ready && r.source == "skip" && r.cards.count == 7)
        PersonalizeStub.handler = { _ in (200, Data(#"{"status":"processing","source":"import","cards":[]}"#.utf8)) }
        #expect(try await client.story(wait: 8).status == .processing)
    }

    @Test func correctionSendsTheCardThePickAndTheTextAndReturnsTheNewCardAndRows() async throws {
        let card = #"{"id":"taste","title":"Your taste","observation":"You lean clean and minimal. No cilantro.","promise":"So I'll leave it out.","evidence":"explicit","later":false,"picks":["I don't like one of these","My taste changed","Something's missing"],"tags":{"style":["Clean, minimal"],"food":[],"watch":[],"dislikes":["Cilantro"]}}"#
        PersonalizeStub.handler = { _ in (200, Data((#"{"card":"# + card + #","ack":"Got it. I'll remember that.","changed":true,"profile":"- Likes: no cilantro","rows":"# + rowsJSON + "}").utf8)) }
        let long = "  " + String(repeating: "a", count: 230) + "  "
        let r = try await client.correct(cardId: "taste", pick: "I don't like one of these", text: long)
        let req = try #require(PersonalizeStub.seen.last)
        #expect(req.httpMethod == "PATCH" && req.url?.path == "/v1/profile")
        let body = try JSONSerialization.jsonObject(with: try #require(req.httpBody)) as! [String: Any]
        #expect(body["cardId"] as? String == "taste" && body["pick"] as? String == "I don't like one of these")
        #expect((body["text"] as? String)?.count == 200, "text is trimmed and capped at 200 characters")
        #expect(r.card.tags?.dislikes == ["Cilantro"] && r.ack == "Got it. I'll remember that." && r.changed)
        #expect(r.rows.first { $0.key == "likes" }?.items.first?.text == "No cilantro." && r.profile.contains("cilantro"))
    }

    @Test func correctionLeavesOutAnEmptyPickOrText() async throws {
        PersonalizeStub.handler = { _ in (200, Data((#"{"card":"# + #"{"id":"unknowns","title":"Still getting to know you","observation":"I think I've got the basics now.","promise":"So I'll keep listening and update as we go.","evidence":"suggested","later":false,"picks":[],"unknowns":[]}"# + #","ack":"Got it. I'll remember that.","changed":true,"profile":"","rows":"# + rowsJSON + "}").utf8)) }
        _ = try await client.correct(cardId: "unknowns", pick: "Don't ask about these", text: "   ")
        let body = try JSONSerialization.jsonObject(with: try #require(PersonalizeStub.seen.last?.httpBody)) as! [String: Any]
        #expect(body["text"] == nil && body["pick"] as? String == "Don't ask about these")
        _ = try await client.correct(cardId: "talk", pick: nil, text: "shorter please")
        let body2 = try JSONSerialization.jsonObject(with: try #require(PersonalizeStub.seen.last?.httpBody)) as! [String: Any]
        #expect(body2["pick"] == nil && body2["text"] as? String == "shorter please")
    }

    @Test func badCorrectionIsAServerError() async {
        PersonalizeStub.handler = { _ in (400, Data(#"{"error":"bad_correction"}"#.utf8)) }
        await #expect(throws: GenitaAuthError.self) { try await client.correct(cardId: "talk", pick: "Nope", text: nil) }
    }
}

struct PersonalizeProtocolTests {
    @Test func profileUpdatedDecodesAndRoundTrips() throws {
        let e = try JSONDecoder().decode(ServerEvent.self, from: Data(#"{"type":"profile.updated","text":"Updated: no cilantro","fields":["likes"]}"#.utf8))
        #expect(e == .profileUpdated(.init(text: "Updated: no cilantro", fields: ["likes"])))
        #expect(e.type == "profile.updated")
        let again = try JSONDecoder().decode(ServerEvent.self, from: try JSONEncoder().encode(e))
        #expect(again == e)
    }

    @Test func findCardReadsReasonChipsAndOlderCardsWithout() throws {
        let card = #"{"id":"f1","kind":"recipe","createdAt":"t","eyebrow":"From your fridge","title":"Egg fried rice","subtitle":"","items":[],"steps":[],"options":[],"why":[],"ask":[],"sources":[],"how":[]"#
        let with = try JSONDecoder().decode(FindCard.self, from: Data((card + #","reasons":[{"text":"You said: no cilantro","source":"No cilantro."}]}"#).utf8))
        #expect(with.reasons == [.init(text: "You said: no cilantro", source: "No cilantro.")])
        #expect(try JSONDecoder().decode(FindCard.self, from: Data((card + "}").utf8)).reasons == nil)
    }
}
