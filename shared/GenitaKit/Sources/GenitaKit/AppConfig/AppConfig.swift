import Foundation
import Observation

/// Server-driven config (`GET /v1/app-config`, genita-server/PROTOCOL.md "App config"): copy strings,
/// feature flags, tuning numbers, update nudges and remote asset URLs. Data only — nothing here is
/// ever executed. Every field falls back to the bundled defaults, so a missing key, a wrong type or
/// an offline first launch behaves exactly like the shipped build.
public struct GenitaAppConfig: Codable, Equatable, Sendable {
    public struct Channel: Codable, Equatable, Sendable {
        public var minBuild: Int
        public var latestBuild: Int
        public var url: URL
        public init(minBuild: Int, latestBuild: Int, url: URL) {
            self.minBuild = minBuild
            self.latestBuild = latestBuild
            self.url = url
        }
        /// `latestBuild` newer than the install → available; below `minBuild` → required. 0 = not set.
        public func nudge(installedBuild: Int?) -> UpdateNudge {
            guard let installedBuild, latestBuild > installedBuild else { return .none }
            return installedBuild < minBuild ? .required(latestBuild: latestBuild, url: url) : .available(latestBuild: latestBuild, url: url)
        }
    }
    public struct Updates: Codable, Equatable, Sendable {
        public var ios: Channel
        public var mac: Channel
    }
    public enum UpdateNudge: Equatable, Sendable {
        case none
        case available(latestBuild: Int, url: URL)
        case required(latestBuild: Int, url: URL)
    }

    public var schema: Int
    public var updates: Updates
    public var flags: [String: Bool]
    public var tuning: [String: Double]
    public var copy: [String: String]
    public var assets: [String: URL]

    public init(schema: Int = 1, updates: Updates, flags: [String: Bool], tuning: [String: Double], copy: [String: String], assets: [String: URL]) {
        self.schema = schema
        self.updates = updates
        self.flags = flags
        self.tuning = tuning
        self.copy = copy
        self.assets = assets
    }

    /// Same values as the server defaults (`genita-server/src/appconfig/appConfig.ts`); a test keeps them equal.
    public static let bundled = GenitaAppConfig(
        updates: Updates(
            ios: Channel(minBuild: 0, latestBuild: 0, url: URL(string: "https://testflight.apple.com/join/Ybqh482p")!),
            mac: Channel(minBuild: 0, latestBuild: 0, url: URL(string: "https://bagel-labs-beni.github.io/genita-legal/mac/appcast.xml")!)
        ),
        flags: ["watchReactions": true, "textChat": false, "judgeAccess": true, "interactiveSplash": true, "motion": true],
        tuning: ["bargeInMs": 400, "prepContinueAfterSceneMs": 30_000, "prepStallMs": 45_000, "firstCallWaitMs": 2_000, "updateCheckHours": 24],
        copy: [
            "update.title": "A new Genita is ready",
            "update.body": "Update to get the latest fixes.",
            "update.action": "Update",
            "update.required": "This version is no longer supported. Update to keep talking.",
            "mac.update.ready": "Update ready",
            "mac.update.restart": "Restart to update",
            "prep.title": "Bringing {name} to life",
            "prep.stage.scene": "Setting the scene",
            "prep.stage.expressions": "Learning expressions",
            "prep.stage.mouth": "Mouth",
            "call.thinking": "{name} is thinking",
        ],
        assets: [:]
    )

    public func flag(_ key: String, default fallback: Bool) -> Bool { flags[key] ?? fallback }
    public func number(_ key: String, default fallback: Double) -> Double { tuning[key] ?? fallback }
    /// Copy by key with `{name}` filled in; unknown key → `fallback` (or the key itself).
    public func text(_ key: String, name: String? = nil, default fallback: String? = nil) -> String {
        let raw = copy[key] ?? fallback ?? key
        guard let name else { return raw }
        return raw.replacingOccurrences(of: "{name}", with: name)
    }

    // MARK: tolerant decoding (each value on its own; bad ones keep the bundled value)

