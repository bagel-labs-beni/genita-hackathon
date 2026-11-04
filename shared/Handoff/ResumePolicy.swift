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
/// Mac) keeps the camera the way the user left it on the Mac, so an outfit shown on the iPhone stays in view without a click.
/// The iPhone doesn't send its camera state, so the Mac's own last camera choice stands in for it (UserDefaults).
/// A call opened on the Mac itself always starts with the camera off (privacy), and without camera permission
/// nothing starts by itself: no system dialog, the usual camera-off flow stays as it is.
enum HandoffCameraPolicy {
    static func startsCamera(fromPhone: Bool, cameraRemembered: Bool, cameraAuthorized: Bool) -> Bool {
        fromPhone && cameraRemembered && cameraAuthorized
    }
    /// The conversation came here from a call running on the iPhone, not only its ownership: taking it while the
    /// iPhone sits on its home screen is a new call on the Mac (camera off, Codex P1). `peerInCall` is the server's
    /// word (nil on an older server, which only says whether the iPhone app is in front).
    static func movedFromPhoneCall(previousOwner: ConversationDevice, peerInCall: Bool?, peerActive: Bool) -> Bool {
        previousOwner == .phone && (peerInCall ?? peerActive)
    }
}
