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

    func testCompanionRestoreFailingOtherwiseKeepsTheSession() async {
        let (model, storage, tokens) = makeModel(companionStatus: 500)
        await model.routeOnLaunch()
        XCTAssertEqual(tokens.load(), "token-a")
        XCTAssertNotEqual(model.stage, .signIn, "a server error is not an expired session")
        XCTAssertFalse(storage.bool(forKey: AppState.signedOutKey))
    }
}

/// AU-92 fail closed (lead 11/4): "Forget all of this" clears the phone's copy first; a server failure says so and
/// keeps a retry queued, never bringing the copy back.
@MainActor final class ForgetProfileTests: XCTestCase {
    private func model(status: Int) -> AppState {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RestoreStub.self]
        RestoreStub.handler = { req in
            (req.url?.path ?? "").hasSuffix("/v1/profile") ? (status, Data(status == 200 ? #"{"ok":true}"#.utf8 : #"{"error":"x"}"#.utf8)) : (404, Data())
        }
        let m = AppState(storage: UserDefaults(suiteName: UUID().uuidString)!)
        m.routeAfterSignIn = {}
        m.onboarding = OnboardingClient(auth: GenitaAuthClient(baseURL: URL(string: "https://forget.stub")!, store: InMemoryTokenStore("token-a"), session: URLSession(configuration: config)))
        m.setup.styleProfile = "How the user wants to be treated"; m.setup.styleRows = []; m.setup.response = "pasted"
        m.setup.companionName = "Jin"
        return m
    }

    func testServerFailureKeepsTheCopyClearedAndARetryQueued() async {
        let m = model(status: 503)
        let line = await m.forgetProfile()
        XCTAssertEqual(line, "Couldn’t finish forgetting — try again.")
        XCTAssertNil(m.setup.styleProfile); XCTAssertNil(m.setup.styleRows); XCTAssertEqual(m.setup.response, "")
        XCTAssertEqual(m.setup.forgetPending, true, "a retry stays queued")
        XCTAssertEqual(m.setup.companionName, "Jin", "the companion stays")
    }

    func testSuccessClearsTheQueue() async {
        let m = model(status: 200)
        let line = await m.forgetProfile()
        XCTAssertNil(line)
        XCTAssertNil(m.setup.forgetPending)
        XCTAssertNil(m.setup.styleProfile)
    }
}
