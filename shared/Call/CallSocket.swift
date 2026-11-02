import Foundation

/// One WebSocket to `/v1/session`. Sends are safe from any thread (mic audio comes from the audio thread);
/// everything received is delivered on the main actor.
final class CallSocket: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    enum Incoming { case text(String), binary(Data) }
    enum Closure: Equatable { case normal, server(code: Int, reason: String), failed(String) }

    var onOpen: (@MainActor () -> Void)?
    var onMessage: (@MainActor (Incoming) -> Void)?
    var onClose: (@MainActor (Closure) -> Void)?

    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private let queue = DispatchQueue(label: "ai.thebeni.genita.call-socket")
    private var closed = false

    func connect(url: URL, token: String?) {
        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        if let token, !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = false
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        let task = session.webSocketTask(with: request)
        task.maximumMessageSize = 4 << 20
        self.session = session
        self.task = task
        task.resume()
        receive(task)
    }

    func send(_ message: ClientMessage) {
        guard let text = try? message.json() else { return }
        queue.async { [weak self] in self?.task?.send(.string(text)) { _ in } }
    }

    func send(audio: Data) {
        queue.async { [weak self] in self?.task?.send(.data(audio)) { _ in } }
    }

    /// Ends the call from the app side: `stop`, then a normal close.
    func close() {
        queue.async { [weak self] in
            guard let self, !self.closed else { return }
            self.closed = true
            self.task?.send(.string((try? ClientMessage.stop.json()) ?? "")) { _ in }
            self.task?.cancel(with: .normalClosure, reason: nil)
            self.session?.finishTasksAndInvalidate()
        }
    }

    private func receive(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(message):
                let incoming: Incoming
                switch message {
                case let .string(s): incoming = .text(s)
                case let .data(d): incoming = .binary(d)
                @unknown default: return self.receive(task)
                }
                DispatchQueue.main.async { MainActor.assumeIsolated { self.onMessage?(incoming) } } // FIFO: binary audio before its `reply`
                self.receive(task)
            case let .failure(error):
                // A close frame can surface here before didCloseWith; keep its code (4401/4403 route the app).
                if task.closeCode != .invalid {
                    let reason = task.closeReason.map { String(decoding: $0, as: UTF8.self) } ?? ""
                    self.finish(task.closeCode == .normalClosure ? .normal : .server(code: task.closeCode.rawValue, reason: reason))
                    return
                }
                let status = (task.response as? HTTPURLResponse)?.statusCode
                self.finish(.failed(status.map { "HTTP \($0)" } ?? error.localizedDescription))
            }
        }
    }

    private func finish(_ closure: Closure) {
        queue.async { [weak self] in
            guard let self, !self.closed else { return }
            self.closed = true
            self.session?.invalidateAndCancel()
            DispatchQueue.main.async { MainActor.assumeIsolated { self.onClose?(closure) } }
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        DispatchQueue.main.async { MainActor.assumeIsolated { self.onOpen?() } }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        let text = reason.map { String(decoding: $0, as: UTF8.self) } ?? ""
        finish(closeCode == .normalClosure ? .normal : .server(code: closeCode.rawValue, reason: text))
    }
}
