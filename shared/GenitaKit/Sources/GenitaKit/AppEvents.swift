import Foundation

/// A scalar accepted by the app-events endpoint. App telemetry intentionally has no
/// arbitrary object or free-text value type.
public enum AppEventValue: Sendable, Equatable, Codable {
    case string(String)
    case int(Int)
    case bool(Bool)

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if let bool = try? value.decode(Bool.self) { self = .bool(bool) }
        else if let int = try? value.decode(Int.self) { self = .int(int) }
        else { self = .string(try value.decode(String.self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case let .string(string): try value.encode(string)
        case let .int(int): try value.encode(int)
        case let .bool(bool): try value.encode(bool)
        }
    }
}

/// The complete allowlist accepted by `POST /v1/events`.
public enum AppEvent: Sendable {
    public enum SetupDepth: String, Sendable { case quick, full }
    public enum CameraFacing: String, Sendable { case front, back }
    public enum HandoffTarget: String, Sendable { case iphone, mac }
    public enum HandoffFailure: String, Sendable { case timeout, denied, offline, other }

    case importPromptCopied
    case importSubmitted(chars: Int)
    case importCancelled
    case importSkipped
    case faceConfirmed(companionId: String)
    case voicePreviewed(voiceId: String)
    case setupDepthSelected(SetupDepth)
    case setupAnswered(step: Int)
    case setupAbandoned(step: Int)
    case setupSummaryViewed
    case setupSummaryCancelled
    case cameraToggled(on: Bool, facing: CameraFacing)
    case screenShareStarted
    case screenShareStopped(seconds: Int)
    case screenAsked
    case observeBoxesShown(count: Int)
    case findOpened(findId: String)
    case productLinksOpened(findId: String, index: Int)
    case handoffPreparing(to: HandoffTarget)
    case handoffCommitted(to: HandoffTarget, ms: Int)
    case handoffFailed(reason: HandoffFailure)
    case appReopened(gapHours: Int)

    public var name: String {
        switch self {
        case .importPromptCopied: "import.prompt_copied"
        case .importSubmitted: "import.submitted"
        case .importCancelled: "import.cancelled"
        case .importSkipped: "import.skipped"
        case .faceConfirmed: "face.confirmed"
        case .voicePreviewed: "voice.previewed"
        case .setupDepthSelected: "setup.depth_selected"
        case .setupAnswered: "setup.answered"
        case .setupAbandoned: "setup.abandoned"
        case .setupSummaryViewed: "setup.summary_viewed"
        case .setupSummaryCancelled: "setup.summary_cancelled"
        case .cameraToggled: "camera.toggled"
        case .screenShareStarted: "screen.share_started"
        case .screenShareStopped: "screen.share_stopped"
        case .screenAsked: "screen.asked"
        case .observeBoxesShown: "observe.boxes_shown"
        case .findOpened: "find.opened"
        case .productLinksOpened: "product.links_opened"
        case .handoffPreparing: "handoff.preparing"
        case .handoffCommitted: "handoff.committed"
        case .handoffFailed: "handoff.failed"
        case .appReopened: "app.reopened"
        }
    }

    public var props: [String: AppEventValue] {
        switch self {
        case .importPromptCopied, .importCancelled, .importSkipped, .setupSummaryViewed,
             .setupSummaryCancelled, .screenShareStarted, .screenAsked:
            [:]
        case let .importSubmitted(chars): ["chars": .int(Self.clamp(chars))]
        case let .faceConfirmed(companionId): Self.idProps("companionId", companionId)
        case let .voicePreviewed(voiceId): Self.idProps("voiceId", voiceId)
        case let .setupDepthSelected(depth): ["depth": .string(depth.rawValue)]
        case let .setupAnswered(step): ["step": .int(Self.clamp(step))]
        case let .setupAbandoned(step): ["step": .int(Self.clamp(step))]
        case let .cameraToggled(on, facing): ["on": .bool(on), "facing": .string(facing.rawValue)]
        case let .screenShareStopped(seconds): ["seconds": .int(Self.clamp(seconds))]
        case let .observeBoxesShown(count): ["count": .int(Self.clamp(count))]
        case let .findOpened(findId): Self.idProps("findId", findId)
        case let .productLinksOpened(findId, index): Self.idProps("findId", findId, extra: ["index": .int(Self.clamp(index))])
        case let .handoffPreparing(to): ["to": .string(to.rawValue)]
        case let .handoffCommitted(to, ms): ["to": .string(to.rawValue), "ms": .int(Self.clamp(ms))]
        case let .handoffFailed(reason): ["reason": .string(reason.rawValue)]
        case let .appReopened(gapHours): ["gapHours": .int(Self.clamp(gapHours))]
        }
    }

