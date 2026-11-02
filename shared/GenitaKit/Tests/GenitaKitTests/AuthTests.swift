import Foundation
import Testing
@testable import GenitaKit

private func sample(_ name: String) throws -> Data {
    let dir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("protocol-samples/http")
    return try Data(contentsOf: dir.appendingPathComponent(name))
}

private func me(consented: Bool = true, name: String? = "Chel", companion: Bool = true, prep: GenitaMe.PrepStatus = .ready, active: String? = nil) -> GenitaMe {
    GenitaMe(user: .init(id: "u", provider: "apple", email: nil, displayName: name, aiConsentAt: consented ? "t" : nil, createdAt: "t"),
             consented: consented, hasCompanion: companion, prepStatus: companion ? prep : .none,
             conversation: active.map { .init(activeDevice: $0, epoch: 1) })
}

/// F1-L7: every start branch for both devices.
struct StartRouterTests {
    @Test func iphoneBranches() {
        let r = { StartRouter.route($0, device: .iphone) }
        #expect(r(.signedOut) == .splash)            // A01 → A02
        #expect(r(.expired) == .signIn)              // token expired → A02
        #expect(r(.offline) == .offline)             // A02-E
        #expect(r(.active(me(consented: false))) == .consent)                     // CS01
        #expect(r(.active(me(name: nil))) == .name)                               // A03
        #expect(r(.active(me(name: "   "))) == .name)
        #expect(r(.active(me(companion: false))) == .importPrompt)                // I01
        #expect(r(.active(me(prep: .running))) == .textWhilePreparing)            // S08
        #expect(r(.active(me(prep: .ready))) == .connecting)                      // S07 → S09
        #expect(r(.active(me(prep: .failed))) == .connecting, "failed prep: photo face, call still goes on")
    }

    @Test func macBranches() {
        let r = { StartRouter.route($0, device: .mac) }
        #expect(r(.signedOut) == .signIn)            // MAC-1
        #expect(r(.expired) == .signIn)
        #expect(r(.offline) == .offline)
        #expect(r(.active(me(companion: false))) == .macNoCompanion)              // MAC-2
        #expect(r(.active(me(consented: false, companion: false))) == .macNoCompanion)
        #expect(r(.active(me(active: "iphone"))) == .macConversationOnPhone)      // MAC-3
        #expect(r(.active(me(active: "mac"))) == .macConversationHere)            // MAC-4
        #expect(r(.active(me())) == .connecting)                                  // S09
        #expect(r(.active(me(name: nil))) == .connecting, "no name step on Mac")
    }
}

struct AuthWireTests {
    @Test func samplesDecode() throws {
        let m = try JSONDecoder().decode(GenitaMe.self, from: sample("me.json"))
        #expect(m.prepStatus == .running && m.conversation?.activeDevice == "iphone" && m.conversation?.epoch == 3)
        let s = try JSONDecoder().decode(GenitaSignInResponse.self, from: sample("signin.json"))
        #expect(s.isNew && !s.me.consented && s.me.user.displayName == nil && s.me.conversation == nil)
    }

    @Test func secretsMatchTheServerDigests() {
        let s = AuthSecret(raw: "abc")
        #expect(s.sha256Hex == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        #expect(s.sha256Base64URL == "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0")
        #expect(AuthSecret().raw.count == 43)
        #expect(AuthSecret().raw != AuthSecret().raw)
    }

    @Test func callbackParsing() {
        #expect(AuthCallback.parse(URL(string: "genita://auth?code=abc")!) == .code("abc"))
        #expect(AuthCallback.parse(URL(string: "genita://auth?error=cancelled")!) == .error("cancelled"))
        #expect(AuthCallback.parse(URL(string: "genita://other?code=abc")!) == nil)
        #expect(AuthCallback.parse(URL(string: "https://auth?code=abc")!) == nil)
    }

