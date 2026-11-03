/// Which picture of the companion a call shows under the live face (CL-03, #561 → #576). Only this account's own
/// picture: the server's scene still first, then the profile the iPhone handed over. Nothing else — never a bundled
/// face (another account's companion); nil means the dark call ground (the iPhone's #524 rule).
enum CallStillSource: Equatable {
    case serverStill
    case handoffProfile
    case ground

    static func pick(hasServerStill: Bool, hasHandoffProfile: Bool) -> CallStillSource {
        if hasServerStill { return .serverStill }
        if hasHandoffProfile { return .handoffProfile }
        return .ground
    }
}
