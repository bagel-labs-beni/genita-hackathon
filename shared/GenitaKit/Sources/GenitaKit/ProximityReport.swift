import Foundation

/// One proximity report in flight. Each result must echo both its request ID and token, including on a retry of
/// the same token. A timeout frees the slot for a later approach but is UNCONFIRMED, not a refusal: the detector
/// must keep its leave-range latch. Retain that attempt for a late answer until a new approach supersedes it.
struct ProximityReport: Equatable, Sendable {
    static let answerTimeout = 5.0
    private struct Attempt: Equatable, Sendable { let requestID: String; let token: String }
    private var latest: Attempt?
    private(set) var token: String?
    private var sentAt = 0.0

    var canReport: Bool { token == nil }

    @discardableResult mutating func sent(_ token: String, at now: Double) -> String {
        let requestID = UUID().uuidString
        latest = Attempt(requestID: requestID, token: token)
        self.token = token
        sentAt = now
        return requestID
    }

    /// Only this approach's result may settle it or release its latch. Older/uncorrelated replies do nothing,
    /// even if a later attempt happens to reuse the same token. A late answer after timeout still counts.
    mutating func answered(requestID: String?, token: String?) -> String? {
        guard let latest, latest.requestID == requestID, latest.token == token else { return nil }
        reset()
        return latest.token
    }

    /// Checked every tick: stop waiting, but leave this approach UNCONFIRMED and latched until it leaves range
    /// or receives a matching refusal. The server may still save successfully after this deadline.
    mutating func expire(at now: Double) -> String? {
        guard token != nil, now - sentAt >= Self.answerTimeout else { return nil }
        defer { token = nil }
        return token
    }

    /// Reconnect or confirmed Mac ownership: forget replies, without changing the detector's approach latch.
    mutating func reset() { token = nil; latest = nil }
}
