/// Picker, starting and active captures have separate lifetimes. Opening or cancelling
/// a picker leaves active media authorized; stop/logout invalidates all three.
///
/// The system picker (`SCContentSharingPicker.shared`) is one shared UI whose callbacks carry no presentation id.
/// If stop/logout happens while a picker is still open, its late callback must not be taken as the next picker's
/// answer (#318 review P1: A's selection consumed B's request and A's screen reached B's session). `invalidate()`
/// marks that presentation stale; the next picker callback is dropped as A's, and the app waits for that (or a
/// short timeout, `clearStalePicker()`) before presenting B's picker.
public struct ScreenSharingRequest: Sendable {
    private var generation: UInt64 = 0
    public private(set) var current: UInt64?
    private var starting: UInt64?
    private var active: UInt64?
    /// A picker presentation is on screen (begin() without a callback yet).
    private var pickerOpen = false
    /// A presentation from before the last stop/logout may still answer.
    public private(set) var stalePicker = false
    /// After a stale wait timed out, answers before this moment are too fast for a person in the new picker:
    /// they are the old presentation's in-flight answer (Codex review on #496).
    private var guardUntil: Double = -.infinity

    public init() {}

    @discardableResult public mutating func begin() -> UInt64 {
        generation &+= 1
        current = generation
        starting = nil
        pickerOpen = true
        return generation
    }

    /// The picker was cancelled. False = it was the stale presentation's answer (dropped, the current request stays).
    @discardableResult public mutating func cancelPicker(now: Double? = nil) -> Bool {
        if stalePicker { stalePicker = false; return false }
        if let now, now < guardUntil { return false }
        current = nil
        pickerOpen = false
        return true
    }

    /// The stale presentation got no answer within the app's wait. The new picker is presented at `now`; answers in
    /// the next `guardSeconds` are still treated as the old one's (nobody picks that fast in a picker just shown).
    public mutating func clearStalePicker(presentingAt now: Double, guardSeconds: Double = 1) {
        stalePicker = false
        guardUntil = now + guardSeconds
    }

    /// Consume a picker selection once, before any asynchronous work starts. A stale presentation's selection is
    /// consumed here and dropped (nil), leaving the current request untouched.
    public mutating func beginCapture(now: Double? = nil) -> UInt64? {
        if stalePicker { stalePicker = false; return nil }
        if let now, now < guardUntil { return nil }
        guard let current else { return nil }
        pickerOpen = false
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

    public mutating func invalidate() {
        if pickerOpen { stalePicker = true }
        pickerOpen = false
        current = nil; starting = nil; active = nil
    }

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
