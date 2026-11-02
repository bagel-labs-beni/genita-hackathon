/// A permission answer belongs to one capture context. A permission alert's temporary inactivity
/// defers the answer; background, end and handoff invalidate it, even if ownership later returns.
public struct CapturePermissionRequests: Sendable {
    public enum Activity: Sendable { case active, inactive, background }
    public enum Media: Sendable { case microphone, camera }
    public struct Answer: Equatable, Sendable {
        public let media: Media
        public let granted: Bool
    }

    public private(set) var generation: UInt64 = 0
    private var activity: Activity = .active
    private var deferred: [Answer] = []

    public init() {}

    public mutating func invalidate() {
        generation &+= 1
        deferred.removeAll()
    }

    /// Returned answers may be applied now, after rechecking the current call and owner.
    @discardableResult
    public mutating func updateActivity(_ activity: Activity, callEnded: Bool, isOwner: Bool) -> [Answer] {
        self.activity = activity
        if activity == .background { invalidate() }
        guard activity == .active else { return [] }
        let answers = deferred
        deferred.removeAll()
        return !callEnded && isOwner ? answers : []
    }

    /// A valid answer received behind the system alert waits for the scene to become active.
    public mutating func resolve(_ media: Media, granted: Bool, generation: UInt64,
                                 callEnded: Bool, isOwner: Bool) -> Answer? {
        guard accepts(generation, callEnded: callEnded, isOwner: isOwner) else { return nil }
        let answer = Answer(media: media, granted: granted)
        if activity == .inactive { deferred.append(answer); return nil }
        return answer
    }

    public func accepts(_ requestGeneration: UInt64, callEnded: Bool, isOwner: Bool) -> Bool {
        requestGeneration == generation && activity != .background && !callEnded && isOwner
    }
}
