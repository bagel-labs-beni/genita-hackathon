import CoreGraphics
import CryptoKit
import Foundation
import SwiftUI

/// L4 · The companion's animated Meta face on the call screen (docs/specs/metaface.md "App").
enum CompanionFace {
    /// `GENITA_CLIP_LOOP_FACE=1` (launch env, or an Info.plist bool): the earlier silent video loop instead of
    /// the Meta face. Off by default.
    static var clipLoopFace: Bool {
        flag(ProcessInfo.processInfo.environment["GENITA_CLIP_LOOP_FACE"]) ?? flag(Bundle.main.object(forInfoDictionaryKey: "GENITA_CLIP_LOOP_FACE")) ?? false
    }

    static func flag(_ value: Any?) -> Bool? {
        switch value {
        case let b as Bool: b
        case let n as NSNumber: n.boolValue
        case let s as String: ["1", "true", "yes", "on"].contains(s.lowercased())
        default: nil
        }
    }

    /// Rendered height in pixels: the 844 pt board at 2×. Never above the face set's own pixels.
    static let pixelHeight: CGFloat = 1688

    /// Frame size for a face set: its own aspect, `pixelHeight` tall (the view aspect-fills it like the still).
    static func outputSize(for set: FaceSet, pixelHeight: CGFloat = pixelHeight) -> CGSize {
        let h = min(pixelHeight, set.pixelSize.height)
        return CGSize(width: (h * set.pixelSize.width / set.pixelSize.height).rounded(), height: h)
    }
}

