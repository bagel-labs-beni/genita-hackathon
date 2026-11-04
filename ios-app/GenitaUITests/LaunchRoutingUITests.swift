import XCTest

/// LG-03 (TF 331 P1): a signed-in launch whose saved screen is A01/A02 (storage reset, a saved session) must never
/// show A01 or A02 while `/me` decides; it holds the dark launch ground, then goes to S07 → S09. Against the
/// onboarding stub (127.0.0.1:8790) with a 2 s `/me`, so the window the flash lived in is wide open.
final class LaunchRoutingUITests: XCTestCase {
    private let stub = "http://127.0.0.1:8790"
    @discardableResult
    private func stubCall(_ method: String, _ path: String, json: String? = nil) -> [String: Any]? {
        var req = URLRequest(url: URL(string: stub + path)!)
        req.httpMethod = method
        if let json { req.setValue("application/json", forHTTPHeaderField: "content-type"); req.httpBody = Data(json.utf8) }
        var out: [String: Any]?
        let done = expectation(description: path)
        URLSession.shared.dataTask(with: req) { data, _, _ in
            out = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10)
        return out
    }

    func testSignedInLaunchNeverShowsA01OrA02() throws {
        stubCall("POST", "/__reset")
        guard stubCall("POST", "/__companion", json: #"{"name":"Jin","faceMs":1}"#) != nil else {
            throw XCTSkip("onboarding stub not running on 127.0.0.1:8790")
        }
        stubCall("POST", "/__meDelay", json: #"{"ms":2000}"#)
        defer { stubCall("POST", "/__meDelay", json: #"{"ms":0}"#) }
        let app = XCUIApplication()
        // --uitesting starts with clean storage (saved screen A01) and --stub-signin brings a saved session
        app.launchArguments = ["--uitesting", "--stub-signin"]
        app.launchEnvironment = ["GENITA_API_URL": stub, "GENITA_SERVER_URL": "ws://127.0.0.1:9/v1/session", "GENITA_REVIEW_STILL": "1"]
        app.launch()
        let entry = ["getStarted", "continueWithEmail", "signingIn", "judgeAccessLink"]
        let call = app.descendants(matching: .any).matching(NSPredicate(format: "identifier IN %@", ["openMenu", "openMenuConnecting", "micToggle"])).firstMatch
        var heldSeen = false, flashed: String?
        let end = Date().addingTimeInterval(25)
        while Date() < end, !call.exists {
            if app.descendants(matching: .any)["launchRouting"].exists { heldSeen = true }
            if let hit = entry.first(where: { app.descendants(matching: .any)[$0].exists }) { flashed = hit; break }
            Thread.sleep(forTimeInterval: 0.05)
        }
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "auth-LG03-signed-in-launch"; shot.lifetime = .keepAlways; add(shot)
        XCTAssertNil(flashed, "a signed-in launch showed A01/A02 (\(flashed ?? "")) before routing")
        XCTAssertTrue(call.exists, "the signed-in launch reaches S07/S09")
        XCTAssertTrue(heldSeen, "the launch ground held while /me answered")
    }
}
