import Foundation

/// F9 · #118 · What the Mac sends in `start`, from the account's companion on the server
/// (`GET /v1/companion`, PREP_API.md). The Mac has no onboarding of its own (PRD F1: consent, name and
/// companion all come from the iPhone), so the name and persona always come from the server — never a
/// name baked into the app.
struct CompanionCallPlan: Equatable {
    var name: String
    var start: ClientMessage.Start
    /// The companion's scene picture (prep `sceneUrl`), absolute or server-relative.
    var faceURL: String?

    private struct Wire: Decodable {
        struct Prep: Decodable { var sceneUrl: String? }
        struct Session: Decodable {
            var persona: ClientMessage.Persona?
            var user: ClientMessage.User?
            var voiceId: String?
        }
        var name: String?
        var type: ClientMessage.Persona.Kind?
        var voiceId: String?
        var prep: Prep?
        var session: Session?
    }

    init?(companionJSON data: Data) {
        guard let w = try? JSONDecoder().decode(Wire.self, from: data) else { return nil }
        let name = (w.name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return nil }
        // The record's name wins: a rename (PATCH /v1/companion, or by voice) doesn't rewrite the persona card.
        var persona = w.session?.persona ?? ClientMessage.Persona(name: name, kind: w.type)
        persona.name = name
        if persona.kind == nil { persona.kind = w.type }
        var user = w.session?.user ?? ClientMessage.User()
        user.timeZone = user.timeZone ?? TimeZone.current.identifier
        self.name = name
        self.start = ClientMessage.Start(persona: persona, user: user, voiceId: w.session?.voiceId ?? w.voiceId)
        let scene = w.prep?.sceneUrl?.trimmingCharacters(in: .whitespaces)
        self.faceURL = (scene?.isEmpty ?? true) ? nil : scene
    }

    /// `sceneUrl` on the server's host when it's a path.
    func faceURL(base: URL) -> URL? {
        guard let faceURL else { return nil }
        if let absolute = ExternalLink.web(faceURL) { return absolute }
        guard faceURL.hasPrefix("/") else { return nil }
        return URL(string: faceURL, relativeTo: base)?.absoluteURL
    }
}

/// Links the app hands to the default browser (MAC-LINK): web pages only — never `file:`, `javascript:` or
/// the app's own `genita:` scheme, whatever a card says.
enum ExternalLink {
    static func web(_ raw: String) -> URL? {
        guard let url = URL(string: raw.trimmingCharacters(in: .whitespaces)), let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http", let host = url.host, !host.isEmpty else { return nil }
        return url
    }
}

/// F7 / #121 · MAC-RS reads a product card (`find.created`, kind `product`, server #171). One place maps the
/// card to the sheet, so a change in the card's shape is a change here only:
///   products[≤2]  = product detail pages the search really opened {name, store, price?, url, domain, image?, taste, situation}
///   evidence      = {style: the import line the blue chips stand on, situation: what they said (+ weather)}
/// Same fields as the iPhone's PF-1 (`FindCardPage.product`), so both devices show one answer the same way.
struct ProductPick: Equatable, Identifiable {
    var id: String
    var name: String
    var store: String
    var price: String?
    var url: URL
    var domain: String
    var image: FindImage?
    /// blue chip (from the import), empty when there is no import
    var taste: String
    /// grey chip (from what they said)
    var situation: String
    /// "Northline · $68" / "Field & Co. · Price on site" (MAC-RS-b)
    var brandLine: String { "\(store) · \(price ?? "Price on site")" }
}

struct ProductEvidence: Equatable {
    var lines: [String]
}

enum ProductPicks {
    static let maxPicks = 2

    /// Web pages only (`ExternalLink.web`), at most two — the server already dropped anything it didn't open.
    static func picks(from card: FindCard) -> [ProductPick] {
        let out: [ProductPick] = (card.products ?? []).compactMap { p in
            guard let url = ExternalLink.web(p.url) else { return nil }
            let domain = p.domain.isEmpty ? (url.host ?? "") : p.domain
            let store = p.store.trimmingCharacters(in: .whitespaces)
            let price = p.price?.trimmingCharacters(in: .whitespaces)
            return ProductPick(id: p.id, name: p.name.isEmpty ? domain : p.name, store: store.isEmpty ? domain : store,
                               price: (price?.isEmpty ?? true) ? nil : price, url: url, domain: domain, image: p.image,
                               taste: p.taste, situation: p.situation)
        }
        return Array(out.prefix(maxPicks))
    }

