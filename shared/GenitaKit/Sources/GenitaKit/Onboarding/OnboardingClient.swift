import Foundation

// F2 / F3 / F4 onboarding on genita-server's prep API (genita-server/PREP_API.md).
// Same host, bearer and error mapping as GenitaAuthClient: 401 clears the token (→ A02),
// 403 consent_required (→ CS01), no connection → offline.

/// One I04 row: "Communication style", "How Genita can help", … (six, in order; PRD v12 D20).
public struct StyleRow: Codable, Equatable, Sendable {
    public struct Item: Codable, Equatable, Sendable {
        public var text: String
        /// explicit (You said so) · observed (Your AI noticed) · memory (Your AI's memory) · suggested (My suggestion)
        public var label: String?
        public init(text: String, label: String? = nil) { self.text = text; self.label = label }
    }
    public var key: String
    public var title: String
    public var items: [Item]
    public init(key: String, title: String, items: [Item]) { self.key = key; self.title = title; self.items = items }
}

/// The imported (or N1–N3) style: I04's rows, plus the profile text that goes into `start.user.profile`.
public struct ImportedStyle: Equatable, Sendable {
    public var rows: [StyleRow]
    public var partial: Bool
    public var toConfirm: [String]
    public var profile: String
    public var source: String
    /// D47 "How I see you" cards, written with the import in parallel; nil when they weren't ready in time
    /// (or for N1–N3): read them with `story(wait:)`.
    public var story: [StoryCard]? = nil

    /// I04 is read-only text: one heading per row, then its items; an empty row says so (I04-P).
    public var displayText: String {
        rows.map { row in
            ([row.title] + (row.items.isEmpty ? ["• Not enough information yet."] : row.items.map { "• \($0.text)" })).joined(separator: "\n")
        }.joined(separator: "\n")
    }
}

/// V01 → V03 → V02-T / V02-F.
public struct ImageCheck: Codable, Equatable, Sendable {
    public struct Checks: Codable, Equatable, Sendable {
        public var oneFaceFrontFacing: Bool
        public var sharpAndLit: Bool
        public var noText: Bool
    }
    public struct Reason: Codable, Equatable, Sendable {
        public var code: String
        public var label: String
    }
    public var imageId: String
    public var passed: Bool
    /// human | animal | character | nil
    public var type: String?
    public var checks: Checks?
    public var reasons: [Reason]
}

public struct NameSuggestion: Codable, Equatable, Sendable {
    public var name: String
    /// false = Spark failed or timed out; `name` is the server's neutral fallback
    public var suggested: Bool?
}

/// NM01 rule (PREP_API.md "Companion name"): trimmed, 1–20 characters, letters/digits/spaces/`.` `'` `-`, at least one letter.
public enum CompanionName {
    public static let maxLength = 20
    public static func clean(_ raw: String) -> String { raw.trimmingCharacters(in: .whitespacesAndNewlines) }
    public static func isValid(_ raw: String) -> Bool {
        let s = clean(raw)
        guard (1...maxLength).contains(s.count), s.contains(where: { $0.isLetter }) else { return false }
        return s.allSatisfy { $0.isLetter || $0.isNumber || $0 == " " || $0 == "." || $0 == "'" || $0 == "-" || $0 == "\u{2019}" }
    }
}

/// `GET /v1/companion` — what the call needs (persona name, profile) and where prep is.
public struct CompanionInfo: Decodable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var type: String?
    public var imageId: String?
    public var voiceId: String?
    public var prep: PrepProgress?
    /// the ready-made judge companion (PR #178 seeds it on first judge sign-in); the app labels it "Demo companion"
    public var demo: Bool?
    /// ready-made realtime `start` fields (persona card, imported profile) once the setup answers are saved
    public var session: Session?
    public struct Session: Decodable, Equatable, Sendable {
        public struct User: Decodable, Equatable, Sendable { public var profile: String? }
        public var persona: ClientMessage.Persona?
        public var user: User?
    }
}

/// PREP-1 "Bringing {name} to life": scene → expressions → mouth (Meta-only face set, 11/2).
/// Decoded tolerantly: it reads the Meta-only shape (`steps.face` / `steps.expressions` / `steps.mouth`)
/// and the older one (`steps.videos`, `lips`), so the screen works before and after the prep change lands.
public struct PrepProgress: Decodable, Equatable, Sendable {
    public enum Status: String, Sendable { case pending, running, done, failed }
    public enum Stage: String, CaseIterable, Sendable { case scene, expressions, mouth }

    /// running | ready | failed
    public var status: String
    public var done: Int?
    public var total: Int?
    public var stages: [Stage: Status]
    public var sceneURL: URL?

    public var isReady: Bool { status == "ready" }
    public var isFailed: Bool { status == "failed" }
    /// The stage that is being made now (first one that isn't done), nil when all are done.
    public var current: Stage? { Stage.allCases.first { stages[$0] != .done } }
    /// Continue on PREP-1: the call can start once the scene exists (photo face + device voice until the rest lands).
    public var canStartCall: Bool { isReady || isFailed || stages[.scene] == .done }

