/// An explicit picker request authorizes capture until stop/logout. Async starts and
/// queued media must still belong to that request after each suspension point.
public struct ScreenSharingRequest: Sendable {
    private var generation: UInt64 = 0
    public private(set) var current: UInt64?

    public init() {}

    @discardableResult public mutating func begin() -> UInt64 {
        generation &+= 1
        current = generation
        return generation
    }

    public mutating func invalidate() { current = nil }

    public func isCurrent(_ request: UInt64) -> Bool { current == request }
}
