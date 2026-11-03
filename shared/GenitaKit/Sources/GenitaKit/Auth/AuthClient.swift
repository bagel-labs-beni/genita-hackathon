import Foundation
import CryptoKit
import Security

/// F1-L7 · app side of genita-server accounts. Keeps the session JWT in the
/// token store; a 401 clears its matching session (the app routes to A02). Also hands the
/// token to the realtime call (`Authorization: Bearer`, F1-L5).
public final class GenitaAuthClient: @unchecked Sendable {
    public let baseURL: URL
    public let store: GenitaTokenStore
    private let http: URLSession

    public init(baseURL: URL = GenitaAuthClient.defaultBaseURL(), store: GenitaTokenStore = KeychainTokenStore(), session: URLSession = .shared) {
        self.baseURL = baseURL
        self.store = store
        self.http = session
    }

    /// GENITA_API_URL env → `genita.api.url` default → production host.
    public static func defaultBaseURL(environment: [String: String] = ProcessInfo.processInfo.environment, defaults: UserDefaults = .standard) -> URL {
        // the deployed server (AWS CloudFront, deploy/aws); same host as the call socket
        let raw = environment["GENITA_API_URL"] ?? defaults.string(forKey: "genita.api.url") ?? "https://d72kt0jfmscyj.cloudfront.net"
        return URL(string: raw) ?? URL(string: "https://d72kt0jfmscyj.cloudfront.net")!
    }

    /// The bearer for `wss://…/v1/session`.
    public var token: String? { store.load() }
    public var isSignedIn: Bool { store.load() != nil }

    // MARK: sign in

    /// iPhone: after `ASAuthorizationAppleIDCredential` (see AppleSignIn.swift).
    @discardableResult
    public func signInWithApple(identityToken: String, rawNonce: String, authorizationCode: String?, givenName: String?, familyName: String?, device: GenitaDevice = .iphone) async throws -> GenitaSignInResponse {
        var body: [String: Any] = ["identityToken": identityToken, "nonce": rawNonce, "device": device.rawValue]
        if let authorizationCode { body["authorizationCode"] = authorizationCode }
        var name: [String: String] = [:]
        if let givenName, !givenName.isEmpty { name["givenName"] = givenName }
        if let familyName, !familyName.isEmpty { name["familyName"] = familyName }
        if !name.isEmpty { body["fullName"] = name }
        let r: GenitaSignInResponse = try await send("POST", "/auth/apple", json: body, authorized: false)
        store.save(r.token)
        return r
    }

    /// Email sign-in, step 1: the server mails a 6-digit code (same answer whether or not an account exists).
    /// Too soon / too many = `.server(status: 429, code: "rate_limited")`; mail off = `.server(status: 503, …)`.
    @discardableResult
    public func startEmailSignIn(email: String) async throws -> GenitaEmailStart {
        try await send("POST", "/auth/email/start", json: ["email": email.trimmingCharacters(in: .whitespacesAndNewlines)], authorized: false)
    }

    /// Email sign-in, step 2: the code → the same session as Apple. Wrong / expired code = `.unauthorized`
    /// (nothing stored); 5 wrong tries = `.server(status: 429, code: "too_many_attempts")`.
    @discardableResult
    public func signInWithEmailCode(email: String, code: String, device: GenitaDevice = .iphone) async throws -> GenitaSignInResponse {
        let body = ["email": email.trimmingCharacters(in: .whitespacesAndNewlines), "code": code.trimmingCharacters(in: .whitespacesAndNewlines), "device": device.rawValue]
        let r: GenitaSignInResponse = try await send("POST", "/auth/email/verify", json: body, authorized: false)
        store.save(r.token)
        return r
    }

    /// Enough to enable "Send code" (the server has the final say).
    public static func looksLikeEmail(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).range(of: #"^[^\s@]+@[^\s@]+\.[^\s@]+$"#, options: .regularExpression) != nil
    }

