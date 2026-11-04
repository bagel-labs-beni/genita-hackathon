import CoreGraphics
import CryptoKit
import Foundation
import ImageIO
import SwiftUI

/// L4 · The companion's animated Meta face on the call screen (docs/specs/metaface.md "App").
enum CompanionFace {
    /// S09-P reveal (D28): the face set that lands mid-call fades in over the still once.
    static let revealCurve: Animation = .easeInOut(duration: 0.6)
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
    /// Mac: the call window is the phone's physical size, ~725–760 pt tall on a MacBook = ≤ 1520 px at 2×; rendering
    /// 1688 there only cost CPU (the flow morph scales with the square of this).
    #if os(macOS)
    static let pixelHeight: CGFloat = 1520
    #else
    static let pixelHeight: CGFloat = 1688
    #endif

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
    /// The fps line shows only with GENITA_SHOW_FPS=1 or the user default genita.showFaceFPS = true.
    static let showFPS: Bool = {
        let env = ProcessInfo.processInfo.environment["GENITA_SHOW_FPS"]
        if let env { return env == "1" }
        if UserDefaults.standard.object(forKey: "genita.showFaceFPS") != nil { return UserDefaults.standard.bool(forKey: "genita.showFaceFPS") }
        return false   // off by default: the demo is filmed on a TestFlight build (FACE_FPS log stays on)
    }()
    var body: some View {
        ZStack(alignment: .topLeading) {
            if let image = still ?? driver.frame {
                Image(decorative: image, scale: 1).resizable().scaledToFill()
            }
            if Self.showFPS, still == nil, driver.liveFPS > 0 {
                // device QA (TestFlight): the face's real frame rate, one small line
                Text(String(format: "face %.1f fps", driver.liveFPS))
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.8))
                    .padding(.horizontal, 4).padding(.vertical, 2)
                    .background(.black.opacity(0.35), in: RoundedRectangle(cornerRadius: 3))
                    .padding(.top, 60).padding(.leading, 8)
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
/// Face plan items 2 + 6 (11/4): with an `early` consumer, a returning account gets the face it saw last straight
/// from Caches — its rest-frame poster (PNG), then the set — before `/prep` is asked; `/prep` then only says whether
/// it changed. A flow face never downloads the 10 viseme stills (the flow morph draws every mouth), and on a first
/// download the set is built from neutral + person + flow as soon as they land; the expression stills follow and
/// the full set replaces it.
///
/// Threat line: caller = the app · auth = the existing session JWT (`Authorization: Bearer`, same as the call
/// socket) · abuse = read-only, the caller's own companion; image refs on another host are never fetched, so
/// the token never leaves the session's host · data = the companion's own images, cached per account (another
/// account's token never matches a cached key, and only one set is kept).
struct CompanionFaceLoader: Sendable {
    typealias Fetch = @Sendable (URLRequest) async throws -> (Data, URLResponse)
    /// `.pending`: the account's companion exists but its face set isn't made yet (prep still running).
    enum Outcome { case none, pending, unchanged, loaded(key: String, set: FaceSet) }
    enum LoadError: Error, Equatable { case status(String, Int), foreignHost(String), missingNeutral }
    /// What comes before the final outcome. `true` back from the consumer = it is on screen now.
    enum Early: @unchecked Sendable {
        /// The rest frame saved for this account's last face set (drawn at the consumer's reduce-motion setting).
        case poster(key: String, image: CGImage)
        /// A drawable set: the one on disk (key = its cache key), or the first-download set without the expression
        /// stills (key = cache key + `partialSuffix`, so the next load still finishes it).
        case face(key: String, set: FaceSet)
    }
    typealias EarlyConsumer = @Sendable (Early) async -> Bool
    static let partialSuffix = "+partial"

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

    /// `.none` = no token or no companion (the still stays); `.pending` = the face isn't made yet;
    /// `.unchanged` = `currentKey` (or the set handed to `early` from disk) is still current.
    /// `posterReduceMotion` picks which saved poster `early` gets; `timing` collects the face.timing marks.
    func load(currentKey: String?, posterReduceMotion: Bool = false, timing: FaceLoadTiming? = nil, early: EarlyConsumer? = nil) async throws -> Outcome {
        guard let token = endpoint.token, !token.isEmpty, let base = Self.httpBase(of: endpoint.url) else { return .none }
        let subject = CallController.tokenSubject(token) ?? "anon"
        // 1. Item 2: the set this account had last, from Caches, before any request.
        var shownKey = currentKey
        if let early, let disk = Self.diskManifest(root: cacheRoot, subject: subject), disk.key != currentKey {
            if let poster = Self.loadPoster(root: cacheRoot, key: disk.key, reduceMotion: posterReduceMotion) {
                if await early(.poster(key: disk.key, image: poster)) { timing?.mark("poster", note: "disk") }
            }
            let dir = cacheRoot.appending(path: disk.key, directoryHint: .isDirectory)
            let parts = Self.parts(of: disk.manifest)
            let bytes = Self.diskBytes(parts.all(withVisemes: true), dir: dir)
            if let set = try? await Self.makeSet(disk.manifest, parts: parts, bytes: bytes, withVisemes: !parts.flowComplete(bytes)) {
                timing?.mark("compute", note: "disk")
                if await early(.face(key: disk.key, set: set)) { shownKey = disk.key }
            }
            guard !Task.isCancelled else { return .unchanged }
        }

        // 2. /prep: is that still the face?
        let body: Data
        do { body = try await get(base.appending(path: "v1/companion/prep"), token: token, what: "prep").0 }
        catch LoadError.status(_, 404) { return .none }   // no companion on this account
        timing?.mark("prep")
        guard let prep = try? JSONDecoder().decode(Prep.self, from: body), !prep.unreadable else { return .none }
        // prep still running: the face comes later; prep failed (PREP-1e): nothing comes until a Try again
        guard let manifest = prep.face else { return prep.status == "failed" ? .none : .pending }
        let key = Self.cacheKey(subject: subject, manifest: manifest)
        if key == shownKey { return .unchanged }

        // 3. Download. Every image the manifest names, by its manifest key (also the cache file name).
        let parts = Self.parts(of: manifest)
        guard parts.images["neutral"] != nil else { throw LoadError.missingNeutral }
        let dir = cacheRoot.appending(path: key, directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        // Item 6: neutral + person + flow first. The expression stills come after, unless they're on disk already
        // (one build then) or nobody draws the early set.
        let laterOnDisk = parts.later.keys.allSatisfy { Self.cached(dir.appending(path: $0)) != nil }
        let staged = early != nil && parts.flow != nil && !laterOnDisk
        var bytes = try await fetchAll(staged ? parts.first : parts.all(withVisemes: false), dir: dir, base: base, token: token)
        Self.prune(cacheRoot, keeping: key)
        // a flow set with a file missing is dropped: the face needs its viseme stills after all
        var withVisemes = !parts.flowComplete(bytes)
        if withVisemes { bytes.merge(try await fetchAll(parts.visemes, dir: dir, base: base, token: token)) { a, _ in a } }
        timing?.mark("download")
        guard bytes[parts.images["neutral"]!] != nil else { throw LoadError.missingNeutral }
        var set = try await Self.makeSet(manifest, parts: parts, bytes: bytes, withVisemes: withVisemes)
        if set.flow == nil, !withVisemes {
            // the flow files came but didn't decode (FaceSet note "flow: … → key patches"): same fallback
            withVisemes = true
            bytes.merge(try await fetchAll(parts.visemes, dir: dir, base: base, token: token)) { a, _ in a }
            set = try await Self.makeSet(manifest, parts: parts, bytes: bytes, withVisemes: true)
        }
        timing?.mark("compute")
        if staged {
            _ = await early?(.face(key: key + Self.partialSuffix, set: set))
            guard !Task.isCancelled else { return .unchanged }
            bytes.merge(try await fetchAll(parts.later, dir: dir, base: base, token: token)) { a, _ in a }
            timing?.mark("expressions")
            set = try await Self.makeSet(manifest, parts: parts, bytes: bytes, withVisemes: withVisemes, priority: .utility)
        }
        // the whole set is on disk: the next launch starts from it (manifest.json last, so its presence means done)
        try? Data(Self.ownerTag(subject).utf8).write(to: dir.appending(path: Self.ownerFile), options: .atomic)
        if let json = try? JSONEncoder().encode(manifest) { try? json.write(to: dir.appending(path: Self.manifestFile), options: .atomic) }
        return .loaded(key: key, set: set)
    }

    private struct Prep: Decodable {
        var face: FaceManifest?
        /// running | ready | failed
        var status: String?
        /// The server named a face the app can't read: the still stays (and asking again won't change that).
        var unreadable = false
        enum CodingKeys: CodingKey { case face, status }
        init(from decoder: Decoder) throws {
            // A face the app can't read is treated as no face: the still stays.
            let c = try? decoder.container(keyedBy: CodingKeys.self)
            status = try? c?.decodeIfPresent(String.self, forKey: .status)
            face = try? c?.decodeIfPresent(FaceManifest.self, forKey: .face)
            if face == nil, let c, c.contains(.face), (try? c.decodeNil(forKey: .face)) == false { unreadable = true }
        }
    }

    /// A manifest's files by manifest key (= cache file name) → ref, in the order the face needs them.
    struct Parts {
        /// neutral, person and any other image that isn't an expression still
        var images: [String: String] = [:]
        /// blink, smile, warm, surprised, concerned (only shown later in a call)
        var later: [String: String] = [:]
        var visemes: [String: String] = [:]
        /// Option B flow morph files (#226), nil without a flow block
        var flow: [String: String]?
        /// what has to land before the first set can be built
        var first: [String: String] { images.merging(flow ?? [:]) { a, _ in a } }
        func all(withVisemes: Bool) -> [String: String] {
            first.merging(later) { a, _ in a }.merging(withVisemes ? visemes : [:]) { a, _ in a }
        }
        /// every flow file is there (no flow block = nothing to draw with)
        func flowComplete(_ bytes: [String: Data]) -> Bool {
            guard let flow, !flow.isEmpty else { return false }
            return flow.values.allSatisfy { bytes[$0] != nil }
        }
    }

    static let expressionKeys: Set<String> = Set(FaceExpression.allCases.map(\.rawValue)).subtracting(["neutral"])

    static func parts(of manifest: FaceManifest) -> Parts {
        var p = Parts()
        for (k, ref) in manifest.images where safeName(k) {
            if expressionKeys.contains(k) { p.later[k] = ref } else { p.images[k] = ref }
        }
        for (k, ref) in manifest.visemes where safeName(k) && p.images[k] == nil && p.later[k] == nil { p.visemes[k] = ref }
        // extension-less refs, decoded by role (key image, f16 flow, lip / interior masks, …). Every file the entry
        // names is fetched, so a role GenitaKit adds later comes along.
        if let flow = manifest.flow {
            var f: [String: String] = [:]
            for (k, files) in flow.files where safeName(k) {
                for child in Mirror(reflecting: files).children {
                    guard let role = child.label, let ref = child.value as? String else { continue }   // 2D snap faces have no flows
                    f["flow\(k)\(role)"] = ref
                }
            }
            f["flowmask"] = flow.mask
            if let n = flow.neutralRoi { f["flowneutral"] = n }
            p.flow = f
        }
        return p
    }

    /// Builds the set off the main thread. A flow set with any file missing is dropped as a whole (the face uses its
    /// key patches); `withVisemes: false` (flow faces) leaves the viseme stills out — the renderer never draws them.
    static func makeSet(_ manifest: FaceManifest, parts: Parts, bytes: [String: Data], withVisemes: Bool,
                        priority: TaskPriority = .userInitiated) async throws -> FaceSet {
        var m = manifest
        if !parts.flowComplete(bytes) { m.flow = nil }
        if !withVisemes { m.visemes = [:] }
        let use = m
        return try await Task.detached(priority: priority) {
            try FaceSet(manifest: use) { ref in
                guard let data = bytes[ref] else { throw FaceSetError.undecodable(ref) }
                return data
            }
        }.value
    }

    /// ref → bytes for `refs` (manifest key → ref): Caches first, else the server. A missing image other than
    /// neutral falls back to its nearest shape in the set.
    private func fetchAll(_ refs: [String: String], dir: URL, base: URL, token: String) async throws -> [String: Data] {
        var bytes: [String: Data] = [:]
        try await withThrowingTaskGroup(of: (String, Data?).self) { group in
            for (k, ref) in refs {
                group.addTask {
                    let file = dir.appending(path: k)
                    if let cached = Self.cached(file) { return (ref, cached) }
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
        return bytes
    }

    private static func cached(_ file: URL) -> Data? {
        guard let data = try? Data(contentsOf: file), !data.isEmpty else { return nil }
        return data
    }

    /// ref → bytes from the cache folder only (no request).
    static func diskBytes(_ refs: [String: String], dir: URL) -> [String: Data] {
        var out: [String: Data] = [:]
        for (k, ref) in refs { if let d = cached(dir.appending(path: k)) { out[ref] = d } }
        return out
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

    /// A cache folder name `cacheKey` made (never a path out of the cache).
    static func isCacheKey(_ key: String) -> Bool {
        !key.isEmpty && key.count <= 48 && key.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
    }

    static let manifestFile = "manifest.json"
    static let ownerFile = "owner"

    /// Which account a cache folder belongs to, without the account id itself on disk.
    static func ownerTag(_ subject: String) -> String {
        SHA256.hash(data: Data("genita-face-owner".utf8) + Data([0]) + Data(subject.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// The fully downloaded set this account had last: its folder holds `manifest.json` and this account's owner tag;
    /// the folder's name is the key `cacheKey` gave it (another account's token never matches either).
    static func diskManifest(root: URL, subject: String) -> (key: String, manifest: FaceManifest)? {
        let tag = Data(ownerTag(subject).utf8)
        for dir in (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? [] {
            let name = dir.lastPathComponent
            guard isCacheKey(name), cached(dir.appending(path: ownerFile)) == tag, let data = cached(dir.appending(path: manifestFile)),
                  let m = try? JSONDecoder().decode(FaceManifest.self, from: data) else { continue }
            return (name, m)
        }
        return nil
    }

    // MARK: poster (face plan item 2)

    /// `<root>/<key>/poster-rm0.png` (rm1 = drawn with reduce motion). nil for anything but a cache key.
    static func posterURL(root: URL, key: String, reduceMotion: Bool) -> URL? {
        let k = key.replacingOccurrences(of: partialSuffix, with: "")
        guard isCacheKey(k) else { return nil }
        return root.appending(path: k, directoryHint: .isDirectory).appending(path: "poster-rm\(reduceMotion ? 1 : 0).png")
    }

    /// Keeps the rendered rest frame next to its set (PNG). Only into a folder the loader made for that key, so
    /// review keys ("dir:…") and pruned sets write nothing.
    static func savePoster(_ image: CGImage, root: URL, key: String, reduceMotion: Bool) {
        guard let url = posterURL(root: root, key: key, reduceMotion: reduceMotion),
              FileManager.default.fileExists(atPath: url.deletingLastPathComponent().path) else { return }
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil) else { return }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else { return }
        try? (data as Data).write(to: url, options: .atomic)
    }

    static func loadPoster(root: URL, key: String, reduceMotion: Bool) -> CGImage? {
        guard let url = posterURL(root: root, key: key, reduceMotion: reduceMotion), let data = cached(url),
              let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
    }

    /// One face set on disk at a time (~7.5 MB for a person face with flow: 91 files, measured on prod 11/4; ~4.7 MB
    /// now that flow faces skip the viseme stills); older manifests and other accounts' sets go.
    static func prune(_ root: URL, keeping key: String) {
        let fm = FileManager.default
        for url in (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? [] where url.lastPathComponent != key {
            try? fm.removeItem(at: url)
        }
    }
}

/// #645 part 1: milliseconds from the start of one face load to each step, logged as one `face.timing` line
/// (prep, download, compute, renderer, poster, firstFrame; a step's first time only, "(disk)" when it came from Caches).
final class FaceLoadTiming: @unchecked Sendable {
    private let lock = NSLock()
    private let start = CFAbsoluteTimeGetCurrent()
    private var marks: [(name: String, ms: Int, note: String?)] = []
    private var logged = false

    func mark(_ name: String, note: String? = nil) {
        let ms = Int(((CFAbsoluteTimeGetCurrent() - start) * 1000).rounded())
        lock.withLock { if !marks.contains(where: { $0.name == name }) { marks.append((name, ms, note)) } }
    }

    func has(_ name: String) -> Bool { lock.withLock { marks.contains { $0.name == name } } }

    var line: String {
        lock.withLock { "face.timing " + marks.map { "\($0.name)=\($0.ms)\($0.note.map { "(\($0))" } ?? "")" }.joined(separator: " ") }
    }

    /// The line once, when every step in `needed` is in (nil before that and after it was handed out).
    func lineOnce(needing needed: [String]) -> String? {
        let ready = lock.withLock { !logged && needed.allSatisfy { n in marks.contains { $0.name == n } } }
        guard ready else { return nil }
        let l = line
        return lock.withLock { if logged { return nil }; logged = true; return l }
    }
}
