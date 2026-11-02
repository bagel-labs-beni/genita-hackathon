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

/// F7 / #121 · MAC-RS reads a product card (`find.created`, kind `product`, #119). One place maps the card to
/// the sheet, so a change in the card's shape is a change here only:
///   sources[i]            = the product page that was actually opened (title "Name · $68", url, domain)
///   steps{text, source}   = reason chips; `source` = the product's domain (or url)
///   why + how             = the evidence lines ("Why these"), shown as the server wrote them
struct ProductPick: Equatable, Identifiable {
    var id: String { url.absoluteString }
    var name: String
    var brand: String
    var price: String?
    var url: URL
    var reasons: [String]
    /// "Northline · $68" / "Field & Co. · Price on site" (MAC-RS-b)
    var brandLine: String { "\(brand) · \(price ?? "Price on site")" }
}

struct ProductEvidence: Equatable {
    var lines: [String]
}

enum ProductPicks {
    static let maxPicks = 2

    static func picks(from card: FindCard) -> [ProductPick] {
        var out: [ProductPick] = []
        for source in card.sources {
            guard out.count < maxPicks, let url = ExternalLink.web(source.url) else { continue }
            let parts = source.title.components(separatedBy: " · ")
            let price = parts.count > 1 ? parts.last?.trimmingCharacters(in: .whitespaces) : nil
            let name = (parts.count > 1 ? parts.dropLast().joined(separator: " · ") : source.title).trimmingCharacters(in: .whitespaces)
            let domain = source.domain.isEmpty ? (url.host ?? "") : source.domain
            let reasons = card.steps.filter { step in
                guard let s = step.source?.lowercased() else { return false }
                return s == domain.lowercased() || s == source.url.lowercased()
            }.map(\.text)
            out.append(ProductPick(name: name.isEmpty ? domain : name, brand: domain, price: (price?.isEmpty ?? true) ? nil : price, url: url, reasons: reasons))
        }
        return out
    }

    static func evidence(from card: FindCard) -> ProductEvidence { ProductEvidence(lines: card.why + card.how) }
}
