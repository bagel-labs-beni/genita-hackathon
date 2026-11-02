import CoreGraphics
import Foundation

/// L4 · The companion's animated Meta face on the call screen (docs/specs/metaface.md "App").
enum CompanionFace {
    /// `GENITA_KLING_FACE=1` (launch env, or an Info.plist bool): the earlier Kling silent loop instead of
    /// the Meta face. Off by default.
    static var klingFace: Bool {
        flag(ProcessInfo.processInfo.environment["GENITA_KLING_FACE"]) ?? flag(Bundle.main.object(forInfoDictionaryKey: "GENITA_KLING_FACE")) ?? false
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

/// Loads the companion's face set from `GET /v1/companion/prep` → `face` (PREP_API.md).
struct CompanionFaceLoader: Sendable {
    typealias Fetch = @Sendable (URLRequest) async throws -> (Data, URLResponse)
    enum Outcome { case none, unchanged, loaded(key: String, set: FaceSet) }

    var endpoint: CallEndpoint
    var cacheRoot: URL
    var fetch: Fetch

    init(endpoint: CallEndpoint, cacheRoot: URL, fetch: @escaping Fetch) {
        self.endpoint = endpoint
        self.cacheRoot = cacheRoot
        self.fetch = fetch
    }

    func load(currentKey: String?) async throws -> Outcome { .none }
}
