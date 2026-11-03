import Foundation

/// The Mac's screen-share uplink for one call: `wss://<host>/v1/watch?session=<id>`
/// (genita-server PROTOCOL.md "Watch together"). Frames go up as JSON, the shared
/// screen's sound as binary PCM s16le mono 24 kHz. Down come the share UI events:
/// black screen (MS-3), reacting (MS-2) and the speaker chip (FT-SPK).
///
/// The call client sets `ScreenSharingController.watchConfig` from its `ready`
/// event (server URL, token, sessionId). Without a config, sharing stays local.
final class WatchUplink: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    struct Config: Equatable, Sendable {
        var server: URL          // https://host or wss://host (path is replaced)
        var token: String?
        var sessionId: String

        /// DEBUG / local runs: GENITA_SERVER_URL, GENITA_SESSION_TOKEN, GENITA_WATCH_SESSION.
        static func fromEnvironment() -> Config? {
            let env = ProcessInfo.processInfo.environment
            guard let s = env["GENITA_SERVER_URL"], let url = URL(string: s), let id = env["GENITA_WATCH_SESSION"], !id.isEmpty else { return nil }
            return Config(server: url, token: env["GENITA_SESSION_TOKEN"], sessionId: id)
        }

        var watchURL: URL? {
            guard var c = URLComponents(url: server, resolvingAgainstBaseURL: false) else { return nil }
            c.scheme = (c.scheme == "https" || c.scheme == "wss") ? "wss" : "ws"
            c.path = "/v1/watch"
            var items = [URLQueryItem(name: "session", value: sessionId)]
            if let token, !token.isEmpty { items.append(URLQueryItem(name: "token", value: token)) }
            c.queryItems = items
            return c.url
        }
    }

    enum Event: Equatable, Sendable {
        case state(sharing: Bool, blank: Bool)
        case reaction(moment: String)
        case speaker(name: String?)
        case closed
    }

    private let config: Config
    private let onEvent: @Sendable (Event) -> Void
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private let lock = NSLock()
    private var open = false
    private var pending: [URLSessionWebSocketTask.Message] = []

    init(config: Config, onEvent: @escaping @Sendable (Event) -> Void) {
        self.config = config
        self.onEvent = onEvent
        super.init()
    }

    func connect(source: String?) {
        guard let url = config.watchURL else { return }
        let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        let task = session.webSocketTask(with: url)
        task.maximumMessageSize = 2 * 1024 * 1024
        lock.withLock { self.session = session; self.task = task; pending = [] }
        task.resume()
        var start: [String: Any] = ["type": "start"]
        if let source { start["source"] = source }
        sendJSON(start)
        receive(task)
    }

    /// The share switched to another window or display mid-call: the server's `start` while sharing only renames it.
    func updateSource(_ source: String?) {
        var start: [String: Any] = ["type": "start"]
        if let source { start["source"] = source }
        sendJSON(start)
    }

    func stop() {
        sendJSON(["type": "stop"])
        let t = lock.withLock { () -> URLSessionWebSocketTask? in let t = task; task = nil; open = false; pending = []; return t }
        // let the stop message go out before closing
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) { t?.cancel(with: .normalClosure, reason: nil) }
    }

    /// JPEG ≤ 1024 px, only when the picture changed. `blank`: the frame is (almost) black.
    func sendFrame(_ jpeg: Data, blank: Bool, motion: Float? = nil) {
        var frame: [String: Any] = ["type": "frame", "image": jpeg.base64EncodedString(), "blank": blank]
        if let motion { frame["motion"] = (Double(motion) * 1000).rounded() / 1000 }
        sendJSON(frame)
    }

    /// PCM s16le mono 24 kHz, real time.
    func sendAudio(_ pcm: Data) { send(.data(pcm)) }

    private func sendJSON(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) else { return }
        send(.string(text))
    }

    private func send(_ message: URLSessionWebSocketTask.Message) {
        let (current, ready) = lock.withLock { () -> (URLSessionWebSocketTask?, Bool) in
            if !self.open, self.task != nil, self.pending.count < 64 { self.pending.append(message) }
            return (self.task, self.open)
        }
        guard let current, ready else { return }
        current.send(message) { _ in }
    }

    private func receive(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(.string(let text)):
                if let data = text.data(using: .utf8), let event = Self.decode(data) { self.onEvent(event) }
                self.receive(task)
            case .success:
                self.receive(task)
            case .failure:
                if self.lock.withLock({ self.task === task }) { self.onEvent(.closed) }
            }
        }
    }

    static func decode(_ data: Data) -> Event? {
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let type = o["type"] as? String else { return nil }
        switch type {
        case "state": return .state(sharing: o["sharing"] as? Bool ?? false, blank: o["blank"] as? Bool ?? false)
        case "reaction": return .reaction(moment: o["moment"] as? String ?? "funny")
        case "speaker": return .speaker(name: (o["on"] as? Bool ?? false) ? (o["name"] as? String ?? "") : nil)
        default: return nil
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        let queued = lock.withLock { () -> [URLSessionWebSocketTask.Message] in
            guard task === webSocketTask else { return [] }
            open = true
            let q = pending; pending = []; return q
        }
        for m in queued { webSocketTask.send(m) { _ in } }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        if lock.withLock({ task === webSocketTask }) { onEvent(.closed) }
    }
}
