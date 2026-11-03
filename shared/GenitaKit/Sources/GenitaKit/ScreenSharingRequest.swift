/// Picker, starting and active captures have separate lifetimes. Opening or cancelling
/// a picker leaves active media authorized; stop/logout invalidates all three.
public struct ScreenSharingRequest: Sendable {
    private var generation: UInt64 = 0
    public private(set) var current: UInt64?
    private var starting: UInt64?
    private var active: UInt64?

    public init() {}

    @discardableResult public mutating func begin() -> UInt64 {
        generation &+= 1
        current = generation
        starting = nil
        return generation
    }

    public mutating func cancelPicker() { current = nil }

    /// Consume a picker selection once, before any asynchronous work starts.
    public mutating func beginCapture() -> UInt64? {
        guard let current else { return nil }
        self.current = nil
        starting = current
        return current
    }

    @discardableResult public mutating func completeCapture(_ request: UInt64) -> Bool {
        guard isStarting(request) else { return false }
        starting = nil
        active = request
        return true
    }

    public mutating func cancelCapture(_ request: UInt64) {
        if isStarting(request) { starting = nil }
    }

    public mutating func invalidate() { current = nil; starting = nil; active = nil }

    public func isCurrent(_ request: UInt64) -> Bool { current == request }
    public func isStarting(_ request: UInt64) -> Bool { starting == request }
    public func acceptsSamples(_ request: UInt64) -> Bool { active == request }
}

/// Bound once to a stream/request, then protected by the output handler's lock.
/// An old stream's buffer must never be processed with a newer request's callbacks.
public struct ScreenSharingSampleGate: Sendable {
    private let request: UInt64
    private let stream: ObjectIdentifier
    private var enabled = true

    public init(request: UInt64, stream: ObjectIdentifier) {
        self.request = request
        self.stream = stream
    }

    public mutating func invalidate() { enabled = false }

    public func accepts(stream: ObjectIdentifier, request: UInt64) -> Bool {
        enabled && self.stream == stream && self.request == request
    }
}
