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
    /// Photo polish (server flag GENITA_PHOTO_POLISH): true = polish this photo and show it for confirmation (V02-T).
    /// nil / false (older server, flag off, public figure, no face) = today's V02-T / V02-F on this check.
    public var polish: Bool? = nil
    /// V03 face scan (PREP_API.md, 11/4): SAM face contour, 32 [x, y] image fractions; nil = older server / failed check
    public var faceOutline: [[Double]]? = nil
    /// V03 face scan: eyes, brows, nose, lips as [x, y] image fractions; nil = no features found
    public var facePoints: FacePoints? = nil
    /// SAM head box; the mesh falls back to an oval inside it when there is no outline
    public var headBox: ImageHeadBox? = nil
}

/// Photo polish (PREP_API.md "Photo polish"): the polished picture to confirm on V02-T ("Use this image" / "Try again").
public struct PolishedImage: Codable, Equatable, Sendable {
    public var imageId: String
    public var sourceImageId: String
    /// the polished picture passed the same check (and kept the subject type); only then can it make the companion
    public var passed: Bool
    public var type: String?
    public var checks: ImageCheck.Checks?
    public var reasons: [ImageCheck.Reason]
    public var attempt: Int
    /// "Try again" left for this photo (two at first)
    public var retriesLeft: Int
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
    /// Face plan item 1: the scene's call-screen crop (`framing`), once the server knows the face box; nil on older servers.
    public var framing: SceneFraming?

    public var isReady: Bool { status == "ready" }
    public var isFailed: Bool { status == "failed" }
    /// The stage that is being made now (first one that isn't done), nil when all are done.
    public var current: Stage? { Stage.allCases.first { stages[$0] != .done } }
    /// The first stage that didn't finish (PREP-1e), nil while nothing failed.
    public var failedStage: Stage? { Stage.allCases.first { stages[$0] == .failed } }
    /// Continue on PREP-1: the call can start once the scene exists (photo face + device voice until the rest lands).
    public var canStartCall: Bool { isReady || isFailed || stages[.scene] == .done }

    public init(status: String, stages: [Stage: Status], done: Int? = nil, total: Int? = nil, sceneURL: URL? = nil, framing: SceneFraming? = nil) {
        self.status = status; self.stages = stages; self.done = done; self.total = total; self.sceneURL = sceneURL; self.framing = framing
    }

    private struct Step: Decodable { var status: String? }
    private struct FaceStep: Decodable { var status: String?; var settled: Int?; var expressionsSettled: Int?; var expressionsTotal: Int? }
    /// face.ts FACE_EXPRESSIONS (blink, smile, warm, surprised, concerned): a server without `expressionsSettled`
    /// is only trusted once this many keys settled
    static let faceExpressionCount = 5
    private struct Progress: Decodable { var done: Int?; var total: Int? }
    private enum Keys: String, CodingKey { case status, progress, steps, lips, face, sceneUrl, framing }