    private enum Keys: String, CodingKey { case schema, updates, flags, tuning, copy, assets }
    private struct AnyKey: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    public init(from decoder: Decoder) throws {
        let base = Self.bundled
        let c = try decoder.container(keyedBy: Keys.self)
        schema = (try? c.decode(Int.self, forKey: .schema)) ?? 1
        flags = base.flags.merging(Self.each(c, .flags, Bool.self), uniquingKeysWith: { $1 })
        tuning = base.tuning.merging(Self.each(c, .tuning, Double.self), uniquingKeysWith: { $1 })
        copy = base.copy.merging(Self.each(c, .copy, String.self), uniquingKeysWith: { $1 })
        let urls = Self.each(c, .assets, String.self).compactMapValues { raw -> URL? in
            guard let url = URL(string: raw), url.scheme == "https", url.host != nil else { return nil }
            return url
        }
        assets = base.assets.merging(urls, uniquingKeysWith: { $1 })
        var updates = base.updates
        if let u = try? c.nestedContainer(keyedBy: AnyKey.self, forKey: .updates) {
            if let ios = try? u.decode(Channel.self, forKey: AnyKey(stringValue: "ios")), ios.url.scheme == "https" { updates.ios = ios }
            if let mac = try? u.decode(Channel.self, forKey: AnyKey(stringValue: "mac")), mac.url.scheme == "https" { updates.mac = mac }
        }
        self.updates = updates
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(schema, forKey: .schema)
        try c.encode(updates, forKey: .updates)
        try c.encode(flags, forKey: .flags)
        try c.encode(tuning, forKey: .tuning)
        try c.encode(copy, forKey: .copy)
        try c.encode(assets.mapValues(\.absoluteString), forKey: .assets)
    }

    private static func each<T: Decodable>(_ c: KeyedDecodingContainer<Keys>, _ key: Keys, _: T.Type) -> [String: T] {
        guard let nested = try? c.nestedContainer(keyedBy: AnyKey.self, forKey: key) else { return [:] }
        var out: [String: T] = [:]
        for k in nested.allKeys { if let v = try? nested.decode(T.self, forKey: k) { out[k.stringValue] = v } }
        return out
    }
}

/// Loads `GET /v1/app-config` at launch and on foreground (at most once a minute unless forced),
/// with `If-None-Match`; keeps the last good config on disk so the next launch starts from it.
@MainActor @Observable public final class GenitaAppConfigStore {
    public typealias Fetch = @Sendable (URLRequest) async throws -> (Data, URLResponse)
    public static let shared = GenitaAppConfigStore()

    public private(set) var config: GenitaAppConfig
    @ObservationIgnored private var etag: String?
    @ObservationIgnored private var lastFetch: Date?
    @ObservationIgnored private var inFlight = false
    @ObservationIgnored private let endpoint: URL
    @ObservationIgnored private let cacheURL: URL
    @ObservationIgnored private let fetch: Fetch

    public nonisolated static var defaultCacheURL: URL {
        URL.applicationSupportDirectory.appending(path: "Genita/app-config.json")
    }

    public init(baseURL: URL = GenitaAuthClient.defaultBaseURL(), cacheURL: URL = GenitaAppConfigStore.defaultCacheURL, fetch: Fetch? = nil) {
        self.endpoint = baseURL.appending(path: "v1/app-config")
        self.cacheURL = cacheURL
        self.fetch = fetch ?? { try await URLSession.shared.data(for: $0) }
        if let data = try? Data(contentsOf: cacheURL), let cached = try? JSONDecoder().decode(Cached.self, from: data) {
            config = cached.config
            etag = cached.etag
        } else {
            config = .bundled
        }
    }

    /// Network errors, non-2xx and undecodable bodies keep the current config.
    public func refresh(force: Bool = false) async {
        if inFlight { return }
        if !force, let lastFetch, Date().timeIntervalSince(lastFetch) < 60 { return }
        inFlight = true
        defer { inFlight = false }
        lastFetch = Date()
        var request = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8)
        if let etag { request.setValue(etag, forHTTPHeaderField: "If-None-Match") }
        guard let (data, response) = try? await fetch(request), let http = response as? HTTPURLResponse else { return }
        guard http.statusCode == 200, let next = try? JSONDecoder().decode(GenitaAppConfig.self, from: data) else { return }
        etag = http.value(forHTTPHeaderField: "ETag")
        if next != config { config = next }
        try? FileManager.default.createDirectory(at: cacheURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let blob = try? JSONEncoder().encode(Cached(etag: etag, config: next)) { try? blob.write(to: cacheURL, options: .atomic) }
    }

    #if DEBUG
    /// Review screens / UI tests only: show a given config without the network.
    public func applyForReview(_ next: GenitaAppConfig) { config = next }
    #endif

    /// `CFBundleVersion` of the running app (nil if it isn't a number).
    public nonisolated static var installedBuild: Int? {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String).flatMap { Int($0) }
    }

    private struct Cached: Codable {
        var etag: String?
        var config: GenitaAppConfig
    }
}
