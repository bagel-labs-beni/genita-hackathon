import Foundation
import Testing
@testable import GenitaKit

/// Server-driven app config (GET /v1/app-config): decode the shared sample, tolerate drift, update nudges.
struct AppConfigTests {
    private func sample() throws -> Data {
        let dir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try Data(contentsOf: dir.appendingPathComponent("protocol-samples/http/app-config.json"))
    }

    @Test func testSampleDecodes() throws {
        let c = try JSONDecoder().decode(GenitaAppConfig.self, from: try sample())
        #expect(c.updates.ios.url.absoluteString == "https://testflight.apple.com/join/Ybqh482p")
        #expect(c.updates.ios.latestBuild == 4121)
        #expect(c.flag("textChat", default: true) == false)
        #expect(c.number("bargeInMs", default: 0) == 400)
        #expect(c.text("prep.title", name: "Jin") == "Bringing Jin to life")
        #expect(c.text("prep.stage.mouth", name: "Jin") == "Mouth")
    }

    @Test func testBundledDefaultsMatchTheServerDefaults() throws {
        let server = try JSONDecoder().decode(GenitaAppConfig.self, from: try sample())
        let bundled = GenitaAppConfig.bundled
        #expect(bundled.flags == server.flags)
        #expect(bundled.copy == server.copy)
        #expect(bundled.tuning == server.tuning)
        #expect(bundled.updates.ios.url == server.updates.ios.url)
        #expect(bundled.updates.mac.url == server.updates.mac.url)
    }

    @Test func testMissingAndWrongFieldsFallBackToBundled() throws {
        let json = #"{"schema":1,"flags":{"textChat":true,"x":"nope"},"tuning":{"prepStallMs":"slow"},"copy":{"prep.title":"Hi {name}"},"assets":{"splash":"https://cdn.example/s.riv","bad":"not a url"},"future":{"a":1}}"#
        let c = try JSONDecoder().decode(GenitaAppConfig.self, from: Data(json.utf8))
        #expect(c.flag("textChat", default: false) == true)
        #expect(c.flag("watchReactions", default: false) == true, "missing key keeps the bundled value")
        #expect(c.number("prepStallMs", default: 0) == 45_000, "wrong type keeps the bundled value")
        #expect(c.text("prep.title", name: "Jin") == "Hi Jin")
        #expect(c.text("call.thinking", name: "Jin") == "Jin is thinking")
        #expect(c.updates == GenitaAppConfig.bundled.updates)
        #expect(c.assets["splash"]?.absoluteString == "https://cdn.example/s.riv")
        #expect(c.assets["bad"] == nil)
    }

    @Test func testNonHttpsAssetsAreDropped() throws {
        let json = #"{"assets":{"a":"http://cdn.example/a.riv","b":"file:///etc/passwd"}}"#
        let c = try JSONDecoder().decode(GenitaAppConfig.self, from: Data(json.utf8))
        #expect(c.assets.isEmpty)
    }

    @Test func testUpdateNudge() {
        let url = URL(string: "https://testflight.apple.com/join/Ybqh482p")!
        let ch = GenitaAppConfig.Channel(minBuild: 100, latestBuild: 120, url: url)
        #expect(ch.nudge(installedBuild: 120) == .none)
        #expect(ch.nudge(installedBuild: 130) == .none)
        #expect(ch.nudge(installedBuild: 110) == .available(latestBuild: 120, url: url))
        #expect(ch.nudge(installedBuild: 99) == .required(latestBuild: 120, url: url))
        #expect(GenitaAppConfig.Channel(minBuild: 0, latestBuild: 0, url: url).nudge(installedBuild: 1) == .none, "0 = not set")
        #expect(ch.nudge(installedBuild: nil) == .none, "unknown build never nags")
    }

    @MainActor @Test func testStoreUsesETagAndKeepsConfigOn304() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("appcfg-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        final class Script: @unchecked Sendable {
            var seen: [String?] = []
            var replies: [(Int, String?, Data)] = [
                (200, "\"v1\"", Data(#"{"flags":{"textChat":true}}"#.utf8)),
                (304, "\"v1\"", Data()),
                (500, nil, Data()),
            ]
        }
        let script = Script()
        let store = GenitaAppConfigStore(cacheURL: dir.appendingPathComponent("app-config.json")) { req in
            script.seen.append(req.value(forHTTPHeaderField: "If-None-Match"))
            let (status, etag, body) = script.replies.removeFirst()
            var headers: [String: String] = [:]
            if let etag { headers["ETag"] = etag }
            return (body, HTTPURLResponse(url: req.url!, statusCode: status, httpVersion: nil, headerFields: headers)!)
        }
        #expect(store.config.flag("textChat", default: true) == false, "starts on bundled defaults")
        await store.refresh(force: true)
        #expect(store.config.flag("textChat", default: false) == true)
        await store.refresh(force: true)
        #expect(store.config.flag("textChat", default: false) == true, "304 keeps the config")
        await store.refresh(force: true)
        #expect(store.config.flag("textChat", default: false) == true, "a server error keeps the config")
        #expect(script.seen == [nil, "\"v1\"", "\"v1\""])

        // a new launch reads the cache first (offline-safe)
        let again = GenitaAppConfigStore(cacheURL: dir.appendingPathComponent("app-config.json")) { _ in throw URLError(.notConnectedToInternet) }
        #expect(again.config.flag("textChat", default: false) == true)
    }
}
