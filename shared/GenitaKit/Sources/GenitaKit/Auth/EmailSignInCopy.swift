import Foundation

/// The one-line messages of the email sign-in sheet (iPhone A02-M and the Mac sheet say the same thing).
public enum EmailSignInCopy {
    /// `sendingCode` = the address step ("Send code" / "Resend code"), else the code step.
    public static func message(for error: Error, sendingCode: Bool) -> String {
        switch error as? GenitaAuthError {
        // a server without the email routes answers 401/404 to "Send code": say it's off, not "wrong code"
        case .unauthorized: return sendingCode ? "Email sign-in isn’t available right now." : "That code didn’t work. Check it and try again."
        case .server(404, _): return "Email sign-in isn’t available right now."
        case .server(429, "too_many_attempts"): return "Too many tries. Send a new code."
        case .server(429, _): return sendingCode ? "Wait a minute, then ask for another code." : "Too many tries. Wait a few minutes and try again."
        case .server(400, _): return sendingCode ? "Check the email address." : "Enter the 6 digits from the email."
        case .server(503, _): return "Email sign-in isn’t available right now."
        case .server(502, _): return "Couldn’t send the code. Try again."
        case .offline: return "Couldn’t reach the server. Check your connection."
        default: return "Something went wrong. Try again."
        }
    }
}
