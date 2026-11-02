import AuthenticationServices
import UIKit

/// A02 "Continue with Apple" (F1-L2): the native Sign in with Apple sheet, then `POST /auth/apple`
/// through GenitaKit (`AppleSignIn.complete`). Keeps the board's own button; only the sheet is Apple's.
@MainActor final class AppleSignInFlow: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private var continuation: CheckedContinuation<ASAuthorization, Error>?
    private var controller: ASAuthorizationController?

    /// Signs in and stores the session token (keychain). Throws `GenitaAuthError.cancelled` when the user closes the sheet.
    func signIn(client: GenitaAuthClient = GenitaAuthClient()) async throws -> GenitaSignInResponse {
        let nonce = AuthSecret()
        let request = ASAuthorizationAppleIDProvider().createRequest()
        AppleSignIn.prepare(request, nonce: nonce)
        let authorization: ASAuthorization = try await withCheckedThrowingContinuation { cont in
            continuation = cont
            let c = ASAuthorizationController(authorizationRequests: [request])
            c.delegate = self
            c.presentationContextProvider = self
            controller = c
            c.performRequests()
        }
        controller = nil
        return try await AppleSignIn.complete(.success(authorization), nonce: nonce, client: client)
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        MainActor.assumeIsolated {
            continuation?.resume(returning: authorization)
            continuation = nil
        }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        MainActor.assumeIsolated {
            let cancelled = (error as? ASAuthorizationError)?.code == .canceled
            continuation?.resume(throwing: cancelled ? GenitaAuthError.cancelled : error)
            continuation = nil
        }
    }

    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
        }
    }
}
