/// A permission answer belongs to one active capture context. Ending or suspending the call
/// invalidates both media requests, even if the same device owns a later call again.
public struct CapturePermissionRequests: Sendable {
    public private(set) var generation: UInt64 = 0

    public init() {}

    public mutating func invalidate() { generation &+= 1 }

    public func accepts(_ requestGeneration: UInt64, callEnded: Bool, isOwner: Bool) -> Bool {
        requestGeneration == generation && !callEnded && isOwner
    }
}
