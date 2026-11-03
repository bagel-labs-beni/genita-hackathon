import Foundation
import Testing
@testable import GenitaKit

/// Mirrors `genita-server/src/events/routes.ts` on origin/feat/funnel-events (PR #205).
@Suite(.serialized)
struct AppEventsTests {
    private enum ValueKind { case string, int, bool }

    private let serverSchemas: [String: [String: ValueKind]] = [
        "import.prompt_copied": [:],
        "import.submitted": ["chars": .int],
        "import.cancelled": [:],
        "import.skipped": [:],
        "face.confirmed": ["companionId": .string],
        "voice.previewed": ["voiceId": .string],
        "setup.depth_selected": ["depth": .string],
        "setup.answered": ["step": .int],
        "setup.abandoned": ["step": .int],
        "setup.summary_viewed": [:],
        "setup.summary_cancelled": [:],
        "camera.toggled": ["on": .bool, "facing": .string],
        "screen.share_started": [:],
        "screen.share_stopped": ["seconds": .int],
        "screen.asked": [:],
        "observe.boxes_shown": ["count": .int],
        "find.opened": ["findId": .string],
        "product.links_opened": ["findId": .string, "index": .int],
        "handoff.preparing": ["to": .string],
        "handoff.committed": ["to": .string, "ms": .int],
        "handoff.failed": ["reason": .string],
        "app.reopened": ["gapHours": .int],
    ]

    private func assertValid(_ event: AppEvent, sourceLocation: SourceLocation = #_sourceLocation) {
        guard let expected = serverSchemas[event.name] else {
            Issue.record("unknown app event \(event.name)", sourceLocation: sourceLocation)
            return
        }
        #expect(event.props.keys.sorted() == expected.keys.sorted(), sourceLocation: sourceLocation)
        for (key, kind) in expected {
            guard let value = event.props[key] else {
                Issue.record("missing \(event.name).\(key)", sourceLocation: sourceLocation)
                continue
            }
            switch (kind, value) {
            case (.string, .string), (.int, .int), (.bool, .bool): break
            default: Issue.record("wrong type for \(event.name).\(key)", sourceLocation: sourceLocation)
            }
        }
    }

    @Test func everyAppEventMatchesTheServerAllowlistAndSchema() {
        let events: [AppEvent] = [
            .importPromptCopied,
            .importSubmitted(chars: 42),
            .importCancelled,
            .importSkipped,
            .faceConfirmed(companionId: "companion_1"),
            .voicePreviewed(voiceId: "voice-1"),
            .setupDepthSelected(.quick),
            .setupAnswered(step: 2),
            .setupAbandoned(step: 3),
            .setupSummaryViewed,
            .setupSummaryCancelled,
            .cameraToggled(on: true, facing: .front),
            .screenShareStarted,
            .screenShareStopped(seconds: 12),
            .screenAsked,
            .observeBoxesShown(count: 3),
            .findOpened(findId: "find_1"),
            .productLinksOpened(findId: "find_1", index: 0),
            .handoffPreparing(to: .mac),
            .handoffCommitted(to: .mac, ms: 900),
            .handoffFailed(reason: .offline),
            .appReopened(gapHours: 24),
        ]
        #expect(Set(events.map(\.name)) == Set(serverSchemas.keys))
        for event in events { assertValid(event) }
    }

    @Test func invalidIdsAreDroppedAndIntegersAreClamped() {
        let invalid = AppEvent.findOpened(findId: "a b")
        #expect(invalid.props["findId"] == nil)
        let clamped = AppEvent.handoffCommitted(to: .iphone, ms: 20_000_000)
        #expect(clamped.props["ms"] == .int(10_000_000))
    }

    @Test func clientBatchesTwentyFiveEventsAndUsesBearerJSON() async throws {
        StubURLProtocol.reset(statuses: [204, 204])
        let client = AppEventsClient(baseURL: URL(string: "https://events.example")!, token: { "session-jwt" }, session: stubSession, flushEvery: .seconds(3_600))
        for hour in 0..<25 { await client.log(.appReopened(gapHours: hour)) }
        await client.flush()
        try await waitForRequests(2)

        let requests = StubURLProtocol.requests
        #expect(requests.count == 2)
        #expect(requests.allSatisfy { $0.url?.path == "/v1/events" && $0.value(forHTTPHeaderField: "Authorization") == "Bearer session-jwt" })
        let bodies = try StubURLProtocol.bodies.map { try JSONDecoder().decode(EventBody.self, from: $0) }
        #expect(bodies.map { $0.events.count } == [20, 5])
        #expect(bodies.flatMap(\.events).allSatisfy { $0.name == "app.reopened" })
    }