    private static func clamp(_ value: Int) -> Int { min(10_000_000, max(0, value)) }

    private static func idProps(_ key: String, _ id: String, extra: [String: AppEventValue] = [:]) -> [String: AppEventValue] {
        guard id.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil else { return extra }
        return extra.merging([key: .string(id)]) { _, id in id }
    }
}

/// Buffers and sends a user's app-owned funnel events. It never throws or logs event props.
public actor AppEventsClient {
    private struct QueuedEvent: Sendable {
        let id = UUID()
        let event: AppEvent
        var attempts = 0
    }

    private struct RequestBody: Encodable {
        let events: [RequestEvent]
    }

    private struct RequestEvent: Encodable {
        let name: String
        let props: [String: AppEventValue]
    }

    private let baseURL: URL
    private let token: @Sendable () -> String?
    private let session: URLSession
    private let flushEvery: Duration
    private let maxBatch: Int
    private var buffer: [QueuedEvent] = []
    private var timerTask: Task<Void, Never>?
    private var isFlushing = false

    public init(
        baseURL: URL,
        token: @escaping @Sendable () -> String?,
        session: URLSession = .shared,
        flushEvery: Duration = .seconds(10),
        maxBatch: Int = 20
    ) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
        self.flushEvery = flushEvery
        self.maxBatch = min(20, max(1, maxBatch))
    }

    deinit { timerTask?.cancel() }

    /// Enqueues only; transport happens later or when the batch is full.
    public func log(_ event: AppEvent) {
        buffer.append(QueuedEvent(event: event))
        if buffer.count > 200 { buffer.removeFirst(buffer.count - 200) }
        startTimerIfNeeded()
        if buffer.count >= maxBatch {
            Task { [weak self] in await self?.flush() }
        }
    }

    public func flush() async {
        guard !isFlushing else { return }
        isFlushing = true
        defer { isFlushing = false }

        while !buffer.isEmpty {
            guard let token = token(), !token.isEmpty else {
                buffer.removeAll()
                return
            }
            let batch = Array(buffer.prefix(maxBatch))
            let outcome = await send(batch, token: token)
            switch outcome {
            case .success:
                remove(batch)
            case .unauthorized:
                buffer.removeAll()
                return
            case .retry:
                incrementAttempts(for: batch)
                return
            case .discard:
                remove(batch)
                return
            }
        }
    }

    private enum SendOutcome { case success, unauthorized, retry, discard }

    private func startTimerIfNeeded() {
        guard timerTask == nil else { return }
        let interval = flushEvery
        timerTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: interval)
                guard !Task.isCancelled else { break }
                await self?.flush()
            }
        }
    }

    private func send(_ batch: [QueuedEvent], token: String) async -> SendOutcome {
        guard let body = try? JSONEncoder().encode(RequestBody(events: batch.map {
            RequestEvent(name: $0.event.name, props: $0.event.props)
        })) else { return .discard }
        var request = URLRequest(url: baseURL.appendingPathComponent("v1/events"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        do {
            let (_, response) = try await session.data(for: request)
            guard let response = response as? HTTPURLResponse else { return .retry }
            switch response.statusCode {
            case 204: return .success
            case 401: return .unauthorized
            case 429, 500...599: return .retry
            default: return .discard
            }
        } catch {
            return .retry
        }
    }

    private func remove(_ sent: [QueuedEvent]) {
        let ids = Set(sent.map(\.id))
        buffer.removeAll { ids.contains($0.id) }
    }

    private func incrementAttempts(for failed: [QueuedEvent]) {
        let ids = Set(failed.map(\.id))
        for index in buffer.indices where ids.contains(buffer[index].id) {
            buffer[index].attempts += 1
        }
        buffer.removeAll { ids.contains($0.id) && $0.attempts >= 3 }
    }
}
