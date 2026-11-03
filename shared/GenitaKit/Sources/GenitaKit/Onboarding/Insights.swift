import Foundation

// SUM insight report (Chelsea 11/4; data model 춘식이 r01 + r02): what Genita noticed about the user, each trait
// with the words it came from, plus the type read. Server contract: genita-server/PREP_API.md "Insight report",
// shapes: genita-server/src/insights/profile.ts. Every field the app can live without is optional / defaulted,
// and one bad element never fails the report (Lenient).

public struct InsightEvidence: Codable, Hashable, Sendable {
    /// import · answer · chat
    public var source: String
    public var quote: String
    /// "From the reply you pasted" · "You picked" · "You said on our call"
    public var sourceLabel: String
    /// the key phrase inside `quote` (drawn as a mark)
    public var highlight: String?
    public init(source: String, quote: String, sourceLabel: String, highlight: String? = nil) {
        self.source = source; self.quote = quote; self.sourceLabel = sourceLabel; self.highlight = highlight
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        source = (try? c.decodeIfPresent(String.self, forKey: .source)) ?? "import"
        quote = try c.decode(String.self, forKey: .quote)
        sourceLabel = (try? c.decodeIfPresent(String.self, forKey: .sourceLabel)) ?? ""
        highlight = try? c.decodeIfPresent(String.self, forKey: .highlight)
    }
    enum CodingKeys: String, CodingKey { case source, quote, sourceLabel = "source_label", highlight }
    /// The label with the AI's name when the app knows it ("From your ChatGPT reply").
    public func label(aiName: String?) -> String {
        guard source == "import", let aiName, !aiName.isEmpty else { return sourceLabel }
        return "From your \(aiName) reply"
    }
}

public struct InsightChip: Codable, Hashable, Sendable {
    public var label: String
    /// like · dislike (dislikes are drawn dashed with ✕)
    public var polarity: String
    public var dislike: Bool { polarity == "dislike" }
    public init(label: String, polarity: String = "like") { self.label = label; self.polarity = polarity }
}

public struct InsightObservation: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    /// talk · think · humor · taste · help · boundary · rhythm · interest
    public var category: String
    /// "You …" — a medium one is shown as "I think you …" (`displayClaim`)
    public var claim: String
    public var evidence: [InsightEvidence]
    /// high · medium
    public var confidence: String
    public var score: Double
    public var surprise: Double
    /// "I'll …"
    public var useInCall: String
    public var chips: [InsightChip]
    /// nil · right · not_me
    public var verdict: String?
    public var correction: String?

    public init(id: String, category: String, claim: String, evidence: [InsightEvidence], confidence: String = "high", score: Double = 0.8,
                surprise: Double = 0.5, useInCall: String, chips: [InsightChip] = [], verdict: String? = nil, correction: String? = nil) {
        self.id = id; self.category = category; self.claim = claim; self.evidence = evidence; self.confidence = confidence; self.score = score
        self.surprise = surprise; self.useInCall = useInCall; self.chips = chips; self.verdict = verdict; self.correction = correction
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        category = (try? c.decodeIfPresent(String.self, forKey: .category)) ?? "think"
        claim = try c.decode(String.self, forKey: .claim)
        evidence = ((try? c.decodeIfPresent([Lenient<InsightEvidence>].self, forKey: .evidence)) ?? []).compactMap(\.value)
        confidence = (try? c.decodeIfPresent(String.self, forKey: .confidence)) ?? "high"
        score = (try? c.decodeIfPresent(Double.self, forKey: .score)) ?? 0.8
        surprise = (try? c.decodeIfPresent(Double.self, forKey: .surprise)) ?? 0.5
        useInCall = (try? c.decodeIfPresent(String.self, forKey: .useInCall)) ?? ""
        chips = ((try? c.decodeIfPresent([Lenient<InsightChip>].self, forKey: .chips)) ?? []).compactMap(\.value)
        verdict = try? c.decodeIfPresent(String.self, forKey: .verdict)
        correction = try? c.decodeIfPresent(String.self, forKey: .correction)
    }
    enum CodingKeys: String, CodingKey { case id, category, claim, evidence, confidence, score, surprise, useInCall = "use_in_call", chips, verdict, correction }

    public var isMedium: Bool { confidence == "medium" }
    /// The kicker's category name (B design "n of N · Category").
    public var categoryTitle: String { InsightObservation.categoryTitle(category) }
    public static func categoryTitle(_ c: String) -> String {
        switch c {
        case "talk": "How you talk"
        case "think": "How you decide"
        case "humor": "Humor"
        case "taste": "Taste"
        case "help": "How I help"
        case "boundary": "Say-so"
        case "rhythm": "Rhythm"
        case "interest": "What you're into"
        default: c.capitalized
        }
    }
}

public struct InsightType: Codable, Hashable, Sendable {
    /// "The Playful Editor"
    public var name: String
    /// "You pick from good options, keep it light, and keep the final say."
    public var line: String
    /// exactly three ("Options", "Light", "Final say")
    public var signature: [String]
    /// ids of the observations it comes from
    public var basis: [String]
    public init(name: String, line: String, signature: [String], basis: [String] = []) { self.name = name; self.line = line; self.signature = signature; self.basis = basis }
}

/// "Options ←•——→ One answer" — only from the user's own picks.
public struct InsightMix: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var left: String
    public var right: String
    /// 0…4
    public var position: Int
    public var evidence: InsightEvidence?
}

