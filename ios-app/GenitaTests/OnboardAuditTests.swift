import XCTest
@testable import Genita

/// Audit 11/4 (onboard lane): routing right after CS01 and a name that never reached the server.
/// The server is a URLProtocol stub (RestoreStub, LaunchRestoreExpiryTests).
@MainActor final class OnboardAuditTests: XCTestCase {
    private func me(name: String?, hasCompanion: Bool, consented: Bool = true) -> Data {
        let display = name.map { "\"\($0)\"" } ?? "null"
        return Data(#"{"user":{"id":"u1","provider":"dev","displayName":\#(display),"createdAt":"2026-11-04T00:00:00Z"},"consented":\#(consented),"hasCompanion":\#(hasCompanion),"prepStatus":"ready"}"#.utf8)
    }
    private let companion = Data(#"{"id":"c1","name":"Jin","type":"human","demo":true,"prep":{"status":"ready","steps":{}}}"#.utf8)

    private func makeModel(handler: @escaping (URLRequest) -> (Int, Data)) -> (AppState, UserDefaults) {
        let storage = UserDefaults(suiteName: UUID().uuidString)!
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RestoreStub.self]
        RestoreStub.handler = handler
        let model = AppState(storage: storage, imageURL: URL.temporaryDirectory.appending(path: UUID().uuidString + ".jpg"))
        model.routeAfterSignIn = {}
        model.onboarding = OnboardingClient(auth: GenitaAuthClient(baseURL: URL(string: "https://onboard.stub")!, store: InMemoryTokenStore("token-a"),
                                                                   session: URLSession(configuration: config)))
        return (model, storage)
    }

    /// AU-03 · JG-01: a judge agrees on CS01; /me (and the ready-made companion) is still on its way. No empty A03
    /// meanwhile, and the judge lands in the demo call.
    func testJudgeAgreeingOnCS01NeverShowsAnEmptyA03() async throws {
        let gate = DispatchSemaphore(value: 0)
        let meAsked = Box(false)
        let me = me(name: "Judge", hasCompanion: true), companion = companion
        let (model, _) = makeModel { req in
            let path = req.url?.path ?? ""
            if path.hasSuffix("/me") { meAsked.value = true; gate.wait(); return (200, me) }
            if path.hasSuffix("/v1/companion") { return (200, companion) }
            return (404, Data())
        }
        model.signedIn(userId: "u1", consented: false)
        XCTAssertEqual(model.stage, .consent)
        let agreed = Task { await model.consentAgreed() }
        for _ in 0..<200 where !meAsked.value { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(meAsked.value)
        XCTAssertNotEqual(model.stage, .name, "no empty 'What's your name?' while /me is on its way")
        gate.signal()
        await agreed.value
        XCTAssertEqual(model.stage, .conversation, "the judge goes straight to the demo call")
        XCTAssertEqual(model.setup.name, "Judge")
    }

    /// AU-03: a new (non-judge) account still confirms its name on A03 after CS01, and offline still moves on.
    func testNewAccountStillGetsA03AfterCS01() async {
        let me = me(name: nil, hasCompanion: false)
        let (model, _) = makeModel { req in (req.url?.path ?? "").hasSuffix("/me") ? (200, me) : (404, Data()) }
        model.signedIn(userId: "u1", consented: false)
        await model.consentAgreed()
        XCTAssertEqual(model.stage, .name)

        let (offline, _) = makeModel { _ in (503, Data()) }
        offline.signedIn(userId: "u1", consented: false)
        await offline.consentAgreed()
        XCTAssertEqual(offline.stage, .name, "no /me answer: CS01 never leaves the user stuck")
    }

    /// AU-05 · LG-03: A03's name never reached the server (offline at Next). The finished account reopens into
    /// its call (S07 → S09), not A03, and the name is sent again.
    func testANameThatNeverReachedTheServerDoesNotBounceAFinishedAccountToA03() async {
        let me = me(name: nil, hasCompanion: true), companion = companion
        let patched = Box<String?>(nil)
        let (model, storage) = makeModel { req in
            let path = req.url?.path ?? ""
            if path.hasSuffix("/me") && req.httpMethod == "PATCH" {
                patched.value = req.httpBody.flatMap { String(data: $0, encoding: .utf8) } ?? req.httpBodyStream.map { s in
                    s.open(); defer { s.close() }
                    var d = Data(); var buf = [UInt8](repeating: 0, count: 1024)
                    while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; d.append(buf, count: n) }
                    return String(data: d, encoding: .utf8) ?? ""
                }
                return (200, Data(#"{"user":{"id":"u1","provider":"apple","displayName":"Summer","createdAt":"2026-11-04T00:00:00Z"},"consented":true,"hasCompanion":true,"prepStatus":"ready"}"#.utf8))
            }
            if path.hasSuffix("/me") { return (200, me) }
            if path.hasSuffix("/v1/companion") { return (200, companion) }
            return (404, Data())
        }
        storage.set("u1", forKey: AppState.userKey)
        model.setup.name = "Summer"
        model.setup.companionName = "Jin"
        model.complete()
        await model.routeOnLaunch()
        XCTAssertEqual(model.stage, .conversation, "a finished account goes to its call, not A03")
        XCTAssertTrue(patched.value?.contains("Summer") == true, "the saved name goes to the server again")
    }

    /// AU-06 · SE-03 M02-X: after a deletion A02 carries the "deleted" notice once, and nothing of the account stays.
    func testAccountDeletedLandsOnA02WithTheNoticeAndNoLocalSetup() {
        let storage = UserDefaults(suiteName: UUID().uuidString)!
        let model = AppState(storage: storage, imageURL: URL.temporaryDirectory.appending(path: UUID().uuidString + ".jpg"))
        model.setup.name = "Summer"; model.setup.companionName = "Jin"; model.complete()
        model.accountDeleted()
        XCTAssertEqual(model.stage, .signIn)
        XCTAssertTrue(model.accountDeletedNotice, "M02-X: A02 + toast")
        XCTAssertEqual(model.setup.name, "")
        XCTAssertNil(model.setup.companionName)
        model.signedIn(userId: "u2", consented: false)
        XCTAssertFalse(model.accountDeletedNotice, "a new sign-in never shows it")
    }
}