    public init(status: String, stages: [Stage: Status], done: Int? = nil, total: Int? = nil, sceneURL: URL? = nil) {
        self.status = status; self.stages = stages; self.done = done; self.total = total; self.sceneURL = sceneURL
    }

    private struct Step: Decodable { var status: String? }
    private struct Progress: Decodable { var done: Int?; var total: Int? }
    private enum Keys: String, CodingKey { case status, progress, steps, lips, face, sceneUrl }

    static func stepStatus(_ raw: String?) -> Status? {
        switch raw {
        case "done", "ready", "ok", "skipped", "off": return .done
        case "running", "processing", "baking", "submitted": return .running
        case "failed", "error": return .failed
        case "pending", "queued", "waiting", "todo": return .pending
        default: return nil
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        status = (try? c.decode(String.self, forKey: .status)) ?? "running"
        let p = try? c.decode(Progress.self, forKey: .progress)
        done = p?.done; total = p?.total
        sceneURL = (try? c.decode(String.self, forKey: .sceneUrl)).flatMap(URL.init(string:))
        // steps: {scene:{status}, face|expressions:{status}, mouth:{status}} or {scene, videos:{neutral:{status},…}}
        var steps: [String: Status] = [:]
        if let raw = try? c.decode([String: AnyStep].self, forKey: .steps) {
            for (k, v) in raw { if let s = v.status { steps[k] = s } }
        }
        if let lips = try? c.decode(Step.self, forKey: .lips), let s = Self.stepStatus(lips.status) { steps["lips"] = steps["lips"] ?? s }
        if let face = try? c.decode(Step.self, forKey: .face), let s = Self.stepStatus(face.status) { steps["face"] = steps["face"] ?? s }
        let ready = status == "ready"
        func pick(_ keys: [String]) -> Status { ready ? .done : keys.lazy.compactMap { steps[$0] }.first ?? .pending }
        stages = [.scene: pick(["scene"]), .expressions: pick(["expressions", "face", "videos"]), .mouth: pick(["mouth", "visemes", "lips"])]
    }

    /// A step is `{status}` or a map of sub-steps (`videos: {neutral:{status}, …}`): all done → done, any failed → failed.
    private struct AnyStep: Decodable {
        var status: Status?
        init(from decoder: Decoder) throws {
            if let one = try? Step(from: decoder), let s = PrepProgress.stepStatus(one.status) { status = s; return }
            if let many = try? [String: Step](from: decoder) {
                let all = many.values.compactMap { PrepProgress.stepStatus($0.status) }
                if all.isEmpty { status = nil }
                else if all.contains(.failed) { status = .failed }
                else if all.allSatisfy({ $0 == .done }) { status = .done }
                else if all.contains(where: { $0 != .pending }) { status = .running }
                else { status = .pending }
                return
            }
            status = nil
        }
    }
}

/// SUM's four lines, from `POST /v1/companion/prefs`.
public struct SetupSummary: Codable, Equatable, Sendable {
    public var why: String?
    public var energy: String?
    public var initiative: String?
    public var never: String?
}

public final class OnboardingClient: @unchecked Sendable {
    public let auth: GenitaAuthClient
    public init(auth: GenitaAuthClient = GenitaAuthClient()) { self.auth = auth }

    private struct StyleWire: Decodable {
        var source: String?
        var display: [StyleRow]
        var partial: Bool?
        var toConfirm: [String]?
    }
    private struct ImportReply: Decodable {
        var status: String; var style: StyleWire?; var profile: String?; var story: [StoryCard]?
        private enum CodingKeys: String, CodingKey { case status, style, profile, story }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            status = try c.decode(String.self, forKey: .status)
            style = try c.decodeIfPresent(StyleWire.self, forKey: .style)
            profile = try c.decodeIfPresent(String.self, forKey: .profile)
            // the story is extra: one the app can't read never fails the import (it's read again later)
            // (one card it can't read is left out, not the whole story)
            let cards = ((try? c.decodeIfPresent([Lenient<StoryCard>].self, forKey: .story)) ?? []).compactMap(\.value)
            story = cards.isEmpty ? nil : StoryCard.ordered(cards)
        }
    }

    private func style(_ r: ImportReply) throws -> ImportedStyle {
        guard r.status == "ready", let s = r.style else { throw GenitaAuthError.badResponse }
        return ImportedStyle(rows: s.display, partial: s.partial ?? s.display.contains { $0.items.isEmpty }, toConfirm: s.toConfirm ?? [],
                             profile: r.profile ?? "", source: s.source ?? "import", story: r.story)
    }

    /// I02 → I03 → I04: Spark turns the pasted reply into the style card (4–8 s). The text itself isn't stored.
    public func importReply(_ text: String) async throws -> ImportedStyle {
        try style(try await auth.send("POST", "/v1/import", json: ["text": text], timeout: 60))
    }

