import Foundation

/// A local request generation for onboarding work. A response may update app state only while both the
/// generation and the session token that started it are still current.
public struct OnboardingSessionGeneration: Sendable {
    public struct Snapshot: Equatable, Sendable {
        fileprivate let generation: UInt64
        fileprivate let token: String?
    }

    private var generation: UInt64 = 0

    public init() {}

    public func snapshot(token: String?) -> Snapshot {
        Snapshot(generation: generation, token: token)
    }

    public func isCurrent(_ snapshot: Snapshot, token: String?) -> Bool {
        snapshot.generation == generation && snapshot.token == token
    }

    /// A 401 clears the current request's token before its error handler runs. That request may still
    /// route to sign-in, but a response from an invalidated (previous-account) generation never may.
    public func isCurrent(_ snapshot: Snapshot, token: String?, allowingClearedSession: Bool) -> Bool {
        isCurrent(snapshot, token: token) || (allowingClearedSession && isCurrent(snapshot))
    }

    public func isCurrent(_ snapshot: Snapshot) -> Bool {
        snapshot.generation == generation
    }

    public mutating func invalidate() {
        generation &+= 1
    }
}
