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

    public func isCurrent(_ snapshot: Snapshot) -> Bool {
        snapshot.generation == generation
    }

    public mutating func invalidate() {
        generation &+= 1
    }
}