/// Draws the face driver's latest frame above the still, aspect-filled like the still. Layers (face → mouth →
/// blink) are composed inside the renderer. `still` (UI review stills) is drawn instead when given.
struct FaceFrameView: View {
    @ObservedObject var driver: FaceDriver
    var still: CGImage?
    var body: some View {
        ZStack {
            if let image = still ?? driver.frame {
                Image(decorative: image, scale: 1).resizable().scaledToFill()
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// Loads the companion's face set from `GET /v1/companion/prep` → `face` (PREP_API.md): the manifest, then
/// its images (`GET /v1/companion/face/{key}`) with the call's bearer token, cached in Caches by account +
/// manifest, decoded and aligned off the main thread.
///
/// Threat line: caller = the app · auth = the existing session JWT (`Authorization: Bearer`, same as the call
/// socket) · abuse = read-only, the caller's own companion; image refs on another host are never fetched, so
/// the token never leaves the session's host · data = the companion's own images.
struct CompanionFaceLoader: Sendable {
    typealias Fetch = @Sendable (URLRequest) async throws -> (Data, URLResponse)
    enum Outcome { case none, unchanged, loaded(key: String, set: FaceSet) }
    enum LoadError: Error, Equatable { case status(String, Int), foreignHost(String), missingNeutral }

    var endpoint: CallEndpoint
    var cacheRoot: URL
    var fetch: Fetch

    static var defaultCacheRoot: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appending(path: "genita-face", directoryHint: .isDirectory)
    }

    init(endpoint: CallEndpoint, cacheRoot: URL = Self.defaultCacheRoot, fetch: @escaping Fetch = { try await URLSession.shared.data(for: $0) }) {
        self.endpoint = endpoint
        self.cacheRoot = cacheRoot
        self.fetch = fetch
    }

    /// `.none` = no token, no prep or no face yet (the still stays); `.unchanged` = `currentKey` is still current.
    func load(currentKey: String?) async throws -> Outcome {
        guard let token = endpoint.token, !token.isEmpty, let base = Self.httpBase(of: endpoint.url) else { return .none }
        let body: Data
        do { body = try await get(base.appending(path: "v1/companion/prep"), token: token, what: "prep").0 }
        catch LoadError.status(_, 404) { return .none }   // no companion on this account
        guard let manifest = (try? JSONDecoder().decode(Prep.self, from: body))?.face else { return .none }
        let key = Self.cacheKey(subject: CallController.tokenSubject(token) ?? "anon", manifest: manifest)
        if key == currentKey { return .unchanged }

        // Every image the manifest names, by its manifest key (also the cache file name).
        var refs: [String: String] = [:]
        for (k, ref) in manifest.images.merging(manifest.visemes, uniquingKeysWith: { a, _ in a }) where Self.safeName(k) { refs[k] = ref }
        // Option B flow morph files (#226): extension-less refs, decoded by role (key image, f16 flow, lip /
        // interior masks, …). Every file the entry names is fetched, so a role GenitaKit adds later comes along.
        var flowNames: Set<String> = []
        if let flow = manifest.flow {
            for (k, f) in flow.files where Self.safeName(k) {
                for child in Mirror(reflecting: f).children {
                    guard let role = child.label, let ref = child.value as? String else { continue }   // 2D snap faces have no flows
                    refs["flow\(k)\(role)"] = ref; flowNames.insert("flow\(k)\(role)")
                }
            }
            refs["flowmask"] = flow.mask; flowNames.insert("flowmask")
            if let n = flow.neutralRoi { refs["flowneutral"] = n; flowNames.insert("flowneutral") }
        }
        guard let neutralRef = refs["neutral"] else { throw LoadError.missingNeutral }
        let dir = cacheRoot.appending(path: key, directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var bytes: [String: Data] = [:]   // ref → image bytes
        try await withThrowingTaskGroup(of: (String, Data?).self) { group in
            for (k, ref) in refs {
                group.addTask {
                    let file = dir.appending(path: k)
                    if let cached = try? Data(contentsOf: file), !cached.isEmpty { return (ref, cached) }
                    do {
                        let url = try Self.resolve(ref, base: base)
                        let (data, _) = try await get(url, token: token, what: k)
                        try? data.write(to: file, options: .atomic)
                        return (ref, data)
                    } catch {
                        // A rejected or missing image: the face set falls back to its nearest shape.
                        if k == "neutral" { throw error }
                        return (ref, nil)
                    }
                }
            }
            for try await (ref, data) in group { if let data { bytes[ref] = data } }
        }
        guard bytes[neutralRef] != nil else { throw LoadError.missingNeutral }
        Self.prune(cacheRoot, keeping: key)
        let images = bytes
        // A flow set with any file missing is dropped as a whole: the face uses its key patches.
        var useManifest = manifest
        if !flowNames.isEmpty, flowNames.contains(where: { refs[$0].map { images[$0] == nil } ?? true }) { useManifest.flow = nil }
        let finalManifest = useManifest
        let set = try await Task.detached(priority: .userInitiated) {
            FaceSet.onDevicePersonMask = true   // still background: only the person moves (no prep mask → Vision)
            return try FaceSet(manifest: finalManifest) { ref in
                guard let data = images[ref] else { throw FaceSetError.undecodable(ref) }
                return data
            }
        }.value
        return .loaded(key: key, set: set)
    }

    private struct Prep: Decodable {
        var face: FaceManifest?
        enum CodingKeys: CodingKey { case face }
        init(from decoder: Decoder) throws {
            // A face the app can't read is treated as no face: the still stays.
            face = try? decoder.container(keyedBy: CodingKeys.self).decodeIfPresent(FaceManifest.self, forKey: .face)
        }
    }

    private func get(_ url: URL, token: String, what: String) async throws -> (Data, URLResponse) {
        var req = URLRequest(url: url, timeoutInterval: 30)
        req.httpMethod = "GET"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, res) = try await fetch(req)
        let status = (res as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw LoadError.status(what, status) }
        return (data, res)
    }

    /// `wss://host/v1/session` → `https://host`.
    static func httpBase(of socket: URL) -> URL? {
        guard var c = URLComponents(url: socket, resolvingAgainstBaseURL: false) else { return nil }
        c.scheme = c.scheme == "wss" || c.scheme == "https" ? "https" : "http"
        c.path = ""; c.query = nil; c.fragment = nil
        return c.url
    }

    /// A manifest ref relative to the session host. Absolute refs must stay on that host (scheme, host, port).
    static func resolve(_ ref: String, base: URL) throws -> URL {
        guard let url = URL(string: ref, relativeTo: base)?.absoluteURL,
              url.scheme == base.scheme, url.host() == base.host(), url.port == base.port
        else { throw LoadError.foreignHost(ref) }
        return url
    }

    static func safeName(_ key: String) -> Bool {
        !key.isEmpty && key.count <= 32 && key.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber) }
    }

    /// Account + manifest version + manifest digest: a re-made companion (new boxes, new images) gets a new key.
    static func cacheKey(subject: String, manifest: FaceManifest) -> String {
        let enc = JSONEncoder()
        enc.outputFormatting = .sortedKeys
        let json = (try? enc.encode(manifest)) ?? Data()
        let digest = SHA256.hash(data: Data(subject.utf8) + Data([0]) + json)
        return "v\(manifest.version ?? 0)-" + digest.prefix(12).map { String(format: "%02x", $0) }.joined()
    }

    /// One face set on disk at a time (~3 MB); older manifests and other accounts' sets go.
    static func prune(_ root: URL, keeping key: String) {
        let fm = FileManager.default
        for url in (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? [] where url.lastPathComponent != key {
            try? fm.removeItem(at: url)
        }
    }
}
