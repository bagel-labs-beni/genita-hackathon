import Foundation

// D47 "How I see you" v2 (lane 개인화, Chelsea OK 11/3; Figma rp1wR9pxV0IsgyjvOcwo92 HISY-0~7, S0~S4, C1~C3):
// the imported (or N1–N3) profile as story cards, and the C1 "That's not me" correction.
// Server contract: genita-server/PREP_API.md "How I see you + corrections (D47 HISY v2)",
// card shape: genita-server/src/personalize/story.ts.

/// One card: think · talk · taste · help · lines · unknowns (each only when the profile has something for it).
public struct StoryCard: Codable, Hashable, Identifiable, Sendable {
    /// One observation with its evidence chip (think · talk · lines).
    public struct Item: Codable, Hashable, Sendable {
        public var text: String
        /// explicit · observed · memory
        public var evidence: String
        public init(text: String, evidence: String) { self.text = text; self.evidence = evidence }
        public var evidenceLabel: String { StoryCard.evidenceLabel(evidence) }
    }
    /// taste: one tag; dislikes are drawn dashed with ✕.
    public struct Tag: Codable, Hashable, Sendable {
        /// style · food · watch · interest
        public var group: String
        public var text: String
        public var dislike: Bool
        public init(group: String, text: String, dislike: Bool = false) { self.group = group; self.text = text; self.dislike = dislike }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            group = (try? c.decodeIfPresent(String.self, forKey: .group)) ?? "interest"
            text = try c.decode(String.self, forKey: .text)
            dislike = (try? c.decodeIfPresent(Bool.self, forKey: .dislike)) ?? false
        }
        /// How C1 names it (server `cardTexts`): a dislike is "Not for you: <tag lowercased>".
        public var choiceText: String { dislike ? "Not for you: \(text.lowercased())" : text }
    }
    public struct HelpTile: Codable, Hashable, Sendable {
        public enum Mode: String, Codable, Sendable { case askFirst = "ask_first", justDoIt = "just_do_it" }
        public var label: String
        public var sub: String
        public var mode: Mode
        public init(label: String, sub: String = "", mode: Mode) { self.label = label; self.sub = sub; self.mode = mode }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            label = try c.decode(String.self, forKey: .label)
            sub = (try? c.decodeIfPresent(String.self, forKey: .sub)) ?? ""
            mode = try c.decode(Mode.self, forKey: .mode)
        }
    }
    public struct Unknown: Codable, Hashable, Sendable {
        public var item: String
        public var topic: String
        public var sub: String
        public init(item: String, topic: String, sub: String = "") { self.item = item; self.topic = topic; self.sub = sub }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            topic = try c.decode(String.self, forKey: .topic)
            item = (try? c.decodeIfPresent(String.self, forKey: .item)) ?? topic
            sub = (try? c.decodeIfPresent(String.self, forKey: .sub)) ?? ""
        }
    }
    /// A taste group as the card draws it (Style / Food / Watch & listen / Interests).
    public struct TagGroup: Hashable, Sendable {
        public var key: String
        public var title: String
        public var tags: [Tag]
    }

    public var id: String
    /// small grey line over the headline ("How you think")
    public var eyebrow: String
    /// big serif line
    public var headline: String
    /// grey line under the headline (unknowns)
    public var subline: String?
    public var items: [Item]
    /// "So I'll …" (talk: the blue box)
    public var promise: String?
    /// card-level chip (taste, help)
    public var evidence: String
    public var tags: [Tag]?
    /// taste without likes: "No favorites yet. …"
    public var note: String?
    public var help: [HelpTile]?
    public var unknowns: [Unknown]?

    public init(id: String, eyebrow: String, headline: String, subline: String? = nil, items: [Item] = [], promise: String? = nil,
                evidence: String = "explicit", tags: [Tag]? = nil, note: String? = nil, help: [HelpTile]? = nil, unknowns: [Unknown]? = nil) {
        self.id = id; self.eyebrow = eyebrow; self.headline = headline; self.subline = subline; self.items = items; self.promise = promise
        self.evidence = evidence; self.tags = tags; self.note = note; self.help = help; self.unknowns = unknowns
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        eyebrow = try c.decode(String.self, forKey: .eyebrow)
        headline = try c.decode(String.self, forKey: .headline)
        subline = try? c.decodeIfPresent(String.self, forKey: .subline)
        items = ((try? c.decodeIfPresent([Lenient<Item>].self, forKey: .items)) ?? []).compactMap(\.value)
        promise = try? c.decodeIfPresent(String.self, forKey: .promise)
        evidence = (try? c.decodeIfPresent(String.self, forKey: .evidence)) ?? "explicit"
        tags = (try? c.decodeIfPresent([Lenient<Tag>].self, forKey: .tags))?.compactMap(\.value)
        note = try? c.decodeIfPresent(String.self, forKey: .note)
        // a tile with a mode this build doesn't know is left out, not the whole card
        help = (try? c.decodeIfPresent([Lenient<HelpTile>].self, forKey: .help))?.compactMap(\.value)
        unknowns = (try? c.decodeIfPresent([Lenient<Unknown>].self, forKey: .unknowns))?.compactMap(\.value)
    }

    /// The card-level evidence chip.
    public var evidenceLabel: String { Self.evidenceLabel(evidence) }
    /// explicit "You said this" · observed "You did this often" · memory "From your memories".
    public static func evidenceLabel(_ label: String) -> String {
        switch label {
        case "observed": "You did this often"
        case "memory": "From your memories"
        default: "You said this"
        }
    }

    /// taste: Style · Food · Watch & listen · Interests, in that order, empty groups left out.
    public var tagGroups: [TagGroup] {
        let titles: [(String, String)] = [("style", "Style"), ("food", "Food"), ("watch", "Watch & listen"), ("interest", "Interests")]
        let all = tags ?? []
        let known = Set(titles.map(\.0))
        return titles.compactMap { key, title in
            let t = all.filter { key == "interest" ? ($0.group == key || !known.contains($0.group)) : $0.group == key }
            return t.isEmpty ? nil : TagGroup(key: key, title: title, tags: t)
        }
    }

    /// C1 "What's off?": the card's own texts, in the server's `cardTexts` order (PATCH `items` must be these).
    public var correctionChoices: [String] {
        items.map(\.text) + (tags ?? []).map(\.choiceText) + (help ?? []).map(\.label) + (unknowns ?? []).map(\.topic)
    }

    public static let order = ["think", "talk", "taste", "help", "lines", "unknowns"]
    /// Server order; unknown ids go last (a newer server's extra card still shows).
    public static func ordered(_ cards: [StoryCard]) -> [StoryCard] {
        cards.enumerated().sorted { (order.firstIndex(of: $0.element.id) ?? 99, $0.offset) < (order.firstIndex(of: $1.element.id) ?? 99, $1.offset) }.map(\.element)
    }
}