    /// Mac: the URL ASWebAuthenticationSession opens (server 302s to Apple).
    public func macStartURL(challenge: String, device: GenitaDevice = .mac) -> URL {
        var c = URLComponents(url: baseURL.appendingPathComponent("auth/apple/start"), resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "challenge", value: challenge), URLQueryItem(name: "device", value: device.rawValue)]
        return c.url!
    }

    /// Mac: one-time code from `genita://auth?code=…` + the PKCE verifier → session.
    @discardableResult
    public func exchange(code: String, verifier: String) async throws -> GenitaSignInResponse {
        let r: GenitaSignInResponse = try await send("POST", "/auth/exchange", json: ["code": code, "verifier": verifier], authorized: false)
        store.save(r.token)
        return r
    }

    // MARK: account

    public func me() async throws -> GenitaMe { try await send("GET", "/me") }

    /// Never throws: signed out / expired / offline / active, for StartRouter.
    public func sessionState() async -> GenitaSessionState {
        guard isSignedIn else { return .signedOut }
        do { return .active(try await me()) } catch GenitaAuthError.unauthorized { return .expired } catch GenitaAuthError.offline { return .offline } catch { return .offline }
    }

    @discardableResult public func consent(version: String = "v1") async throws -> GenitaMe {
        try await send("POST", "/me/consent", json: ["kind": "ai_data", "version": version])
    }

    @discardableResult public func setName(_ name: String) async throws -> GenitaMe {
        try await send("PATCH", "/me", json: ["displayName": name])
    }

    /// Best effort on the server; the local token is always cleared.
    public func logout() async {
        _ = try? await send("POST", "/auth/logout", json: [:]) as EmptyReply
        store.clear()
    }

    /// Server revokes Apple, deletes files and rows. Clears the token on success.
    public func deleteAccount() async throws -> GenitaDeleteResult {
        let r: GenitaDeleteResult = try await send("DELETE", "/me")
        store.clear()
        return r
    }

    // MARK: transport

    struct EmptyReply: Decodable {}
    private struct ErrorReply: Decodable { var error: String? }

    /// Shared transport for the account and onboarding calls (OnboardingClient): bearer from the store,
    /// 401 clears the matching sent token, 403 consent_required and offline are typed. `query` is appended as-is ("rights=1").
    func send<T: Decodable>(_ method: String, _ path: String, json: [String: Any]? = nil, body: Data? = nil, contentType: String? = nil,
                            query: String? = nil, timeout: TimeInterval = 20, authorized: Bool = true) async throws -> T {
        let data = try await sendData(method, path, json: json, body: body, contentType: contentType, query: query, timeout: timeout, authorized: authorized)
        do { return try JSONDecoder().decode(T.self, from: data) } catch { throw GenitaAuthError.badResponse }
    }

    /// Same transport, raw bytes back (V04 voice previews are `audio/wav`).
    func sendData(_ method: String, _ path: String, json: [String: Any]? = nil, body: Data? = nil, contentType: String? = nil,
                  query: String? = nil, timeout: TimeInterval = 20, authorized: Bool = true) async throws -> Data {
        var url = baseURL.appendingPathComponent(String(path.dropFirst()))
        if let query, var c = URLComponents(url: url, resolvingAgainstBaseURL: false) { c.percentEncodedQuery = query; url = c.url ?? url }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = timeout
        if let json {
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = try JSONSerialization.data(withJSONObject: json)
        } else if let body {
            req.setValue(contentType ?? "application/octet-stream", forHTTPHeaderField: "content-type")
            req.httpBody = body
        }
        let sentToken: String?
        if authorized {
            guard let token = store.load() else { throw GenitaAuthError.unauthorized }
            sentToken = token
            req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        } else {
            sentToken = nil
        }
        let data: Data, response: URLResponse
        do { (data, response) = try await http.data(for: req) } catch let e as URLError where [.notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost, .timedOut, .dataNotAllowed].contains(e.code) {
            throw GenitaAuthError.offline
        }
        guard let status = (response as? HTTPURLResponse)?.statusCode else { throw GenitaAuthError.badResponse }
        if status == 401 {
            if let sentToken { store.clear(ifMatching: sentToken) }
            throw GenitaAuthError.unauthorized
        }
        let code = (try? JSONDecoder().decode(ErrorReply.self, from: data))?.error
        if status == 403, code == "consent_required" { throw GenitaAuthError.consentRequired }
        guard (200..<300).contains(status) else { throw GenitaAuthError.server(status: status, code: code) }
        return data
    }
}

/// Random secret + its digest, for Apple's nonce (sha256 hex) and PKCE (sha256 base64url).
public struct AuthSecret: Sendable {
    public let raw: String
    public init(raw: String? = nil) {
        if let raw { self.raw = raw; return }
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        self.raw = Data(bytes).genitaBase64URL
    }
    /// what goes into `ASAuthorizationAppleIDRequest.nonce` (server checks sha256 hex of `raw`)
    public var sha256Hex: String { SHA256.hash(data: Data(raw.utf8)).map { String(format: "%02x", $0) }.joined() }
    /// PKCE S256 challenge for `/auth/apple/start`
    public var sha256Base64URL: String { Data(SHA256.hash(data: Data(raw.utf8))).genitaBase64URL }
}

/// `genita://auth?code=…` | `genita://auth?error=…`
public enum AuthCallback: Equatable, Sendable {
    case code(String)
    case error(String)

    public static let scheme = "genita"

    public static func parse(_ url: URL) -> AuthCallback? {
        guard url.scheme == scheme, url.host == "auth", let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        if let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty { return .code(code) }
        if let error = items.first(where: { $0.name == "error" })?.value { return .error(error) }
        return nil
    }
}

extension Data {
    var genitaBase64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