    static func stepStatus(_ raw: String?) -> Status? {
        switch raw {
        case "done", "ready", "ok": return .done
        // `skipped` / `off` = not part of this prep (Meta-only skips the old video clips and lip step): no signal
        case "skipped", "off": return nil
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
        framing = (try? c.decodeIfPresent(SceneFraming.self, forKey: .framing))?.sanitized
        // steps: {scene:{status}, face|expressions:{status}, mouth:{status}} or {scene, videos:{neutral:{status},…}}
        var steps: [String: Status] = [:]
        if let raw = try? c.decode([String: AnyStep].self, forKey: .steps) {
            for (k, v) in raw { if let s = v.status { steps[k] = s } }
        }
        if let lips = try? c.decode(Step.self, forKey: .lips), let s = Self.stepStatus(lips.status) { steps["lips"] = steps["lips"] ?? s }
        if let face = try? c.decode(Step.self, forKey: .face), let s = Self.stepStatus(face.status) { steps["face"] = steps["face"] ?? s }
        // Meta-only (runner.ts prepView): one `face` step makes the 3 expressions first, then the 10 visemes
        // (`settled` of `total`), so it drives both the Expressions and the Mouth rows.
        if steps["expressions"] == nil, steps["mouth"] == nil,
           let raw = try? c.decode([String: FaceStep?].self, forKey: .steps), let face = raw["face"] ?? nil, let st = Self.stepStatus(face.status) {
            // AU-29: the server counts the expression keys apart (all keys run at once, any order)
            let exprDone = face.expressionsSettled.map { $0 >= max(1, face.expressionsTotal ?? Self.faceExpressionCount) }
                ?? ((face.settled ?? 0) >= Self.faceExpressionCount)
            switch st {
            case .done: steps["expressions"] = .done; steps["mouth"] = .done
            case .pending: steps["expressions"] = .pending; steps["mouth"] = .pending
            case .running: steps["expressions"] = exprDone ? .done : .running; steps["mouth"] = exprDone ? .running : .pending
            case .failed: steps["expressions"] = exprDone ? .done : .failed; steps["mouth"] = exprDone ? .failed : .pending
            }
        }
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
    /// `n3` = the taste picker's `{clothes|food|chats: {like: [...], no: [...]}}` (Figma 269:2).
    public func importSkip(interests: [String], replies: String?, avoid: [String] = [], n3: [String: [String: [String]]]? = nil) async throws -> ImportedStyle {
        var body: [String: Any] = ["interests": interests, "avoid": avoid]
        if let n3 { body["n3"] = n3 }
        body["replies"] = replies ?? NSNull()
        return try style(try await auth.send("POST", "/v1/import/skip", json: body))
    }

    /// V01 "Use this image": ≤1024 px JPEG, with the rights line acknowledged (D26). Spark + SAM check, 2–5 s.
    public func checkImage(jpeg: Data) async throws -> ImageCheck {
        try await auth.send("POST", "/v1/companion/image", body: jpeg, contentType: "image/jpeg", query: "rights=1", timeout: 60)
    }

    /// Photo polish: one Muse Image edit + the same check on the result (≈15–20 s). "Try again" sends the same upload id.
    /// 422 not_polishable / polish_refused = choose another photo · 429 polish_limit · 502 polish_failed (retryable).
    public func polishImage(imageId: String) async throws -> PolishedImage {
        // AU-34: the server keeps the edit and its retry within 45 s plus the re-check, under CloudFront's 60 s
        try await auth.send("POST", "/v1/companion/image/polish", json: ["imageId": imageId], timeout: 90)
    }

    /// The user's own uploaded or polished image (V02-T shows the polished one).
    public func imageBytes(imageId: String) async throws -> Data {
        try await auth.sendData("GET", "/v1/companion/image/\(imageId.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? imageId)", timeout: 30)
    }

    /// NM01: one name from the photo + imported style (≤3 s p50; never fails for a Spark error).
    public func suggestName(imageId: String) async throws -> NameSuggestion {
        try await auth.send("POST", "/v1/companion/name/suggest", json: ["imageId": imageId], timeout: 15)
    }

    /// One V04 row from `GET /v1/companion/voices` (curated Seamless speakers for the companion's look).
    public struct CompanionVoice: Decodable, Equatable, Sendable, Identifiable {
        public var id: String
        public var name: String
        /// "Warm, bright" (the second line of the card)
        public var blurb: String
        public var label: String?
        public init(id: String, name: String, blurb: String, label: String? = nil) { self.id = id; self.name = name; self.blurb = blurb; self.label = label }
        enum CodingKeys: String, CodingKey { case id, name, blurb, label }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            name = try c.decodeIfPresent(String.self, forKey: .name) ?? id
            blurb = try c.decodeIfPresent(String.self, forKey: .blurb) ?? ""
            label = try c.decodeIfPresent(String.self, forKey: .label)
        }
    }
    public struct VoiceList: Decodable, Equatable, Sendable {
        public var voices: [CompanionVoice]
        /// the recommended default's id (first row)
        public var suggested: String?
        /// false while the voice service is down or cold: the app greys the list and lets the user continue
        public var available: Bool?
        public init(voices: [CompanionVoice], suggested: String? = nil, available: Bool? = nil) { self.voices = voices; self.suggested = suggested; self.available = available }
    }

    /// V04: the voices the server offers for this image's look, recommended default first.
    public func voices(imageId: String?) async throws -> VoiceList {
        let q = imageId.map { "imageId=\($0.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? $0)" }
        return try await auth.send("GET", "/v1/companion/voices", query: q, timeout: 8)
    }

    /// V04 play: the preview clip (`audio/wav`, streamed from the voice service and cached). `503 voice_unavailable` when it is down.
    public func voicePreview(id: String) async throws -> Data {
        try await auth.sendData("GET", "/v1/companion/voices/\(id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? id)/preview", timeout: 30)
    }

    /// V04 Continue: the pick is saved on the companion (not on the phone).
    @discardableResult
    public func saveVoice(_ voiceId: String) async throws -> CompanionInfo {
        try await auth.send("PUT", "/v1/companion/voice", json: ["voiceId": voiceId], timeout: 15)
    }

    /// Creates the one companion and starts prep at once (D28). `voiceId` must be a server catalog voice;
    /// without one the recommended voice for the image's look is used (calls speak with the server voice, 11/2).
    @discardableResult
    public func createCompanion(imageId: String, voiceId: String? = nil, name: String? = nil) async throws -> CompanionInfo {
        var voice = voiceId
        if voice == nil {
            let v = try await voices(imageId: imageId)
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

    /// The companion's call scene for PREP-1 and a new phone. Meta-only `sceneUrl` is a server path
    /// (`/v1/companion/face/neutral`) behind the account token; an absolute https URL is fetched as is.
    public func sceneImage(_ url: URL) async throws -> Data {
        if url.host == nil, url.path.hasPrefix("/v1/") { return try await auth.sendData("GET", url.path, timeout: 30) }
        guard url.scheme == "https" else { throw GenitaAuthError.badResponse }
        let (data, res) = try await URLSession.shared.data(from: url)
        guard (res as? HTTPURLResponse)?.statusCode == 200 else { throw GenitaAuthError.badResponse }
        return data
    }

    /// PREP-1e Try again: the server redoes only the steps that didn't finish (`202` + the new progress).
    public func retryPrep() async throws -> PrepProgress { try await auth.send("POST", "/v1/companion/prep/retry", timeout: 30) }

    public struct ResetResult: Decodable, Sendable, Equatable {
        public var ok: Bool
        /// false = there was no companion to remove (the reset is still done)
        public var removed: Bool
    }

    /// M02 "Make a new companion": the server removes the companion (face, voice, name, chats and call memory) and
    /// keeps the account and what Genita knows about the user. Afterwards `/me` has no companion (→ V01).
    /// `429 rate_limited` after 10 a day; `409` while one is running; `502` = try again.
    @discardableResult
    public func resetCompanion() async throws -> ResetResult { try await auth.send("POST", "/v1/companion/reset", json: [:], timeout: 30) }

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