/// Decodes one element of a list; a bad one becomes nil instead of failing the list.
struct Lenient<T: Decodable>: Decodable {
    var value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

/// `GET /v1/profile/story?wait=s`
public struct ProfileStory: Decodable, Equatable, Sendable {
    public enum Status: String, Decodable, Sendable { case ready, processing, none }
    public var status: Status
    /// import | skip
    public var source: String?
    public var cards: [StoryCard]
    public init(status: Status, source: String? = nil, cards: [StoryCard]) { self.status = status; self.source = source; self.cards = cards }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = (try? c.decode(Status.self, forKey: .status)) ?? .none
        source = try? c.decodeIfPresent(String.self, forKey: .source)
        cards = StoryCard.ordered(((try? c.decodeIfPresent([Lenient<StoryCard>].self, forKey: .cards)) ?? []).compactMap(\.value))
    }
    private enum CodingKeys: String, CodingKey { case status, source, cards }
}

/// `PATCH /v1/profile` answer (C3): the same card rewritten (nil = the correction emptied it), the ack, the card's
/// texts that are new (blue border), and the updated I04 rows + profile text.
public struct ProfileCorrection: Decodable, Equatable, Sendable {
    public var card: StoryCard?
    public var ack: String
    public var changed: [String]
    public var profile: String
    public var rows: [StyleRow]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        card = try? c.decodeIfPresent(StoryCard.self, forKey: .card)
        ack = (try? c.decodeIfPresent(String.self, forKey: .ack)) ?? ""
        changed = (try? c.decodeIfPresent([String].self, forKey: .changed)) ?? []
        profile = (try? c.decodeIfPresent(String.self, forKey: .profile)) ?? ""
        rows = (try? c.decodeIfPresent([StyleRow].self, forKey: .rows)) ?? []
    }
    private enum CodingKeys: String, CodingKey { case card, ack, changed, profile, rows }

    /// C3: draw this tag with the blue border.
    public func isChanged(_ tag: StoryCard.Tag) -> Bool { changed.contains(tag.choiceText) }
}