    /// "Why these" (D25): the server's own evidence, word for word —
    ///   “{import style line}” · {situation}
    ///   From your import and what you said · {source 1} · {source 2}
    /// Cards from before #171 carry no `evidence`: their `why` + `how` lines as written.
    static func evidence(from card: FindCard) -> ProductEvidence {
        guard let first = basis(card) else { return ProductEvidence(lines: card.why + card.how.filter { !isLegend($0) }) }
        return ProductEvidence(lines: [first, sourceLine(card)])
    }

    // D4 (Chelsea 04:53): no colour legend — each chip says where it came from with a mark in front of it.
    /// ✦ = your style (from the import) · “ = what you said
    static let styleMark = "✦"
    static let saidMark = "“"
    /// The server's old legend line ("Blue: your style, from your import. Grey: what you said.").
    static func isLegend(_ line: String) -> Bool { line.hasPrefix("Blue:") || line.hasPrefix("Grey:") }
    /// "From your style and what you said · northline.com +1" (iPhone PF-1 and Mac "Why these" alike).
    static func sourceLine(_ card: FindCard) -> String {
        // the server's evidence decides; a card without it (saved before #171) counts a style chip as style
        let style = card.evidence.map { !$0.style.trimmingCharacters(in: .whitespaces).isEmpty } ?? (card.products ?? []).contains { !$0.taste.isEmpty }
        let from = style ? "From your style and what you said" : "From what you said"
        var domains: [String] = []
        // sites, not products: two picks from one shop are one site (as the server counts them)
        for d in picks(from: card).map(\.domain) + card.sources.map(\.domain) where !d.isEmpty && !domains.contains(d) { domains.append(d) }
        guard let first = domains.first else { return from }
        return from + " · " + first + (domains.count > 1 ? " +\(domains.count - 1)" : "")
    }

    /// MF-1 "Why" while searching: the import line the last product answer of this call stood on. Only the style —
    /// it belongs to the account; the situation belonged to that search, and a new ask may be about something else.
    /// A first search has no line — `find.started`/`find.progress` carry no evidence yet (server follow-up).
    static func searchingWhy(after earlier: [FindCard]) -> String? {
        guard let style = earlier.last(where: { $0.kind == .product })?.evidence?.style.trimmingCharacters(in: .whitespaces), !style.isEmpty else { return nil }
        return "“\(style)”"
    }

    private static func basis(_ card: FindCard) -> String? {
        guard let e = card.evidence else { return nil }
        let style = e.style.trimmingCharacters(in: .whitespaces)
        let parts = [style.isEmpty ? "" : "“\(style)”", e.situation.trimmingCharacters(in: .whitespaces)].filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// #211 (Chelsea 11/3): the Mac call pill is one line. A spoken answer longer than the pill shows its first
/// sentence ("I found two. Their simple cuts match your style." → "I found two."); `OneLineText` then
/// shortens by whole words if even that doesn't fit. The text is always the server's, never app copy.
enum CueLine {
    /// Shorter versions to try after the whole line, longest first. Empty for a single sentence.
    static func summaries(_ said: String) -> [String] {
        // a sentence ends at . ! ? followed by a space and a capital ("$68.50", "Field & Co. has" don't end one)
        let text = said.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let r = text.range(of: #"[.!?]\s+(?=[A-Z“"'])"#, options: .regularExpression) else { return [] }
        return [String(text[..<r.lowerBound]) + String(text[r.lowerBound])]
    }
}

/// A02-J on the Mac (PRD v12 D41, server #166 `POST /auth/judge`): a code instead of an Apple ID.
/// Same request and answers as GenitaKit's `signInWithJudgeCode` (#166), with `device: "mac"`.
enum JudgeAccess {
    static func request(code: String, base: URL) -> URLRequest? {
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let body = try? JSONSerialization.data(withJSONObject: ["code": trimmed, "device": "mac"]) else { return nil }
        var req = URLRequest(url: base.appendingPathComponent("auth/judge"))
        req.httpMethod = "POST"
        req.timeoutInterval = 20
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = body
        return req
    }

    /// The one line under the field; nil = signed in. `status` nil = no answer at all.
    /// `retryAfterSec`: a 429's wait from the server (11/4), shown in whole minutes.
    static func message(status: Int?, retryAfterSec: Int? = nil) -> String? {
        switch status {
        case nil: "Couldn’t reach the server. Check your connection."
        case let s? where (200..<300).contains(s): nil
        case 401?: "That code didn’t work. Check it and try again."
        case 429?: retryAfterSec.map { "Too many tries. Try again in \(max(1, ($0 + 59) / 60)) min." } ?? "Too many tries. Wait 10 minutes and try again."
        default: "Judge access isn’t available right now."
        }
    }
}
