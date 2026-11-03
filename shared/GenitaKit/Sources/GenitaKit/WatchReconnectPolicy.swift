/// Watch sockets retry in a live, owned call; capture can wait while that call recovers.
public enum WatchReconnectPolicy {
    public enum RecoveryAction: Equatable, Sendable {
        case waitForCall
        case retry(after: Int)
        case stop
    }

    public static func recoveryAction(attempt: Int, isSharing: Bool, callIsValid: Bool,
                                      isCallActive: Bool, isOwner: Bool, isSignedIn: Bool) -> RecoveryAction {
        guard isSharing, isCallActive, isOwner, isSignedIn else { return .stop }
        // The call's ready event and the view updating watchConfig can arrive after watch closes.
        guard callIsValid else { return .waitForCall }
        guard let delay = delay(attempt: attempt, isSharing: isSharing, callIsValid: callIsValid) else { return .stop }
        return .retry(after: delay)
    }

    public static func callIsValid(configuredSession: String?, activeSession: String?,
                                   isLive: Bool, isOwner: Bool, isSignedIn: Bool) -> Bool {
        guard let configuredSession, !configuredSession.isEmpty else { return false }
        return configuredSession == activeSession && isLive && isOwner && isSignedIn
    }

    public static func delay(attempt: Int, isSharing: Bool, callIsValid: Bool) -> Int? {
        guard isSharing, callIsValid, (0..<3).contains(attempt) else { return nil }
        return 1 << attempt
    }
}