    @Test func clientDropsOnUnauthorizedAndWithoutAToken() async throws {
        StubURLProtocol.reset(statuses: [401, 204])
        let authorized = AppEventsClient(baseURL: URL(string: "https://events.example")!, token: { "session-jwt" }, session: stubSession, flushEvery: .seconds(3_600))
        await authorized.log(.importCancelled)
        await authorized.flush()
        await authorized.flush()
        try await waitForRequests(1)
        #expect(StubURLProtocol.requests.count == 1)

        StubURLProtocol.reset(statuses: [204])
        let token = TokenBox(nil)
        let anonymous = AppEventsClient(baseURL: URL(string: "https://events.example")!, token: { token.value }, session: stubSession, flushEvery: .seconds(3_600))
        await anonymous.log(.importCancelled)
        await anonymous.flush()
        token.value = "later-token"
        await anonymous.flush()
        #expect(StubURLProtocol.requests.isEmpty)
    }

    @Test func accountSwitchNeverSendsTheOldAccountsEvents() async throws {
        StubURLProtocol.reset(statuses: [204])
        let token = TokenBox("account-a")
        let client = AppEventsClient(baseURL: URL(string: "https://events.example")!, token: { token.value }, session: stubSession, flushEvery: .seconds(3_600))
        await client.log(.findOpened(findId: "find-of-a"))
        token.value = "account-b"
        await client.log(.appReopened(gapHours: 1))
        await client.flush()
        try await waitForRequests(1)
        let requests = StubURLProtocol.requests
        #expect(requests.count == 1)
        #expect(requests.first?.value(forHTTPHeaderField: "Authorization") == "Bearer account-b")
        let body = String(data: StubURLProtocol.bodies.first ?? Data(), encoding: .utf8) ?? ""
        #expect(!body.contains("find-of-a"))
        #expect(body.contains("app.reopened"))
    }

    @Test func clientRetries503ThenDropsAfterThreeFailures() async throws {
        StubURLProtocol.reset(statuses: [503, 204])
        let retrying = AppEventsClient(baseURL: URL(string: "https://events.example")!, token: { "session-jwt" }, session: stubSession, flushEvery: .seconds(3_600))
        await retrying.log(.importCancelled)
        await retrying.flush()
        await retrying.flush()
        try await waitForRequests(2)
        #expect(StubURLProtocol.requests.count == 2)

        StubURLProtocol.reset(statuses: [503, 503, 503, 204])
        let exhausted = AppEventsClient(baseURL: URL(string: "https://events.example")!, token: { "session-jwt" }, session: stubSession, flushEvery: .seconds(3_600))
        await exhausted.log(.importCancelled)
        await exhausted.flush()
        await exhausted.flush()
        await exhausted.flush()
        await exhausted.flush()
        try await waitForRequests(3)
        #expect(StubURLProtocol.requests.count == 3)
    }

    @Test func eventsSampleMatchesTheSameServerSchema() throws {
        let sample = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("protocol-samples/http/events.json")
        let body = try JSONDecoder().decode(EventBody.self, from: Data(contentsOf: sample))
        #expect(body.events.count == 3)
        for event in body.events {
            guard let expected = serverSchemas[event.name] else { Issue.record("unknown \(event.name)"); continue }
            #expect(event.props.keys.sorted() == expected.keys.sorted())
            for (key, kind) in expected {
                guard let value = event.props[key] else { Issue.record("missing \(key)"); continue }
                switch (kind, value) {
                case (.string, .string), (.int, .int), (.bool, .bool): break
                default: Issue.record("wrong sample type for \(event.name).\(key)")
                }
            }
        }
    }
}

private struct EventBody: Decodable {
    let events: [Event]
    struct Event: Decodable {
        let name: String
        let props: [String: AppEventValue]
    }
}

private final class TokenBox: @unchecked Sendable {
    var value: String?
    init(_ value: String?) { self.value = value }
}

private let stubSession: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubURLProtocol.self]
    return URLSession(configuration: configuration)
}()

private func waitForRequests(_ expected: Int) async throws {
    for _ in 0..<100 {
        if StubURLProtocol.requests.count >= expected { return }
        try await Task.sleep(for: .milliseconds(10))
    }
    Issue.record("timed out waiting for \(expected) requests")
}

private final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var responseStatuses: [Int] = []
    private static var recordedRequests: [URLRequest] = []
    private static var recordedBodies: [Data] = []

    static var requests: [URLRequest] {
        lock.lock(); defer { lock.unlock() }
        return recordedRequests
    }

    static var bodies: [Data] {
        lock.lock(); defer { lock.unlock() }
        return recordedBodies
    }

    static func reset(statuses: [Int]) {
        lock.lock(); defer { lock.unlock() }
        responseStatuses = statuses
        recordedRequests = []
        recordedBodies = []
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.recordedRequests.append(request)
        Self.recordedBodies.append(request.httpBody ?? Self.body(from: request.httpBodyStream))
        let status = Self.responseStatuses.isEmpty ? 204 : Self.responseStatuses.removeFirst()
        Self.lock.unlock()
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func body(from stream: InputStream?) -> Data {
        guard let stream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var bytes = [UInt8](repeating: 0, count: 4_096)
        while stream.hasBytesAvailable {
            let count = stream.read(&bytes, maxLength: bytes.count)
            guard count > 0 else { break }
            data.append(bytes, count: count)
        }
        return data
    }
}
