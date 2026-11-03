import XCTest
@testable import Genita

/// #315 review P2 (PR #317 follow-up): `/me` says the account has a companion, then the companion restore gets a 401
/// (the session expired in between). The auth client clears the token; the launch must still land on A02 instead of
/// leaving the user on the saved screen with no session.
final class RestoreStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (status, body) = Self.handler?(request) ?? (500, Data())
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor final class LaunchRestoreExpiryTests: XCTestCase {
    private let me = Data(#"{"user":{"id":"u1","provider":"apple","displayName":"Summer","createdAt":"2026-11-04T00:00:00Z"},"consented":true,"hasCompanion":true,"prepStatus":"ready"}"#.utf8)

    private func makeModel(companionStatus: Int) -> (AppState, UserDefaults, InMemoryTokenStore) {
        let storage = UserDefaults(suiteName: UUID().uuidString)!
        let tokens = InMemoryTokenStore("token-a")
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RestoreStub.self]
        let me = self.me
        RestoreStub.handler = { req in
            let path = req.url?.path ?? ""
            if path.hasSuffix("/v1/companion") { return (companionStatus, Data(#"{"error":"unauthorized"}"#.utf8)) }
            if path.hasSuffix("/me") { return (200, me) }
            return (404, Data())
        }
        let model = AppState(storage: storage)
        model.routeAfterSignIn = {}
        model.onboarding = OnboardingClient(auth: GenitaAuthClient(baseURL: URL(string: "https://restore.stub")!, store: tokens, session: URLSession(configuration: config)))
        model.go(.name)
        return (model, storage, tokens)
    }

    func testCompanionRestore401AfterMeSucceededRoutesToSignIn() async {
        let (model, storage, tokens) = makeModel(companionStatus: 401)
        await model.routeOnLaunch()
        XCTAssertNil(tokens.load(), "the 401 cleared the session")
        XCTAssertEqual(model.stage, .signIn, "an expired session lands on A02, not the saved A03")
        XCTAssertTrue(storage.bool(forKey: AppState.signedOutKey), "a restart stays on A02")
    }

    /// 11/4 voice lane (build 7 Appetize: picked Leah, Settings said "Default"): another phone or a reinstall gets the
    /// companion's saved voice back from the server, so Settings names it.
    func testCompanionRestoreBringsBackTheSavedVoice() async {
        let storage = UserDefaults(suiteName: UUID().uuidString)!
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RestoreStub.self]
        let me = self.me
        RestoreStub.handler = { req in
            let path = req.url?.path ?? ""
            if path.hasSuffix("/v1/companion") { return (200, Data(#"{"id":"c1","name":"Lou","type":"human","imageId":"img1","voiceId":"9"}"#.utf8)) }
            if path.hasSuffix("/me") { return (200, me) }
            return (404, Data())
        }
        let model = AppState(storage: storage)
        model.routeAfterSignIn = {}
        model.onboarding = OnboardingClient(auth: GenitaAuthClient(baseURL: URL(string: "https://restore.stub")!, store: InMemoryTokenStore("token-a"), session: URLSession(configuration: config)))
        XCTAssertNil(model.setup.voiceName)
        await model.restoreCompanion()
        XCTAssertEqual(model.setup.voiceId, "9")
        XCTAssertEqual(model.setup.voiceName, "Leah")
        XCTAssertEqual(VoicePlayer.name(forVoiceId: "19"), "Leo")
        XCTAssertNil(VoicePlayer.name(forVoiceId: "nope"))
    }

    func testCompanionRestoreFailingOtherwiseKeepsTheSession() async {
        let (model, storage, tokens) = makeModel(companionStatus: 500)
        await model.routeOnLaunch()
        XCTAssertEqual(tokens.load(), "token-a")
        XCTAssertNotEqual(model.stage, .signIn, "a server error is not an expired session")
        XCTAssertFalse(storage.bool(forKey: AppState.signedOutKey))
    }
}

/// AU-20 (11/4 audit): the N1–N3 send failing (401 / offline / 400) leaves the picks unsent, so the next N3 tap keeps
/// N1/N2 and signing in again carries them; only a saved send marks them sent.
@MainActor final class SkipSendTests: XCTestCase {
    private func model(status: Int) -> AppState {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RestoreStub.self]
        RestoreStub.handler = { req in
            (req.url?.path ?? "").hasSuffix("/v1/import/skip") ? (status, Data(#"{"error":"unauthorized"}"#.utf8)) : (404, Data())
        }
        let m = AppState(storage: UserDefaults(suiteName: UUID().uuidString)!)
        m.routeAfterSignIn = {}
        m.onboarding = OnboardingClient(auth: GenitaAuthClient(baseURL: URL(string: "https://skip.stub")!, store: InMemoryTokenStore("token-a"), session: URLSession(configuration: config)))
        m.setup.skipInterests = ["Food", "Style"]; m.setup.skipReplies = "Show me options"; m.setup.skipSent = false
        return m
    }

    private func finish(_ m: AppState) async throws -> Bool {
        m.finishSkip()
        for _ in 0..<500 where m.importing { try await Task.sleep(for: .milliseconds(10)) }
        return !m.importing
    }

    func testFailedSkipSendLeavesThePicksUnsent() async throws {
        for status in [401, 400] {
            let m = model(status: status)
            m.setup.accountId = "acct-a"
            // one request at a time: the next stub only after this one finished (Codex #516 r1 P2)
            guard try await finish(m) else { return XCTFail("HTTP \(status): the send never finished") }
            XCTAssertEqual(m.setup.skipSent, false, "HTTP \(status): still unsent")
            XCTAssertNil(m.setup.skipOwner, "HTTP \(status): surely not saved")
            XCTAssertEqual(m.setup.skipInterests, ["Food", "Style"], "HTTP \(status): the picks stay")
        }
    }

    /// A 5xx (or no answer): maybe saved at A — the picks stay on this phone for A but never go to account B.
    func testUncertainSkipSendNeverCarriesToAnotherAccount() async throws {
        let m = model(status: 503)
        m.setup.accountId = "acct-a"
        guard try await finish(m) else { return XCTFail("the send never finished") }
        XCTAssertEqual(m.setup.skipSent, false)
        XCTAssertEqual(m.setup.skipOwner, "acct-a")
        XCTAssertEqual(m.setup.skipInterests, ["Food", "Style"], "still here for A")
        m.adopt(accountId: "acct-b")
        XCTAssertNil(m.setup.skipInterests, "never carried to B")
    }
}
