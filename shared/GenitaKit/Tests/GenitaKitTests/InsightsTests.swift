import Foundation
import Testing
@testable import GenitaKit

// SUM insight report — against genita-server/PREP_API.md "Insight report" (src/insights/profile.ts shapes).

let insightReportJSON = #"""
{"version":1,"headline":"You want two good options, a laugh, and the final say.",
"observations":[
 {"id":"a1b2c3d4e5","category":"taste","claim":"Clean on the outside, loud on the plate.","evidence":[{"source":"answer","quote":"Minimal","source_label":"You picked"},{"source":"import","quote":"Korean food, the spicier the better.","source_label":"From the reply you pasted","highlight":"the spicier the better"}],"confidence":"high","score":0.9,"surprise":0.9,"use_in_call":"I'll keep outfits minimal and food spicy, never seafood.","chips":[{"label":"Minimal","polarity":"like"},{"label":"Seafood","polarity":"dislike"}],"verdict":null},
 {"id":"f6g7h8i9j0","category":"rhythm","claim":"You do your best thinking late.","evidence":[{"source":"import","quote":"Often works late at night.","source_label":"From the reply you pasted"}],"confidence":"medium","score":0.6,"surprise":0.5,"use_in_call":"I'll keep it short when it's late.","verdict":"right"},
 {"id":"broken"}],
"type":{"name":"The Playful Editor","line":"You pick from good options, keep it light, and keep the final say.","signature":["Options","Light","Final say"],"basis":["a1b2c3d4e5"]},
"mix":[{"id":"options","left":"Options","right":"One answer","position":1,"evidence":{"source":"answer","quote":"Show me options","source_label":"You picked"}}],
"strengths":[{"text":"You know a good option when you see one.","basis":"a1b2c3d4e5"}],
"watchouts":[{"text":"Three options can turn into thirty.","fix":"I'll cap it at two and say my pick.","basis":"a1b2c3d4e5"}],
"chain":{"you_are":"You compare before you commit.","so_you":"So you want choices, not lectures.","so_ill":"So I'll bring two options and my pick."},
"share":{"title":"{name} is The Playful Editor","lines":["Options","Light","Final say"]},
"learning":[{"id":"l-abc123","label":"How long you like answers"}],
"usage":"In our calls: two options, my pick, a joke when it fits, and I ask before I act.",
"settings":{"why":"Think with me","energy":"Warm, Witty","initiative":"Only when asked","never":"No messages or actions without approval"},
"at":"2026-11-04T00:00:00Z","from":"answers","ms":5200}
"""#

final class InsightsStub: URLProtocol, @unchecked Sendable {
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

@Suite(.serialized) struct InsightsClientTests {
    let client: OnboardingClient
    init() {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [InsightsStub.self]
        client = OnboardingClient(auth: GenitaAuthClient(baseURL: URL(string: "https://api.test")!, store: InMemoryTokenStore("tok"), session: URLSession(configuration: cfg)))
        InsightsStub.seen = []
    }

    @Test func reportDecodesAndOneBadTraitDoesNotFailIt() throws {
        let r = try JSONDecoder().decode(InsightReport.self, from: Data(insightReportJSON.utf8))
        #expect(r.observations.map(\.id) == ["a1b2c3d4e5", "f6g7h8i9j0"], "the broken one is dropped")
        let taste = r.observations[0]
        #expect(taste.categoryTitle == "Taste" && taste.chips.last?.dislike == true && taste.evidence[1].highlight == "the spicier the better")
        #expect(taste.useInCall.hasPrefix("I'll") && taste.verdict == nil)
        #expect(r.observations[1].isMedium && r.observations[1].verdict == "right")
        #expect(r.type?.signature == ["Options", "Light", "Final say"] && r.mix.first?.position == 1)
        #expect(r.watchouts.first?.fix == "I'll cap it at two and say my pick." && r.chain?.soIll == "So I'll bring two options and my pick.")
        #expect(r.share?.title(name: "Summer") == "Summer is The Playful Editor")
        #expect(r.settings?.energy == "Warm, Witty" && r.learning.first?.label == "How long you like answers")
        #expect(taste.evidence[1].label(aiName: "ChatGPT") == "From your ChatGPT reply" && taste.evidence[0].label(aiName: "ChatGPT") == "You picked")
        // a report from an older server (r01: no type read) still decodes
        let old = try JSONDecoder().decode(InsightReport.self, from: Data(#"{"headline":"You.","observations":[],"learning":[],"usage":"In our calls."}"#.utf8))
        #expect(old.type == nil && old.mix.isEmpty && old.settings == nil)
    }

    @Test func getAsksTheServerToWaitAndReadsPending() async throws {
        InsightsStub.handler = { _ in (200, Data((#"{"status":"ready","report":"# + insightReportJSON + "}").utf8)) }
        let r = try await client.insights(wait: 6)
        let req = try #require(InsightsStub.seen.last)
        #expect(req.httpMethod == "GET" && req.url?.path == "/v1/profile/insights" && req.url?.query == "wait=6" && req.timeoutInterval >= 18)
        #expect(r.status == .ready && r.report?.observations.count == 2)
        InsightsStub.handler = { _ in (200, Data(#"{"status":"pending","report":null}"#.utf8)) }
        let p = try await client.insights(wait: 30)
        #expect(p.status == .pending && p.report == nil && InsightsStub.seen.last?.url?.query == "wait=8")
    }

    @Test func answersAndVerdictsGoToTheirRoutes() async throws {
        InsightsStub.handler = { _ in (202, Data(#"{"status":"pending"}"#.utf8)) }
        try await client.insightAnswers(["help": "Think with me", "presence": ["Warm"]])
        let post = try #require(InsightsStub.seen.last)
        #expect(post.httpMethod == "POST" && post.url?.path == "/v1/profile/insights")
        let body = try JSONSerialization.jsonObject(with: try #require(post.httpBody)) as! [String: Any]
        #expect((body["answers"] as? [String: Any])?["help"] as? String == "Think with me")

        InsightsStub.handler = { _ in (200, Data(insightReportJSON.utf8)) }
        _ = try await client.insightVerdict(id: "a1b2c3d4e5", verdict: "not_me", correction: "  I just like choices.  ")
        let v = try #require(InsightsStub.seen.last)
        #expect(v.url?.path == "/v1/profile/insights/a1b2c3d4e5/verdict")
        let vb = try JSONSerialization.jsonObject(with: try #require(v.httpBody)) as! [String: Any]
        #expect(vb["verdict"] as? String == "not_me" && vb["correction"] as? String == "I just like choices.")
        _ = try await client.insightVerdict(id: "a1b2c3d4e5", verdict: "right")
        let vb2 = try JSONSerialization.jsonObject(with: try #require(InsightsStub.seen.last?.httpBody)) as! [String: Any]
        #expect(vb2["correction"] == nil)
    }
}