    /// N1–N3 (no AI assistant): chips → the same style card, no Spark call.
    public func importSkip(interests: [String], replies: String?, avoid: [String]) async throws -> ImportedStyle {
        var body: [String: Any] = ["interests": interests, "avoid": avoid]
        body["replies"] = replies ?? NSNull()
        return try style(try await auth.send("POST", "/v1/import/skip", json: body))
    }

    /// V01 "Use this image": ≤1024 px JPEG, with the rights line acknowledged (D26). Spark + SAM check, 2–5 s.
    public func checkImage(jpeg: Data) async throws -> ImageCheck {
        try await auth.send("POST", "/v1/companion/image", body: jpeg, contentType: "image/jpeg", query: "rights=1", timeout: 60)
    }

    /// NM01: one name from the photo + imported style (≤3 s p50; never fails for a Spark error).
    public func suggestName(imageId: String) async throws -> NameSuggestion {
        try await auth.send("POST", "/v1/companion/name/suggest", json: ["imageId": imageId], timeout: 15)
    }

    private struct VoicesReply: Decodable { struct Voice: Decodable { var id: String }; var voices: [Voice]; var suggested: String? }

    /// Creates the one companion and starts prep at once (D28). `voiceId` must be a server catalog voice;
    /// without one the first catalog voice is used (the call speaks with the device voice, 11/2 Meta-only).
    @discardableResult
    public func createCompanion(imageId: String, voiceId: String? = nil, name: String? = nil) async throws -> CompanionInfo {
        var voice = voiceId
        if voice == nil {
            let v: VoicesReply = try await auth.send("GET", "/v1/companion/voices", query: "imageId=\(imageId.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? imageId)", timeout: 30)
            voice = v.suggested ?? v.voices.first?.id
        }
        guard let voice else { throw GenitaAuthError.badResponse }
        var body: [String: Any] = ["imageId": imageId, "voiceId": voice]
        if let name, CompanionName.isValid(name) { body["name"] = CompanionName.clean(name) }
        return try await auth.send("POST", "/v1/companion", json: body, timeout: 30)
    }

    /// NM01 Continue (and Settings rename): the name goes into the persona; `400 bad_name` for an invalid one.
    @discardableResult
    public func renameCompanion(_ name: String) async throws -> CompanionInfo {
        try await auth.send("PATCH", "/v1/companion", json: ["name": CompanionName.clean(name)])
    }

    public func companion() async throws -> CompanionInfo { try await auth.send("GET", "/v1/companion") }

    public func prep() async throws -> PrepProgress { try await auth.send("GET", "/v1/companion/prep") }

    public struct PrefsResult: Decodable, Sendable {
        public struct Session: Decodable, Sendable { public var persona: ClientMessage.Persona? }
        public var summary: SetupSummary?
        /// the realtime `start.persona` the server wrote (traits, speaking style, backstory, name)
        public var session: Session?
    }

    /// D01 / P1–P7 → persona card + SUM lines. `answers` uses the server keys (help, relationship, presence,
    /// challenge, pace, reachOut, never) — see `SetupAnswersWire`.
    public func savePrefs(depth: String, answers: [String: Any]) async throws -> PrefsResult {
        try await auth.send("POST", "/v1/companion/prefs", json: ["depth": depth, "answers": answers], timeout: 30)
    }
}

/// The app's survey answers → `POST /v1/companion/prefs` (exactly the keys of the depth; PREP_API.md table).
public enum SetupAnswersWire {
    public static let help = ["Think with me", "Keep me moving", "Be there", "Work beside me"]
    public static let relationship = ["Close companion", "Trusted partner", "Creative co-pilot", "Quiet operator"]
    public static let presence = ["Calm", "Witty", "Grounded", "Warm"]
    public static let never = ["Message anyone for me", "Use sensitive memories", "Interrupt focus time", "Mirror my mood"]

    /// `sliders` are the app's 0…4 positions keyed challenge / tempo / initiative.
    public static func answers(depth: String, help: String?, relationship: String?, presence: [String], sliders: [String: Int], never: [String]) -> [String: Any] {
        var a: [String: Any] = [
            "help": help.flatMap { self.help.contains($0) ? $0 : nil } ?? self.help[0],
            "relationship": relationship.flatMap { self.relationship.contains($0) ? $0 : nil } ?? self.relationship[1],
        ]
        var pres = Array(presence.filter { self.presence.contains($0) }.prefix(2))
        if pres.isEmpty { pres = ["Calm"] }
        a["presence"] = pres
        let slider = { (k: String) in min(5, max(1, (sliders[k] ?? 2) + 1)) }
        if depth != "quick" { a["challenge"] = slider("challenge"); a["pace"] = slider("tempo") }
        if depth == "deep" {
            a["reachOut"] = slider("initiative")
            a["never"] = never.filter { self.never.contains($0) }
        }
        return a
    }
}
