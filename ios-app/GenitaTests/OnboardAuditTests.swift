import XCTest
import UIKit
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

    /// AU-31 · PP-01 step 4: Presence takes at most two chips; a third tap changes nothing, untapping still works.
    func testPresenceChipsStopAtTwo() {
        var on: Set<String> = []
        on = PresenceChips.toggle(on, "witty"); on = PresenceChips.toggle(on, "warm")
        XCTAssertEqual(PresenceChips.toggle(on, "calm"), ["witty", "warm"], "no third chip")
        XCTAssertEqual(PresenceChips.toggle(on, "warm"), ["witty"])
    }

    /// AU-32 · PU-01 step 4: a polished picture already passed (V02-T); "Try again" comes back failing its re-check.
    /// The passing picture stays usable, and the new attempt's reason is one line.
    func testATryAgainThatFailsKeepsThePolishedPictureThatPassed() async throws {
        let failing = Data(#"{"imageId":"p2","sourceImageId":"src","passed":false,"type":"human","reasons":[{"code":"style_changed","label":"The style changed too much"}],"attempt":3,"retriesLeft":0}"#.utf8)
        let (model, _) = makeModel { req in
            (req.url?.path ?? "").hasSuffix("/v1/companion/image/polish") ? (200, failing) : (404, Data())
        }
        model.imageCheck = try JSONDecoder().decode(ImageCheck.self, from: Data(#"{"imageId":"src","passed":false,"polish":true,"reasons":[]}"#.utf8))
        let first = try JSONDecoder().decode(PolishedImage.self, from: Data(#"{"imageId":"p1","sourceImageId":"src","passed":true,"type":"human","reasons":[],"attempt":2,"retriesLeft":1}"#.utf8))
        model.polished = first; model.polishedImage = Data([1, 2, 3]); model.polishRetriesLeft = 1
        model.setup.imageId = "p1"; model.setup.imageType = "human"
        model.retryPolish()
        for _ in 0..<200 where model.polishRetriesLeft != 0 { try await Task.sleep(for: .milliseconds(10)) }
        await model.imageCheckTask?.value
        XCTAssertEqual(model.polished, first, "the passing polished picture stays")
        XCTAssertEqual(model.polishedImage, Data([1, 2, 3]))
        XCTAssertEqual(model.setup.imageId, "p1", "Use this image still makes the companion from it")
        XCTAssertEqual(model.polishRetriesLeft, 0)
        XCTAssertEqual(model.polishError, "The style changed too much")
    }

    /// AU-26 · PU-01 NET: the V03 check fails on the way (offline / 5xx). V02-F offers "Try again" with the same photo
    /// and rights tick; a refusal of the photo itself still means choosing another.
    func testAnImageCheckThatFailedOnTheWayCanBeTriedAgainWithTheSamePhoto() async throws {
        let calls = Box(0)
        let pass = Data(#"{"imageId":"img1","passed":true,"type":"human","reasons":[]}"#.utf8)
        let (model, _) = makeModel { req in
            guard (req.url?.path ?? "").hasSuffix("/v1/companion/image") else { return (404, Data()) }
            calls.value += 1
            return calls.value == 1 ? (503, Data(#"{"error":"unavailable"}"#.utf8)) : (200, pass)
        }
        let photo = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).pngData { ctx in UIColor.gray.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 8, height: 8)) }
        model.setup.imageData = photo; model.rightsAcked = true
        model.go(.image)
        model.checkImage()
        await model.imageCheckTask?.value
        XCTAssertNotNil(model.imageCheckError)
        XCTAssertTrue(model.imageCheckRetryable, "a 503 is not about the photo")
        XCTAssertEqual(model.setup.imageData, photo)
        model.checkImage()   // V02-F "Try again"
        await model.imageCheckTask?.value
        XCTAssertNil(model.imageCheckError)
        XCTAssertEqual(model.setup.imageId, "img1")
        XCTAssertEqual(model.stage, .imageCheck)
        XCTAssertEqual(model.history.filter { $0 == .imageCheck }.count, 0, "checked again in place, no second V03 in Back")
        XCTAssertFalse(AppState.isTransient(GenitaAuthError.server(status: 422, code: "unreadable_image")))
    }

    /// AU-33 · PU-01 small screen: V02's rows and note stay above the button on an iPhone SE (667 pt, safe top 20);
    /// 390 × 844 (safe top 47) keeps the board's layout.
    func testV02ContentClearsTheButtonOnAnSE() {
        XCTAssertEqual(ImageCheckView.resultSqueeze(top: 47 - 44, footerY: 844 - 108), 0)
        let se = ImageCheckView.resultSqueeze(top: 20 - 44, footerY: 667 - 108)
        XCTAssertLessThanOrEqual(704 + (20 - 44) - se, 667 - 108 - 12, "note bottom above the button")
        XCTAssertGreaterThanOrEqual(289 - se, 120)
    }

    /// AU-35 · PP-01 NET/BAD: one failed preview greys V04, and the list comes back by itself once the service answers.
    func testOneFailedPreviewDoesNotGreyTheVoiceListForGood() async throws {
        let voices = Data(#"{"voices":[{"id":"72","name":"Tara"},{"id":"9","name":"Leah"}],"suggested":"72","available":true}"#.utf8)
        let (model, _) = makeModel { req in
            let path = req.url?.path ?? ""
            if path.hasSuffix("/preview") { return (503, Data()) }
            if path.hasSuffix("/v1/companion/voices") { return (200, voices) }
            return (404, Data())
        }
        let player = VoicePlayer()
        player.recoveryInterval = .milliseconds(50)
        await player.load(client: model.onboarding, imageId: "img1", kind: "human")
        XCTAssertTrue(player.available)
        player.preview(player.voices[0], client: model.onboarding)
        for _ in 0..<200 where player.available { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertFalse(player.available, "the failed preview greys the list")
        for _ in 0..<200 where !player.available { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(player.available, "…and it comes back without leaving V04")
    }
}
