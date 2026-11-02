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
        guard let first = basis(card) else { return ProductEvidence(lines: card.why + card.how) }
        let domains = picks(from: card).map(\.domain)
        let from = card.evidence?.style.isEmpty == false ? "From your import and what you said" : "From what you said"
        return ProductEvidence(lines: [first, ([from] + domains).joined(separator: " · ")])
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
    static func message(status: Int?) -> String? {
        switch status {
        case nil: "Couldn’t reach the server. Check your connection."
        case let s? where (200..<300).contains(s): nil
        case 401?: "That code didn’t work. Check it and try again."
        case 429?: "Too many tries. Wait 10 minutes and try again."
        default: "Judge access isn’t available right now."
        }
    }
}