extension OnboardingClient {
    /// D47: the story when the import didn't bring it (N1–N3, or written late). The server holds the answer up
    /// to `wait` seconds (0–10) while it writes the cards.
    public func story(wait: Int = 8) async throws -> ProfileStory {
        let w = min(10, max(0, wait))
        return try await auth.send("GET", "/v1/profile/story", query: "wait=\(w)", timeout: TimeInterval(w + 12))
    }

    /// C1 Save: the texts the user marked (each one of the card's `correctionChoices`) and/or ≤200 characters of
    /// what's right. `400 bad_correction`, `409 card_not_shown`, `429 rate_limited`, `502 upstream_failed`.
    public func correct(cardId: String, items: [String], text: String?) async throws -> ProfileCorrection {
        var body: [String: Any] = ["cardId": cardId]
        if !items.isEmpty { body["items"] = items }
        let t = Self.correctionText(text ?? "")
        if !t.isEmpty { body["text"] = t }
        return try await auth.send("PATCH", "/v1/profile", json: body, timeout: 45)
    }

    /// C2 hold to say (b17, Meta models only): `POST /v1/transcribe` — one clip (24 kHz mono s16 PCM, ≤ 30 s) →
    /// Muse Voice Transcribe on the server → the words ("" = nothing heard). 404 when the server's switch is off.
    public func transcribe(pcm24k: Data, timeout: TimeInterval = 8) async throws -> String {
        struct Reply: Decodable { var text: String }
        let r: Reply = try await auth.send("POST", "/v1/transcribe", body: pcm24k, contentType: "audio/L16; rate=24000", timeout: timeout)
        return r.text
    }

    /// About you → "Forget all of this" (AU-92): `DELETE /v1/profile`. What Genita knows about the user (import,
    /// HISY, corrections, insights) and the call memory go; the companion and the account stay. `429 rate_limited`.
    public func forgetProfile() async throws {
        let _: ProfileForgetResult = try await auth.send("DELETE", "/v1/profile", timeout: 30)
    }

    /// PATCH /v1/profile `text` limit, counted like the server (`text.length`, UTF-16 units).
    public static let correctionMaxLength = 200

    /// Trimmed and cut to `correctionMaxLength` UTF-16 units on a whole character (an emoji is 2 there).
    public static func correctionText(_ raw: String, trim: Bool = true) -> String {
        let trimmed = trim ? raw.trimmingCharacters(in: .whitespacesAndNewlines) : raw
        guard trimmed.utf16.count > correctionMaxLength else { return trimmed }
        var out = "", units = 0
        for ch in trimmed {
            let n = String(ch).utf16.count
            if units + n > correctionMaxLength { break }
            out.append(ch); units += n
        }
        return out
    }
}

/// `DELETE /v1/profile` answer.
public struct ProfileForgetResult: Decodable, Equatable, Sendable {
    public var ok: Bool
}