    @Test func macStartURL() {
        let c = GenitaAuthClient(baseURL: URL(string: "https://genita-api.thebeni.ai")!, store: InMemoryTokenStore())
        #expect(c.macStartURL(challenge: "x").absoluteString == "https://genita-api.thebeni.ai/auth/apple/start?challenge=x&device=mac")
    }
}

// MARK: client against a stubbed server

final class StubProtocol: URLProtocol, @unchecked Sendable {
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

@Suite(.serialized) struct AuthClientTests {
    let store = InMemoryTokenStore()
    let client: GenitaAuthClient

    init() {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubProtocol.self]
        client = GenitaAuthClient(baseURL: URL(string: "https://api.test")!, store: store, session: URLSession(configuration: cfg))
        StubProtocol.seen = []
    }

    @Test func signInStoresTheTokenAndSendsTheRawNonce() async throws {
        StubProtocol.handler = { _ in (200, try! sample("signin.json")) }
        let r = try await client.signInWithApple(identityToken: "id.tok.en", rawNonce: "raw", authorizationCode: "code", givenName: "Chelsea", familyName: nil)
        #expect(r.isNew)
        #expect(store.load() == r.token)
        let req = try #require(StubProtocol.seen.last)
        #expect(req.url?.path == "/auth/apple" && req.httpMethod == "POST")
        let body = try JSONSerialization.jsonObject(with: req.httpBody ?? Data()) as! [String: Any]
        #expect(body["nonce"] as? String == "raw" && body["authorizationCode"] as? String == "code" && body["device"] as? String == "iphone")
        #expect((body["fullName"] as? [String: String]) == ["givenName": "Chelsea"])
    }

    @Test func unauthorizedClearsTheTokenAndRoutesToSignIn() async {
        store.save("old")
        StubProtocol.handler = { _ in (401, Data(#"{"error":"unauthorized"}"#.utf8)) }
        let state = await client.sessionState()
        #expect(state == .expired)
        #expect(store.load() == nil)
        #expect(StubProtocol.seen.last?.value(forHTTPHeaderField: "authorization") == "Bearer old")
        #expect(StartRouter.route(state, device: .iphone) == .signIn)
    }

    @Test func noTokenIsSignedOutWithoutANetworkCall() async {
        #expect(await client.sessionState() == .signedOut)
        #expect(StubProtocol.seen.isEmpty)
    }

    @Test func consentRequiredAndServerErrorsAreTyped() async {
        store.save("t")
        StubProtocol.handler = { _ in (403, Data(#"{"error":"consent_required"}"#.utf8)) }
        await #expect(throws: GenitaAuthError.consentRequired) { try await client.me() }
        StubProtocol.handler = { _ in (400, Data(#"{"error":"name_required"}"#.utf8)) }
        await #expect(throws: GenitaAuthError.server(status: 400, code: "name_required")) { try await client.setName(" ") }
        #expect(store.load() == "t", "non-401 errors keep the session")
    }

    @Test func activeSessionRoutes() async throws {
        store.save("t")
        StubProtocol.handler = { _ in (200, try! sample("me.json")) }
        let state = await client.sessionState()
        #expect(StartRouter.route(state, device: .iphone) == .textWhilePreparing)
        #expect(StartRouter.route(state, device: .mac) == .macConversationOnPhone)
    }

    @Test func logoutAndDeleteClearTheToken() async throws {
        store.save("t")
        StubProtocol.handler = { _ in (500, Data()) }
        await client.logout()
        #expect(store.load() == nil, "logout clears locally even if the server fails")
        store.save("t")
        StubProtocol.handler = { _ in (200, Data(#"{"deleted":true,"appleRevoked":true,"blobsDeleted":2}"#.utf8)) }
        let r = try await client.deleteAccount()
        #expect(r == GenitaDeleteResult(deleted: true, appleRevoked: true, blobsDeleted: 2))
        #expect(store.load() == nil)
        #expect(StubProtocol.seen.last?.httpMethod == "DELETE")
    }
}
