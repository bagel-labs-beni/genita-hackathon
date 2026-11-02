import Foundation
#if canImport(AuthenticationServices)
import AuthenticationServices

// MARK: iPhone — native Sign in with Apple

/// Usage with SwiftUI:
/// ```swift
/// @State var nonce = AuthSecret()
/// SignInWithAppleButton(.signIn) { req in nonce = AuthSecret(); AppleSignIn.prepare(req, nonce: nonce) }
///   onCompletion: { result in Task { try await AppleSignIn.complete(result, nonce: nonce, client: auth) } }
/// ```
public enum AppleSignIn {
    public static func prepare(_ request: ASAuthorizationAppleIDRequest, nonce: AuthSecret) {
        request.requestedScopes = [.fullName, .email]
        request.nonce = nonce.sha256Hex
    }

    @discardableResult
    public static func complete(_ result: Result<ASAuthorization, Error>, nonce: AuthSecret, client: GenitaAuthClient) async throws -> GenitaSignInResponse {
        let auth: ASAuthorization
        switch result {
        case .success(let a): auth = a
        case .failure(let e):
            if (e as? ASAuthorizationError)?.code == .canceled { throw GenitaAuthError.cancelled }
            throw e
        }
        guard let cred = auth.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = cred.identityToken, let identityToken = String(data: tokenData, encoding: .utf8) else { throw GenitaAuthError.badResponse }
        let code = cred.authorizationCode.flatMap { String(data: $0, encoding: .utf8) }
        return try await client.signInWithApple(identityToken: identityToken, rawNonce: nonce.raw, authorizationCode: code,
                                                givenName: cred.fullName?.givenName, familyName: cred.fullName?.familyName)
    }
}

// MARK: Mac — web Sign in with Apple (Developer ID apps can't use the native flow)

/// Opens `/auth/apple/start` in ASWebAuthenticationSession; the server sends the
/// browser back to `genita://auth?code=…`, which is exchanged with the PKCE verifier.
@MainActor
public final class WebSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let anchor: ASPresentationAnchor
    private var session: ASWebAuthenticationSession?

    public init(anchor: ASPresentationAnchor) { self.anchor = anchor }

    public nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated { anchor }
    }

    @discardableResult
    public func signIn(client: GenitaAuthClient, device: GenitaDevice = .mac) async throws -> GenitaSignInResponse {
        let verifier = AuthSecret()
        let url = client.macStartURL(challenge: verifier.sha256Base64URL, device: device)
        let callback: URL = try await withCheckedThrowingContinuation { cont in
            let s = ASWebAuthenticationSession(url: url, callbackURLScheme: AuthCallback.scheme) { url, error in
                if let url { cont.resume(returning: url); return }
                if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin { cont.resume(throwing: GenitaAuthError.cancelled); return }
                cont.resume(throwing: error ?? GenitaAuthError.badResponse)
            }
            s.presentationContextProvider = self
            session = s
            if !s.start() { cont.resume(throwing: GenitaAuthError.badResponse) }
        }
        session = nil
        switch AuthCallback.parse(callback) {
        case .code(let code)?: return try await client.exchange(code: code, verifier: verifier.raw)
        case .error("cancelled")?: throw GenitaAuthError.cancelled
        case .error(let reason)?: throw GenitaAuthError.server(status: 401, code: reason)
        case nil: throw GenitaAuthError.badResponse
        }
    }
}
#endif
