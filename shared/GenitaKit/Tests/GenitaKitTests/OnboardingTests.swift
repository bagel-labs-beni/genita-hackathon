import Foundation
import Testing
@testable import GenitaKit

private let styleJSON = #"""
{"status":"ready","profile":"How the user wants to be treated:\n- Talk: Warm.","style":{"version":1,"source":"import","partial":true,"toConfirm":["Interests"],
"display":[{"key":"communication","title":"Communication style","items":[{"text":"Warm, direct.","label":"explicit"}]},
{"key":"response","title":"Response preferences","items":[]},
{"key":"help","title":"How Genita can help","items":[{"text":"Find things that fit my style.","label":"observed"}]},
{"key":"interests","title":"Interests","items":[]},{"key":"likes","title":"Likes & dislikes","items":[]},{"key":"boundaries","title":"Boundaries","items":[]}]}}
"""#

/// Its own stub: AuthClientTests' StubProtocol runs in parallel with this suite.
final class OnbStub: URLProtocol, @unchecked Sendable {
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

@Suite(.serialized) struct OnboardingClientTests {
    let store = InMemoryTokenStore("tok")
    let client: OnboardingClient

    init() {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [OnbStub.self]
        client = OnboardingClient(auth: GenitaAuthClient(baseURL: URL(string: "https://api.test")!, store: store, session: URLSession(configuration: cfg)))
        OnbStub.seen = []
    }

    @Test func importShowsSixRowsAndKeepsTheProfile() async throws {
        OnbStub.handler = { _ in (200, Data(styleJSON.utf8)) }
        let s = try await client.importReply("my reply")
        let req = try #require(OnbStub.seen.last)
        #expect(req.url?.path == "/v1/import" && req.httpMethod == "POST" && req.value(forHTTPHeaderField: "authorization") == "Bearer tok")
        #expect(s.rows.map(\.title) == ["Communication style", "Response preferences", "How Genita can help", "Interests", "Likes & dislikes", "Boundaries"])
        #expect(s.partial && s.profile.hasPrefix("How the user"))
        #expect(s.displayText.contains("How Genita can help\n• Find things that fit my style."))
        #expect(s.displayText.contains("Interests\n• Not enough information yet."))
    }

    @Test func resetCompanionPostsAndSurfacesTheDailyLimit() async throws {
        OnbStub.handler = { _ in (200, Data(#"{"ok":true,"removed":true}"#.utf8)) }
        let r = try await client.resetCompanion()
        let req = try #require(OnbStub.seen.last)
        #expect(req.url?.path == "/v1/companion/reset" && req.httpMethod == "POST" && req.value(forHTTPHeaderField: "authorization") == "Bearer tok")
        #expect(r.ok && r.removed)
        OnbStub.handler = { _ in (429, Data(#"{"error":"rate_limited"}"#.utf8)) }
        await #expect(throws: GenitaAuthError.server(status: 429, code: "rate_limited")) { try await client.resetCompanion() }
    }

    @Test func skipSendsNullRepliesWhenUnanswered() async throws {
        OnbStub.handler = { _ in (200, Data(styleJSON.utf8)) }
        _ = try await client.importSkip(interests: ["Food"], replies: nil, avoid: [])
        let body = try JSONSerialization.jsonObject(with: try #require(OnbStub.seen.last?.httpBody)) as! [String: Any]
        #expect(OnbStub.seen.last?.url?.path == "/v1/import/skip")
        #expect(body["replies"] is NSNull && (body["interests"] as? [String]) == ["Food"])
    }

    @Test func imageGoesUpAsJPEGWithTheRightsLine() async throws {
        OnbStub.handler = { _ in (200, Data(#"{"imageId":"img1","passed":false,"type":null,"checks":{"oneFaceFrontFacing":true,"sharpAndLit":false,"noText":true},"reasons":[{"code":"too_blurry","label":"Too blurry to make a face from"}],"headBox":null,"ms":2100}"#.utf8)) }
        let r = try await client.checkImage(jpeg: Data([0xFF, 0xD8, 0xFF]))
        let req = try #require(OnbStub.seen.last)
        #expect(req.url?.path == "/v1/companion/image" && req.url?.query == "rights=1")
        #expect(req.value(forHTTPHeaderField: "content-type") == "image/jpeg" && req.httpBody == Data([0xFF, 0xD8, 0xFF]))
        #expect(!r.passed && r.reasons.first?.label == "Too blurry to make a face from" && r.checks?.sharpAndLit == false)
    }

    /// Photo polish (11/4): the upload says `polish`, the app asks for the polished image and loads its bytes for V02-T.
    @Test func polishedImageIsRequestedThenLoaded() async throws {
        let png = Data([0x89, 0x50, 0x4E, 0x47])
        OnbStub.handler = { req in
            switch (req.httpMethod, req.url?.path) {
            case ("POST", "/v1/companion/image"): return (200, Data(#"{"imageId":"src1","passed":false,"type":"animal","checks":{"oneFaceFrontFacing":false,"sharpAndLit":true,"noText":true},"reasons":[{"code":"side_view","label":"Side view"}],"polish":true,"heads":[]}"#.utf8))
            case ("POST", "/v1/companion/image/polish"): return (200, Data(#"{"imageId":"pol1","sourceImageId":"src1","passed":true,"type":"animal","checks":{"oneFaceFrontFacing":true,"sharpAndLit":true,"noText":true},"reasons":[],"headBox":null,"attempt":1,"retriesLeft":2,"ms":{"polish":11000,"check":3000}}"#.utf8))
            case ("GET", "/v1/companion/image/pol1"): return (200, png)
            default: return (404, Data())
            }
        }
        let check = try await client.checkImage(jpeg: Data([0xFF, 0xD8, 0xFF]))
        #expect(!check.passed && check.polish == true)
        let p = try await client.polishImage(imageId: check.imageId)
        let post = try JSONSerialization.jsonObject(with: try #require(OnbStub.seen.last?.httpBody)) as! [String: Any]
        #expect(post["imageId"] as? String == "src1")
        #expect(p.imageId == "pol1" && p.passed && p.type == "animal" && p.attempt == 1 && p.retriesLeft == 2)
        #expect(try await client.imageBytes(imageId: p.imageId) == png)
        // an older server answer has no `polish`: today's flow
        OnbStub.handler = { _ in (200, Data(#"{"imageId":"img1","passed":true,"type":"human","checks":null,"reasons":[]}"#.utf8)) }
        #expect(try await client.checkImage(jpeg: Data([0xFF, 0xD8, 0xFF])).polish == nil)
    }

    @Test func createUsesTheSuggestedCatalogVoiceThenRenames() async throws {
        OnbStub.handler = { req in
            switch (req.httpMethod, req.url?.path) {
            case ("GET", "/v1/companion/voices"): return (200, Data(#"{"voices":[{"id":"v1"},{"id":"v2"}],"suggested":"v2"}"#.utf8))
            case ("POST", "/v1/companion"): return (201, Data(#"{"id":"c1","name":"Mira","type":"human","voiceId":"v2","prep":{"status":"running","steps":{"scene":{"status":"running"}}}}"#.utf8))
            case ("PATCH", "/v1/companion"): return (200, Data(#"{"id":"c1","name":"Jin"}"#.utf8))
            default: return (404, Data())
            }
        }
        let c = try await client.createCompanion(imageId: "img1")
        #expect(c.prep?.current == .scene)
        let post = try JSONSerialization.jsonObject(with: try #require(OnbStub.seen.last?.httpBody)) as! [String: Any]
        #expect(post["voiceId"] as? String == "v2" && post["name"] == nil)
        let renamed = try await client.renameCompanion("  Jin ")
        #expect(renamed.name == "Jin")
        let patch = try JSONSerialization.jsonObject(with: try #require(OnbStub.seen.last?.httpBody)) as! [String: Any]
        #expect(patch["name"] as? String == "Jin")
    }

    @Test func voiceListPreviewAndSaveGoToTheServer() async throws {
        let wav = Data([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0])
        OnbStub.handler = { req in
            switch (req.httpMethod, req.url?.path) {
            case ("GET", "/v1/companion/voices"):
                return (200, Data(#"{"voices":[{"id":"72","name":"Tara","blurb":"Warm, bright","label":"Tara · warm","previewUrl":"/v1/companion/voices/72/preview"},{"id":"120","name":"Leah","blurb":"Soft, steady"}],"suggested":"72","available":false}"#.utf8))
            case ("GET", "/v1/companion/voices/72/preview"): return (200, wav)
            case ("GET", "/v1/companion/voices/9/preview"): return (503, Data(#"{"error":"voice_unavailable"}"#.utf8))
            case ("PUT", "/v1/companion/voice"): return (200, Data(#"{"id":"c1","name":"Jin","voiceId":"120"}"#.utf8))
            default: return (404, Data())
            }
        }
        let list = try await client.voices(imageId: "img 1")
        #expect(OnbStub.seen.last?.url?.query == "imageId=img%201")
        #expect(list.suggested == "72" && list.available == false && list.voices.map(\.name) == ["Tara", "Leah"] && list.voices[0].label == "Tara · warm")
        #expect(try await client.voicePreview(id: "72") == wav)
        await #expect(throws: GenitaAuthError.server(status: 503, code: "voice_unavailable")) { try await client.voicePreview(id: "9") }
        let saved = try await client.saveVoice("120")
        #expect(saved.voiceId == "120")
        let put = try JSONSerialization.jsonObject(with: try #require(OnbStub.seen.last?.httpBody)) as! [String: Any]
        #expect(OnbStub.seen.last?.httpMethod == "PUT" && put["voiceId"] as? String == "120")
    }

    @Test func consentAndExpiryAreTyped() async {
        OnbStub.handler = { _ in (403, Data(#"{"error":"consent_required"}"#.utf8)) }
        await #expect(throws: GenitaAuthError.consentRequired) { try await client.prep() }
        OnbStub.handler = { _ in (401, Data()) }
        await #expect(throws: GenitaAuthError.unauthorized) { try await client.companion() }
        #expect(store.load() == nil, "a 401 signs out (A02)")
    }
}

struct CompanionNameTests {
    @Test func nm01Rule() {
        #expect(CompanionName.isValid("Jin"))
        #expect(CompanionName.isValid(" Mary-Jo O'Neil "))
        #expect(!CompanionName.isValid(""))
        #expect(!CompanionName.isValid("    "), "NM01-0: whitespace only keeps Continue off")
        #expect(!CompanionName.isValid(String(repeating: "a", count: 21)))
        #expect(CompanionName.isValid(String(repeating: "a", count: 20)))
        #expect(!CompanionName.isValid("1234"), "at least one letter")
        #expect(!CompanionName.isValid("Jin!"))
    }
}

struct PrepProgressTests {
    private func decode(_ s: String) throws -> PrepProgress { try JSONDecoder().decode(PrepProgress.self, from: Data(s.utf8)) }

    @Test func metaOnlyShapeDrivesTheThreeStages() throws {
        let p = try decode(#"{"status":"running","progress":{"done":1,"total":3},"steps":{"scene":{"status":"done"},"face":{"status":"running"},"mouth":{"status":"pending"}}}"#)
        #expect(p.stages == [.scene: .done, .expressions: .running, .mouth: .pending])
        #expect(p.current == .expressions && p.canStartCall && !p.isReady)
    }

    @Test func olderShapeStillReads() throws {
        let p = try decode(#"{"status":"running","steps":{"scene":{"status":"done"},"videos":{"neutral":{"status":"done"},"happy":{"status":"running"}}},"lips":{"status":"pending"}}"#)
        #expect(p.stages == [.scene: .done, .expressions: .running, .mouth: .pending])
    }

    @Test func readyMeansEverythingIsDoneAndNothingStartsBeforeTheScene() throws {
        let ready = try decode(#"{"status":"ready","steps":{}}"#)
        #expect(ready.isReady && ready.current == nil)
        let early = try decode(#"{"status":"running","steps":{"scene":{"status":"running"}}}"#)
        #expect(!early.canStartCall && early.current == .scene)
        #expect(try decode(#"{"status":"failed","steps":{"scene":{"status":"failed"}}}"#).canStartCall, "failed prep: the photo face, the call still goes on")
    }
}

struct SetupAnswersWireTests {
    @Test func appAnswersMapToTheServerKeys() {
        let right = SetupAnswersWire.answers(depth: "right", help: "Be there", relationship: "Trusted partner", presence: ["Calm", "Warm"], sliders: ["challenge": 0, "tempo": 4], never: [])
        #expect(right["help"] as? String == "Be there" && right["challenge"] as? Int == 1 && right["pace"] as? Int == 5)
        #expect(right["reachOut"] == nil && right["never"] == nil)
        let quick = SetupAnswersWire.answers(depth: "quick", help: nil, relationship: nil, presence: ["Calm", "Calm2"], sliders: [:], never: [])
        #expect(Set(quick.keys) == ["help", "relationship", "presence"] && (quick["presence"] as? [String]) == ["Calm"])
        let deep = SetupAnswersWire.answers(depth: "deep", help: "Think with me", relationship: "Close companion", presence: ["Witty"], sliders: ["initiative": 2], never: ["Mirror my mood", "x"])
        #expect(deep["reachOut"] as? Int == 3 && (deep["never"] as? [String]) == ["Mirror my mood"])
    }
}
