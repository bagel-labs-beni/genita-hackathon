/// Mac watch-together (b16): macOS can end a live ScreenCaptureKit stream on its own (SCStreamErrorDomain -3821
/// "stopped by the system", seen 2/2 in QA 11/4 with iPhone Mirroring on and the shared Safari window moved across
/// displays). A stop the person did not ask for restarts the capture quietly; only a stop the person made (Control
/// Center / the menu bar's Stop Sharing, -3817), a refusal that a restart cannot fix, or a fourth stop inside a minute
/// ends the share.
public enum ScreenShareRestartPolicy {
    public enum Action: Equatable, Sendable {
        /// The person stopped it from the system UI: end the share like the Share pill does (no error alert).
        case userStopped
        /// Start the same capture again after `delay` seconds; the share stays "Sharing Safari" meanwhile.
        case restart(after: Double)
        /// Tell the person: permission gone, or the system keeps stopping it.
        case giveUp
    }

    /// SCStreamError codes (ScreenCaptureKit/SCError.h). GenitaKit builds for iOS too, so no ScreenCaptureKit import.
    public static let userStoppedCode = -3817
    public static let userDeclinedCode = -3801
    public static let missingEntitlementsCode = -3803
    public static let systemStoppedCode = -3821

    /// Backoff for the 1st, 2nd and 3rd restart inside `window` seconds.
    public static let delays: [Double] = [0.5, 1, 2]
    public static let window: Double = 60

    /// `isStreamError`: the error is in SCStreamErrorDomain. `restarts`: times (seconds, any monotonic clock) of the
    /// restarts already made. Any other stop (another domain, an unknown code) counts as a system stop.
    public static func action(isStreamError: Bool, code: Int, restarts: [Double], now: Double) -> Action {
        if isStreamError, code == userStoppedCode { return .userStopped }
        if isStreamError, code == userDeclinedCode || code == missingEntitlementsCode { return .giveUp }
        guard let delay = nextDelay(restarts: restarts, now: now) else { return .giveUp }
        return .restart(after: delay)
    }

    /// The wait before the next restart, nil once 3 restarts happened in the last minute.
    public static func nextDelay(restarts: [Double], now: Double) -> Double? {
        let recent = recentRestarts(restarts, now: now).count
        return recent < delays.count ? delays[recent] : nil
    }

    /// Restarts still inside the one-minute budget.
    public static func recentRestarts(_ restarts: [Double], now: Double) -> [Double] {
        restarts.filter { now - $0 < window && $0 <= now }
    }

    /// What a restart tries, in order. The picked window first while it is still there; a window that is gone falls
    /// back to its app on that display, then to the display; an app that is gone falls back to the display; a display
    /// that is gone (unplugged) falls back to a display that is there. `.display` = the display the source was on.
    public enum Source: Equatable, Sendable { case same, application, display }
    public enum Style: Equatable, Sendable { case window, application, display }

    public static func candidates(style: Style, sourceStillThere: Bool) -> [Source] {
        switch style {
        case .window: sourceStillThere ? [.same, .application, .display] : [.application, .display]
        case .application: sourceStillThere ? [.same, .display] : [.display]
        case .display: sourceStillThere ? [.same, .display] : [.display]
        }
    }
}
