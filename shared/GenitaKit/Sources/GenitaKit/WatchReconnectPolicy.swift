/// A watch socket may recover only within the same live, owned call.
public enum WatchReconnectPolicy {
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