public struct InsightStrength: Codable, Hashable, Sendable { public var text: String; public var basis: String? }
public struct InsightWatchout: Codable, Hashable, Sendable { public var text: String; public var fix: String; public var basis: String? }

public struct InsightChain: Codable, Hashable, Sendable {
    public var youAre: String
    public var soYou: String
    public var soIll: String
    enum CodingKeys: String, CodingKey { case youAre = "you_are", soYou = "so_you", soIll = "so_ill" }
}

public struct InsightShare: Codable, Hashable, Sendable {
    /// "{name} is The Playful Editor" — `title(name:)` fills it
    public var title: String
    public var lines: [String]
    public func title(name: String) -> String {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.replacingOccurrences(of: "{name}", with: n.isEmpty ? "You" : n)
    }
}

/// The old SUM four lines (collapsed under "Setup details").
public struct InsightSettings: Codable, Hashable, Sendable {
    public var why: String
    public var energy: String
    public var initiative: String
    public var never: String
    public init(why: String, energy: String, initiative: String, never: String) { self.why = why; self.energy = energy; self.initiative = initiative; self.never = never }
}

public struct InsightLearning: Codable, Hashable, Identifiable, Sendable { public var id: String; public var label: String }

public struct InsightReport: Codable, Hashable, Sendable {
    public var headline: String
    public var observations: [InsightObservation]
    public var type: InsightType?
    public var mix: [InsightMix]
    public var strengths: [InsightStrength]
    public var watchouts: [InsightWatchout]
    public var chain: InsightChain?
    public var share: InsightShare?
    public var learning: [InsightLearning]
    public var usage: String
    public var settings: InsightSettings?
    /// import · skip · answers · card
    public var from: String?

    public init(headline: String, observations: [InsightObservation], type: InsightType? = nil, mix: [InsightMix] = [], strengths: [InsightStrength] = [],
                watchouts: [InsightWatchout] = [], chain: InsightChain? = nil, share: InsightShare? = nil, learning: [InsightLearning] = [],
                usage: String = "", settings: InsightSettings? = nil, from: String? = nil) {
        self.headline = headline; self.observations = observations; self.type = type; self.mix = mix; self.strengths = strengths
        self.watchouts = watchouts; self.chain = chain; self.share = share; self.learning = learning; self.usage = usage; self.settings = settings; self.from = from
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func list<T: Decodable>(_ k: CodingKeys) -> [T] { ((try? c.decodeIfPresent([Lenient<T>].self, forKey: k)) ?? []).compactMap(\.value) }
        headline = (try? c.decodeIfPresent(String.self, forKey: .headline)) ?? ""
        observations = list(.observations)
        type = try? c.decodeIfPresent(InsightType.self, forKey: .type)
        mix = list(.mix)
        strengths = list(.strengths)
        watchouts = list(.watchouts)
        chain = try? c.decodeIfPresent(InsightChain.self, forKey: .chain)
        share = try? c.decodeIfPresent(InsightShare.self, forKey: .share)
        learning = list(.learning)
        usage = (try? c.decodeIfPresent(String.self, forKey: .usage)) ?? ""
        settings = try? c.decodeIfPresent(InsightSettings.self, forKey: .settings)
        from = try? c.decodeIfPresent(String.self, forKey: .from)
    }
    enum CodingKeys: String, CodingKey { case headline, observations, type, mix, strengths, watchouts, chain, share, learning, usage, settings, from }
}

/// `GET /v1/profile/insights?wait=s`
public struct InsightReportResponse: Decodable, Sendable {
    public enum Status: String, Decodable, Sendable { case ready, pending, failed, none }
    public var status: Status
    /// `pending` may carry the previous report (show it, then refresh)
    public var report: InsightReport?
    public init(status: Status, report: InsightReport?) { self.status = status; self.report = report }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = (try? c.decode(Status.self, forKey: .status)) ?? .none
        report = try? c.decodeIfPresent(InsightReport.self, forKey: .report)
    }
    private enum CodingKeys: String, CodingKey { case status, report }
}

extension OnboardingClient {
    /// The report; the server holds the answer up to `wait` seconds (0–8) while one is being written.
    public func insights(wait: Int = 6) async throws -> InsightReportResponse {
        let w = min(8, max(0, wait))
        return try await auth.send("GET", "/v1/profile/insights", query: "wait=\(w)", timeout: TimeInterval(w + 12))
    }

    /// The setup answers (same keys as `savePrefs`, partial is fine): the server rewrites the report in the background.
    public func insightAnswers(_ answers: [String: Any]) async throws {
        let _: GenitaAuthClient.EmptyReply = try await auth.send("POST", "/v1/profile/insights", json: ["answers": answers], timeout: 15)
    }

    /// "That's me" (`right`) / "Not quite" + Remove (`not_me`, optional correction ≤ 200). Returns the updated report.
    public func insightVerdict(id: String, verdict: String, correction: String? = nil) async throws -> InsightReport {
        var body: [String: Any] = ["verdict": verdict]
        let t = Self.correctionText(correction ?? "")
        if !t.isEmpty { body["correction"] = t }
        let safe = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? id
        return try await auth.send("POST", "/v1/profile/insights/\(safe)/verdict", json: body, timeout: 15)
    }
}
