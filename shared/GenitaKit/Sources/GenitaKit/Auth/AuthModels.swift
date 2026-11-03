import Foundation

/// Wire types for genita-server accounts (genita-server/src/auth/routes.ts).
public enum GenitaDevice: String, Codable, Sendable { case iphone, mac }

public struct GenitaMe: Codable, Equatable, Sendable {
    public struct User: Codable, Equatable, Sendable {
        public var id: String
        public var provider: String
        public var email: String?
        public var displayName: String?
        public var aiConsentAt: String?
        public var createdAt: String
    }
    public struct Conversation: Codable, Equatable, Sendable {
        /// "iphone" | "mac" | nil — which device holds the sound (F6 conversation layer)
        public var activeDevice: String?
        public var epoch: Int
    }
    public enum PrepStatus: String, Codable, Sendable { case none, running, ready, failed }

    public var user: User
    public var consented: Bool
    public var hasCompanion: Bool
    public var prepStatus: PrepStatus
    public var conversation: Conversation?
    /// the account's companion is the ready-made judge one (PR #178)
    public var companionDemo: Bool?

    public init(user: User, consented: Bool, hasCompanion: Bool, prepStatus: PrepStatus, conversation: Conversation?, companionDemo: Bool? = nil) {
        self.user = user
        self.consented = consented
        self.hasCompanion = hasCompanion
        self.prepStatus = prepStatus
        self.conversation = conversation
        self.companionDemo = companionDemo
    }
}

/// `POST /auth/apple` and `POST /auth/exchange` reply: the session token plus the `/me` view.
public struct GenitaSignInResponse: Decodable, Sendable {
    public var token: String
    public var expiresAt: String
    public var isNew: Bool
    public var me: GenitaMe

    enum CodingKeys: String, CodingKey { case token, expiresAt, isNew }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        token = try c.decode(String.self, forKey: .token)
        expiresAt = try c.decode(String.self, forKey: .expiresAt)
        isNew = try c.decode(Bool.self, forKey: .isNew)
        me = try GenitaMe(from: decoder)
    }
}

/// `POST /auth/email/start` reply.
public struct GenitaEmailStart: Decodable, Equatable, Sendable {
    public var ok: Bool
    public var expiresInSec: Int
    public var resendAfterSec: Int
    public init(ok: Bool, expiresInSec: Int, resendAfterSec: Int) {
        self.ok = ok
        self.expiresInSec = expiresInSec
        self.resendAfterSec = resendAfterSec
    }
}

public struct GenitaDeleteResult: Decodable, Equatable, Sendable {
    public var deleted: Bool
    public var appleRevoked: Bool?
    public var blobsDeleted: Int
}

public enum GenitaAuthError: Error, Equatable, Sendable {
    /// 401: no/expired/revoked session → A02
    case unauthorized
    /// 403 consent_required → CS01
    case consentRequired
    /// no connection → A02-E
    case offline
    /// Mac web login: the user closed the sheet
    case cancelled
    /// `retryAfterSec`: a 429's wait (body `retryAfterSec`, else the Retry-After header), nil when the server gave none
    case server(status: Int, code: String?, retryAfterSec: Int? = nil)
    case badResponse
}
