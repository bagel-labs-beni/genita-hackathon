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
    /// The only move the server makes for this device by itself (PROTOCOL "Proximity"). Every other trigger on a
    /// claim for this device is this device's own claim coming back (button/touch/continue/move/start, also re-sent
    /// by a reconnect's publishCurrent) or a connect-time copy (current/sync) — not a move happening now (Codex P1).
    static let serverMoveTriggers: Set<String> = ["proximity"]
    /// What a change of owner to this device was: this device's own claim, or a server claim and its trigger.
    static func arrival(localClaim: Bool, serverTrigger: String?) -> OwnerArrival {
        if localClaim { return .liveMove }
        if let serverTrigger, serverMoveTriggers.contains(serverTrigger) { return .liveMove }
        return .syncedClaim
    }
}

/// Demo S4: a call that moves to the Mac from a call on the iPhone (Move to Mac, touch, proximity, Continue on this
/// Mac) keeps the camera the way it was on the iPhone, so an outfit shown on the iPhone stays in view without a click.
/// b14 (Chelsea 11/4 "camera doesn't turn on after the pairing code"): the paired iPhone now tells the Mac over the
/// local link whether its call and camera are on (`callState`). That word wins; without it (no local link) the Mac's
/// own last camera tap stands in, as before. A first move to a Mac that was just paired had neither a remembered tap
/// nor camera access, so the camera stayed off: with the iPhone's camera on, the Mac now asks for access once.
/// A call opened on the Mac itself always starts with the camera off (privacy), and a camera the user turned off on
/// the iPhone stays off.
enum HandoffCameraPolicy {
    /// - Parameters:
    ///   - phoneCamera: the iPhone's camera as the call left it (local link); nil when the iPhone didn't say.
    ///   - cameraUndetermined: camera access was never asked on this Mac (only the iPhone's camera-on may ask).
    static func startsCamera(fromPhone: Bool, phoneCamera: Bool? = nil, cameraRemembered: Bool, cameraAuthorized: Bool,
                             cameraUndetermined: Bool = false) -> Bool {
        guard fromPhone else { return false }
        if let phoneCamera { return phoneCamera && (cameraAuthorized || cameraUndetermined) }
        return cameraRemembered && cameraAuthorized
    }
    /// The conversation came here from a call running on the iPhone, not only its ownership: taking it while the
    /// iPhone sits on its home screen is a new call on the Mac (camera off, Codex P1). `peerInCall` is the server's
    /// word, `linkInCall` the paired iPhone's own (local link); unknown on both never starts the camera (Codex P1 r2).
    static func movedFromPhoneCall(previousOwner: ConversationDevice, peerInCall: Bool?, linkInCall: Bool? = nil) -> Bool {
        previousOwner == .phone && (peerInCall == true || linkInCall == true)
    }
}
