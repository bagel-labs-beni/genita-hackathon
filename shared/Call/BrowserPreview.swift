#if DEBUG
import Foundation

/// Browser preview (Appetize): the app on a simulator streamed to a browser, with no server, camera, mic or Apple login.
///
/// Debug-compiled only (the TestFlight / App Store build is Release without DEBUG, so none of this exists there), and
/// even in a build that has it, nothing changes unless the app is launched with `--browser-preview` (Appetize's
/// `launchArgs=["--browser-preview"]`). It reuses the UI-test stubs: GENITA_FIXTURE_SCRIPT (fixture mic),
/// GENITA_FIXTURE_CAMERA, GENITA_FINDS_STATE / GENITA_FINDS_TAB, GENITA_CALL_AUTOMIC / AUTOCAMERA, the review stages
/// (AppState.applyReviewFixture) and the recorded call sessions (ios-app/Tools/call-replay), replayed by `PreviewReplay`
/// instead of a WebSocket. Consent is never skipped: CS01 is a screen of the preview like any other.
enum BrowserPreview {
    static let argument = "--browser-preview"
    static let isActive: Bool = ProcessInfo.processInfo.arguments.contains(argument)

    /// Environment the stubs read, set once at launch (never overwrites a value given on the command line).
    static func prepare() {
        guard isActive else { return }
        for (key, value) in ["GENITA_FIXTURE_SCRIPT": "none", "GENITA_CALL_AUTOMIC": "1", "GENITA_PREVIEW_SESSION": "r1"] { setenv(key, value, 0) }
    }

    /// Menu choices: set (or clear) the stub variables the next call screen reads.
    static func configureCall(session: String = "r1", findsState: Int? = nil, findsTab: String? = nil, camera: Bool = false) {
        guard isActive else { return }
        func put(_ key: String, _ value: String?) { if let value { setenv(key, value, 1) } else { unsetenv(key) } }
        put("GENITA_PREVIEW_SESSION", session)
        put("GENITA_FINDS_STATE", findsState.map(String.init))
        put("GENITA_FINDS_TAB", findsTab)
        put("GENITA_FIXTURE_CAMERA", camera ? "bundle:finds-frame-fridge-0" : nil)
        put("GENITA_CALL_AUTOCAMERA", camera ? "1" : nil)
    }
}

/// Stands in for genita-server's `/v1/session` the way ios-app/Tools/call-replay/server.mjs does, inside the app:
/// `start` → the recorded handshake, `audio_start` → the recorded timeline at its original pace (the reply audio is
/// silence of the recorded length). No error or dropped connection at the end (the demo stays on the last state);
/// the mic can be turned off and on again to replay it.
@MainActor final class PreviewReplay {
    private struct Item { let t: Double; let event: [String: Any]?; let header: Data?; let pcmBytes: Int }
    private let handshake: [[String: Any]]
    private let timeline: [Item]
    private let deliver: @MainActor (CallSocket.Incoming) -> Void
    private var started = false
    private var replaying = false
    private var tasks: [Task<Void, Never>] = []

    init?(session: String, deliver: @escaping @MainActor (CallSocket.Incoming) -> Void) {
        guard let url = Bundle.main.url(forResource: "preview-session-\(session)", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let handshake = root["handshake"] as? [[String: Any]],
              let raw = root["timeline"] as? [[String: Any]] else { return nil }
        self.handshake = handshake
        self.timeline = raw.compactMap { item in
            guard let t = (item["t"] as? NSNumber)?.doubleValue else { return nil }
            if let event = item["event"] as? [String: Any] { return Item(t: t, event: event, header: nil, pcmBytes: 0) }
            if let frame = item["frame"] as? [String: Any], let head = (frame["header"] as? String).flatMap({ Data(base64Encoded: $0) }),
               let bytes = (frame["pcmBytes"] as? NSNumber)?.intValue { return Item(t: t, event: nil, header: head, pcmBytes: bytes) }
            return nil
        }
        self.deliver = deliver
    }

    func handle(_ message: ClientMessage) {
        switch message {
        case .start:
            guard !started else { return }
            started = true
            for event in handshake { send(event) }
        case .audioStart:
            if !replaying { play() }
        case let .ping(t):
            send(["type": "pong", "t": t.map { $0 as Any } ?? NSNull()])
        default:
            break // text, frames, barge-in, mode… the recording does not answer them
        }
    }

    func stop() { tasks.forEach { $0.cancel() }; tasks = [] }

    private func play() {
        replaying = true
        var last = 0.0
        for item in timeline {
            last = max(last, item.t)
            tasks.append(Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(item.t))
                guard !Task.isCancelled, let self else { return }
                if let event = item.event { self.send(event) }
                else if let header = item.header { self.deliver(.binary(header + Data(count: item.pcmBytes))) }
            })
        }
        let end = last + 1500
        tasks.append(Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(end))
            guard !Task.isCancelled else { return }
            self?.replaying = false
        })
    }

    private func send(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) else { return }
        deliver(.text(text))
    }
}
#endif
