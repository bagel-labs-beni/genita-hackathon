import Foundation

/// F1-L7 start routing: which screen the app opens on, from `/me` and the device.
/// Screen ids are the PRD/board names (A01, A02, CS01, A03, I01, S07, S08, MAC-1…4).
public enum StartRoute: String, Equatable, Sendable {
    /// A01 splash (iPhone, signed out)
    case splash
    /// A02 Apple sign-in (iPhone) / MAC-1 signed out (Mac)
    case signIn
    /// A02-E sign-in failed / offline
    case offline
    /// CS01 AI data consent (once, right after the first sign-in)
    case consent
    /// A03 your name
    case name
    /// I01 copy the import prompt (start of companion setup)
    case importPrompt
    /// S07 "Connecting to …" → S09 call
    case connecting
    /// S08 text chat while the companion's clips are still being made
    case textWhilePreparing
    /// MAC-2 no companion yet (make one on iPhone first)
    case macNoCompanion
    /// MAC-3 the conversation is on the iPhone (Continue on this Mac)
    case macConversationOnPhone
    /// MAC-4 the conversation is on this Mac
    case macConversationHere
}

/// What the app knows about its login when it starts.
public enum GenitaSessionState: Equatable, Sendable {
    /// no token in the keychain
    case signedOut
    /// token present but `/me` said 401 (expired, revoked, account deleted)
    case expired
    /// token present, server unreachable
    case offline
    case active(GenitaMe)
}

public enum StartRouter {
    public static func route(_ state: GenitaSessionState, device: GenitaDevice) -> StartRoute {
        switch (device, state) {
        case (.iphone, .signedOut): return .splash
        case (_, .signedOut), (_, .expired): return .signIn
        case (_, .offline): return .offline
        case (.iphone, .active(let me)):
            if !me.consented { return .consent }
            if (me.user.displayName ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .name }
            if !me.hasCompanion { return .importPrompt }
            return me.prepStatus == .running ? .textWhilePreparing : .connecting
        case (.mac, .active(let me)):
            // no onboarding on Mac (PRD): consent, name and companion all come from the iPhone
            if !me.consented || !me.hasCompanion { return .macNoCompanion }
            switch me.conversation?.activeDevice {
            case "iphone": return .macConversationOnPhone
            case "mac": return .macConversationHere
            default: return .connecting
            }
        }
    }
}
