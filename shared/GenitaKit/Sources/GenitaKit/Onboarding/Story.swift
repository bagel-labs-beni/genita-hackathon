import Foundation

// D47 "How I see you" (lane 개인화): the imported (or N1–N3) profile as seven story cards, and the
// "That's not me" correction. Server contract: genita-server/PREP_API.md "How I see you + corrections",
// card shape: genita-server/src/personalize/story.ts.

/// One card: opener · think · talk · taste · help · lines · unknowns (in that order).
public struct StoryCard: Codable, Hashable, Identifiable, Sendable {
    public struct Tags: Codable, Hashable, Sendable {
        public var style: [String]
        public var food: [String]
        public var watch: [String]
        public var dislikes: [String]
        public init(style: [String] = [], food: [String] = [], watch: [String] = [], dislikes: [String] = []) {
            self.style = style; self.food = food; self.watch = watch; self.dislikes = dislikes
        }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            style = (try? c.decodeIfPresent([String].self, forKey: .style)) ?? []
            food = (try? c.decodeIfPresent([String].self, forKey: .food)) ?? []
            watch = (try? c.decodeIfPresent([String].self, forKey: .watch)) ?? []
            dislikes = (try? c.decodeIfPresent([String].self, forKey: .dislikes)) ?? []
        }
        public var isEmpty: Bool { style.isEmpty && food.isEmpty && watch.isEmpty && dislikes.isEmpty }
    }
    public struct HelpTile: Codable, Hashable, Sendable {
        public enum Mode: String, Codable, Sendable { case askFirst = "ask_first", justDoIt = "just_do_it" }
        public var label: String
        public var mode: Mode
        public init(label: String, mode: Mode) { self.label = label; self.mode = mode }
        /// the tile's badge
        public var badge: String { mode == .askFirst ? "Ask first" : "Just do it" }
    }

    public var id: String
    public var title: String
    public var observation: String
    public var promise: String
    /// explicit · observed · memory · suggested (the I04 legend)
    public var evidence: String
    /// nothing to say yet: the card reads "tell me later" (the server sends that text)
    public var later: Bool
    /// the "That's not me" sheet's choices
    public var picks: [String]
    public var tags: Tags?
    public var help: [HelpTile]?
    public var unknowns: [String]?

    public init(id: String, title: String, observation: String, promise: String, evidence: String = "suggested", later: Bool = false,
                picks: [String] = [], tags: Tags? = nil, help: [HelpTile]? = nil, unknowns: [String]? = nil) {
        self.id = id; self.title = title; self.observation = observation; self.promise = promise; self.evidence = evidence
        self.later = later; self.picks = picks; self.tags = tags; self.help = help; self.unknowns = unknowns
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        observation = try c.decode(String.self, forKey: .observation)
        promise = try c.decode(String.self, forKey: .promise)
        evidence = (try? c.decodeIfPresent(String.self, forKey: .evidence)) ?? "suggested"
        later = (try? c.decodeIfPresent(Bool.self, forKey: .later)) ?? false
        picks = (try? c.decodeIfPresent([String].self, forKey: .picks)) ?? []
        tags = try? c.decodeIfPresent(Tags.self, forKey: .tags)
        // a tile with a mode this build doesn't know is left out, not the whole card
        help = (try? c.decodeIfPresent([Lenient<HelpTile>].self, forKey: .help))?.compactMap(\.value)
        unknowns = try? c.decodeIfPresent([String].self, forKey: .unknowns)
    }

    /// The I04 legend line for `evidence`.
    public var evidenceLabel: String { Self.evidenceLabel(evidence) }
    public static func evidenceLabel(_ label: String) -> String {
        switch label {
        case "explicit": "You said so"
        case "observed": "Your AI noticed"
        case "memory": "Your AI's memory"
        default: "My suggestion"
        }
    }

    public static let order = ["opener", "think", "talk", "taste", "help", "lines", "unknowns"]
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

/// `PATCH /v1/profile` answer: the rewritten card, the ack line and the updated I04 rows + profile text.
public struct ProfileCorrection: Decodable, Equatable, Sendable {
    public var card: StoryCard
    public var ack: String
    public var changed: Bool
    public var profile: String
    public var rows: [StyleRow]
}

extension OnboardingClient {
    /// D47: the story when the import didn't bring it (N1–N3, or written late). The server holds the answer up
    /// to `wait` seconds (0–10) while it writes the cards.
    public func story(wait: Int = 8) async throws -> ProfileStory {
        let w = min(10, max(0, wait))
        return try await auth.send("GET", "/v1/profile/story", query: "wait=\(w)", timeout: TimeInterval(w + 12))
    }

    /// "That's not me": the card, a pick from its `picks` and/or ≤200 characters. Spark turns it into explicit
    /// profile lines and rewrites the card (`400 bad_correction`, `429 rate_limited`, `502 upstream_failed`).
    public func correct(cardId: String, pick: String?, text: String?) async throws -> ProfileCorrection {
        var body: [String: Any] = ["cardId": cardId]
        if let pick, !pick.isEmpty { body["pick"] = pick }
        let t = Self.correctionText(text ?? "")
        if !t.isEmpty { body["text"] = t }
        return try await auth.send("PATCH", "/v1/profile", json: body, timeout: 45)
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
