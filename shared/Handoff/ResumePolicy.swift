/// How the conversation came to be on this device, and whether the call opens by itself (lead 11/4, scorecard MC-01).
/// A cold launch (or the server's sync of an old claim) never starts the mic, camera or screen on its own: the home
/// shows a one-tap resume. Only a live move the user just made (from the iPhone: Move to Mac, touch, or this
/// device's own Continue here) opens the call directly.
enum OwnerArrival: Equatable {
    /// the app started (or the account was restored) and the stored / server state already says this device
    case coldLaunch
    /// a claim received from the server or the local link that this device did not just make (connect-time sync)
    case syncedClaim
    /// this device claimed it now: the iPhone's move request, a touch, or Continue here
    case liveMove
}

enum ResumePolicy {
    /// true: open the call now. false: offer "Continue here" and wait for the tap.
    static func opensCall(_ arrival: OwnerArrival) -> Bool { arrival == .liveMove }
    /// The server's connect-time copies of the current claim; any other trigger is a move happening now
    /// (e.g. "proximity", where the server itself moves the conversation here).
    static let syncTriggers: Set<String> = ["current", "sync"]
    /// What a change of owner to this device was: this device's own claim, or a server claim and its trigger.
    static func arrival(localClaim: Bool, serverTrigger: String?) -> OwnerArrival {
        if localClaim { return .liveMove }
        if let serverTrigger, !syncTriggers.contains(serverTrigger) { return .liveMove }
        return .syncedClaim
    }
}
