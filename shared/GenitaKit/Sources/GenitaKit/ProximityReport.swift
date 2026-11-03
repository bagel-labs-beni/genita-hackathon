import Foundation

/// The Mac's proximity report in flight (genita-server PROTOCOL.md "Proximity"). `proximity.result` does not echo the
/// token, so there is one report at a time. The server answers every report (a store failure is `server_error`), but
/// an answer that never comes (an older server's bare `error`, a stuck request on a socket that stays up) must not
/// block the Mac until it reconnects: after `answerTimeout` the report is given up and a later approach reports again.
struct ProximityReport: Equatable, Sendable {
    static let answerTimeout = 5.0
    private(set) var token: String?
    private var sentAt = 0.0

    var canReport: Bool { token == nil }

    mutating func sent(_ token: String, at now: Double) {
        self.token = token
        sentAt = now
    }

    /// The answer to the report in flight: its token (nil when none was in flight), and the slot is free again.
    mutating func answered() -> String? {
        defer { token = nil }
        return token
    }

    /// Checked every tick: the token given up on when no answer came in time.
    mutating func expire(at now: Double) -> String? {
        guard token != nil, now - sentAt >= Self.answerTimeout else { return nil }
        return answered()
    }

    /// A reconnect: an answer from the old socket cannot arrive on the new one.
    mutating func reset() { token = nil }
}
