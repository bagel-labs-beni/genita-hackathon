import Foundation

// Visual Finds cards (r02 mock 6rTNaagEG4qFYQ5FvCqyhU, contract ./_qa-scripts/genita-visual/CONTRACT.md v1).
// One place decides which layout a card gets and how an ingredient / place reads, so the iPhone sheet and the
// Mac sheet show the same answer the same way. Every field is optional: an old server's card lays out as before.

/// The per-info layout a card is drawn with.
enum FindCardLayout: Equatable, Sendable {
    case recipe, outfit, product, place, howTo, general
}

extension FindCard {
    /// `layout` from the server when this build knows it and the card has what it needs; else by `kind` (as before).
    var cardLayout: FindCardLayout {
        // an outfit keeps its own layout whatever the hint says (contract §4: the server sets none on outfits)
        if kind == .outfit { return .outfit }
        switch layout {
        case .recipe? where kind == .recipe || !items.isEmpty: return .recipe
        case .product? where !(products ?? []).isEmpty: return .product
        case .place? where !sources.isEmpty: return .place
        case .howTo? where !steps.isEmpty: return .howTo
        case .general?: return kind == .recipe ? .recipe : kind == .product && !(products ?? []).isEmpty ? .product : .general
        default: break
        }
        switch kind {
        case .recipe: return .recipe
        case .product: return (products ?? []).isEmpty ? .general : .product
        case .outfit: return .outfit
        case .link, .unknown: return .general
        }
    }

    /// Which result leads with the big photo (r01 top pick): row 0 when it has its own picture (or one is loading);
    /// else the first row whose picture landed (contract v2: `hero` can come from another row, so it never goes under
    /// row 0's name); else row 0 with `hero` when no row has a picture of its own (an older server sends #1's og:image
    /// only as `hero`). nil → rows only.
    /// `ok`: the page's own check (b16: a picture that failed to load is skipped, the next one leads; none → no hero).
    var topPick: (index: Int, photo: FindImage)? { topPick(usable: { _ in true }) }

    func topPick(usable ok: (FindImage) -> Bool) -> (index: Int, photo: FindImage)? {
        guard !sources.isEmpty else { return nil }
        func usable(_ i: FindImage?) -> FindImage? { i.flatMap { $0.status == .failed || !ok($0) ? nil : $0 } }
        if let img = usable(sources[0].image) { return (0, img) }
        if let i = sources.indices.first(where: { usable(sources[$0].image)?.status == .ready }), let img = sources[i].image { return (i, img) }
        if !sources.contains(where: { usable($0.image) != nil }), let h = usable(hero) { return (0, h) }
        return nil
    }

    /// The dish photo above the ingredients: only on a recipe with no camera frame (a named dish), and only a
    /// picture that is there or still coming (never an empty box for one that failed).
    var dishPhoto: FindImage? {
        guard cardLayout == .recipe, camera == nil, let hero, hero.status != .failed else { return nil }
        return hero
    }
}

extension FindItem {
    /// "cooked rice · 2 cups" (#749 keeps the amount in the name for older apps) → "cooked rice".
    var tileName: String {
        let parts = Self.split(name)
        return parts.name.prefix(1).uppercased() + parts.name.dropFirst()
    }

    /// The amount under the tile: the part after " · " in the name; nil when there is none.
    var tileAmount: String? { Self.split(name).amount }

    /// The initial on a tile with no photo.
    var tileInitial: String { String(tileName.prefix(1)).uppercased() }

    /// A picture to draw on the tile: ready (or still loading on an older server); nil → the initial tile.
    var tilePicture: FindImage? { image.flatMap { $0.status == .failed ? nil : $0 } }

    static func split(_ raw: String) -> (name: String, amount: String?) {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let r = t.range(of: " · ", options: .backwards) else { return (t, nil) }
        let name = t[..<r.lowerBound].trimmingCharacters(in: .whitespaces)
        let amount = t[r.upperBound...].trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return (t, nil) }
        return (name, amount.isEmpty ? nil : amount)
    }
}

extension FindCard.Source.Place {
    /// "4.6" (one decimal), nil when the rating is missing or out of 0...5.
    var ratingText: String? {
        guard let r = rating, r > 0, r <= 5 else { return nil }
        return String(format: "%.1f", r)
    }

    /// "(1,203)", nil when there is no count.
    var reviewsText: String? {
        guard let n = reviews, n > 0 else { return nil }
        let f = NumberFormatter(); f.numberStyle = .decimal; f.locale = Locale(identifier: "en_US")
        return "(" + (f.string(from: NSNumber(value: n)) ?? String(n)) + ")"
    }

    /// "Open until 10 PM" reads green; anything else plain.
    var hoursSayOpen: Bool { hours?.lowercased().hasPrefix("open") == true }

    /// A maps link that opens (http/https or the maps: scheme); nil → no Map button.
    var mapLink: URL? {
        guard let raw = mapUrl?.trimmingCharacters(in: .whitespaces), let url = URL(string: raw), let scheme = url.scheme?.lowercased(),
              ["https", "http", "maps"].contains(scheme) else { return nil }
        return url
    }

    /// One VoiceOver line: "Rated 4.6, 1,203 reviews. Open until 10 PM. 123 Jungbu-daero".
    var accessibilityText: String {
        [ratingText.map { "Rated \($0)" + (reviews.map { ", \($0) reviews" } ?? "") }, hours, address]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ". ")
    }
}

extension FindCard.Source {
    /// The place name: the title without a " — why" tail.
    var placeName: String {
        let t = displayTitle
        if why == nil, let r = t.range(of: " — ") { return String(t[..<r.lowerBound]) }
        return t
    }
}

extension FindCard {
    /// The first picture that is really there (`ready`): hero, then results, products, steps, ingredients. nil → none.
    var firstReadyPicture: FindImage? {
        let all: [FindImage?] = [hero] + sources.map(\.image) + (products ?? []).map(\.image) + steps.map(\.image) + items.map(\.image)
        return all.compactMap { $0 }.first { $0.status == .ready && $0.url != nil }
    }

    /// The card without the pictures that failed to load here (keyed by url, else slot): every layout then treats them
    /// as missing and draws no box for them (b16, Chelsea 11/4 "never show empty picture content").
    func hidingPhotos(_ broken: Set<String>) -> FindCard {
        guard !broken.isEmpty else { return self }
        func keep(_ i: FindImage?) -> FindImage? {
            guard let i else { return nil }
            return broken.contains(i.url ?? i.slot) ? nil : i
        }
        var c = self
        c.hero = keep(c.hero)
        for k in c.sources.indices { c.sources[k].image = keep(c.sources[k].image) }
        for k in c.items.indices { c.items[k].image = keep(c.items[k].image) }
        for k in c.steps.indices { c.steps[k].image = keep(c.steps[k].image) }
        if var p = c.products {
            for k in p.indices { p[k].image = keep(p[k].image) }
            c.products = p
        }
        return c
    }
}
