// Finds wire types (F5-L3, F5-L8, F10). Twin of the Finds section in
// genita-server/src/protocol.ts; contract in genita-server/PROTOCOL.md.

import Foundation

public enum FindKind: String, Codable, Sendable {
    case recipe, outfit, link, product, unknown
    /// A kind this build does not know decodes as `.unknown` (a newer server must not break the Finds list).
    public init(from decoder: Decoder) throws {
        self = FindKind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
    }
}

/// Per-info card layout hint (visual-everything 11/4). Separate from `kind`; absent → lay out by `kind` as before.
/// Wire values: recipe, product, place, how-to, general. A value this build does not know decodes as `.unknown`.
public enum FindLayout: String, Codable, Sendable {
    case recipe, product, place, howTo = "how-to", general, unknown
    public init(from decoder: Decoder) throws {
        self = FindLayout(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
    }
}

/// checking → have (Spark YES + SAM box) | maybe ("맞아?") | buy (recipe only).
public enum FindTier: String, Codable, Sendable { case checking, have, maybe, buy }

/// 0...1 of the camera frame the box was found on.
public struct NormBox: Codable, Equatable, Hashable, Sendable {
    public var x1: Double
    public var y1: Double
    public var x2: Double
    public var y2: Double
    public init(x1: Double, y1: Double, x2: Double, y2: Double) { self.x1 = x1; self.y1 = y1; self.x2 = x2; self.y2 = y2 }
}

/// SAM 3.1 pixel mask over an item's box (server GENITA_SAM_MASKS=1, #298): a `w`×`h` grid stretched over the box,
/// row-major run lengths alternating 0s and 1s, starting with 0s (the first run may be 0); sum(rle) == w*h, long side ≤ 96.
public struct NormMask: Codable, Equatable, Hashable, Sendable {
    public var w: Int
    public var h: Int
    public var rle: [Int]
    public init(w: Int, h: Int, rle: [Int]) { self.w = w; self.h = h; self.rle = rle }
    public static let maxSide = 96

    /// One byte per cell, 255 = inside. nil when the runs don't add up (a bad mask is dropped, the box still draws).
    public func bitmap() -> [UInt8]? {
        guard w > 0, h > 0, w <= Self.maxSide, h <= Self.maxSide else { return nil }
        // summed run by run so a huge run can't overflow (Codex P2): each must fit in what is left
        var total = 0
        for run in rle {
            guard run >= 0, run <= w * h - total else { return nil }
            total += run
        }
        guard total == w * h else { return nil }
        var out = [UInt8](repeating: 0, count: w * h)
        var i = 0
        for (k, run) in rle.enumerated() {
            if k % 2 == 1 { for j in i..<(i + run) { out[j] = 255 } }
            i += run
        }
        return out
    }

    /// The outline: inside cells with an outside (or off-grid) 4-neighbour. Same layout as `bitmap()`.
    public func edgeBitmap() -> [UInt8]? {
        guard let b = bitmap() else { return nil }
        var out = [UInt8](repeating: 0, count: w * h)
        for y in 0..<h {
            for x in 0..<w where b[y * w + x] != 0 {
                let edge = x == 0 || y == 0 || x == w - 1 || y == h - 1
                    || b[y * w + x - 1] == 0 || b[y * w + x + 1] == 0 || b[(y - 1) * w + x] == 0 || b[(y + 1) * w + x] == 0
                if edge { out[y * w + x] = 255 }
            }
        }
        return out
    }
}

public struct FindItem: Codable, Equatable, Identifiable, Sendable {
    public enum From: String, Codable, Sendable { case camera, recipe, both }
    public enum Confirmed: String, Codable, Sendable { case yes, no }
    public var id: String
    public var name: String
    public var tier: FindTier
    public var from: From
    public var count: Int?
    public var optional: Bool?
    /// SAM box for the name (only on `have`).
    public var box: NormBox?
    /// SAM box for how it looks — a hint on `maybe`, never proof.
    public var hint: NormBox?
    public var confirmed: Confirmed?
    /// The ingredient's photo (find.image slot `ingredient-<id>`, keyed by `id`, not position); only ever `ready`.
    public var image: FindImage?
    public init(id: String, name: String, tier: FindTier, from: From, count: Int? = nil, optional: Bool? = nil, box: NormBox? = nil, hint: NormBox? = nil, confirmed: Confirmed? = nil, image: FindImage? = nil) {
        self.id = id; self.name = name; self.tier = tier; self.from = from; self.count = count; self.optional = optional
        self.box = box; self.hint = hint; self.confirmed = confirmed; self.image = image
    }

    /// find.image slot prefix for an ingredient's photo: `ingredient-<item id>`.
    public static let imageSlotPrefix = "ingredient-"
    /// The item id an `ingredient-<id>` slot names; nil for any other slot.
    public static func itemId(forImageSlot slot: String) -> String? {
        guard slot.hasPrefix(imageSlotPrefix), slot.count > imageSlotPrefix.count else { return nil }
        return String(slot.dropFirst(imageSlotPrefix.count))
    }
}

public struct FindImage: Codable, Equatable, Sendable {
    public enum Status: String, Codable, Sendable { case pending, ready, failed }
    public var slot: String
    public var status: Status
    /// Server-relative ("/v1/finds/<id>/images/<slot>"); add the server base and the token.
    public var url: String?
    /// "generated": Muse Image made it (no photo was found) — label it "Illustration". nil = a real photo.
    public var source: String?
    /// true (always with status `failed`): there will be no picture for this slot — draw no box at all.
    public var omit: Bool?
    public init(slot: String, status: Status, url: String? = nil, source: String? = nil, omit: Bool? = nil) {
        self.slot = slot; self.status = status; self.url = url; self.source = source; self.omit = omit
    }
    public var isGenerated: Bool { source == "generated" }
    public var isOmitted: Bool { omit == true }
}

public struct FindCard: Codable, Equatable, Identifiable, Sendable {
    public struct Camera: Codable, Equatable, Sendable {
        /// index into the frames the app sent with the question; the app keeps the frame, the server never stores it
        public var frame: Int
        public var at: String
        public var w: Int
        public var h: Int
        public var label: String
    }
    public struct Step: Codable, Equatable, Sendable {
        public var text: String
        public var source: String?
        public var image: FindImage?
        public init(text: String, source: String? = nil, image: FindImage? = nil) { self.text = text; self.source = source; self.image = image }
    }
    public struct Option: Codable, Equatable, Sendable {
        public var label: String
        public var frame: Int
        public var picked: Bool
        public var box: NormBox?
    }
    public struct Source: Codable, Equatable, Sendable {
        /// layout `place`: what the search said about the place; any field may be missing (draw only what is there)
        public struct Place: Codable, Equatable, Sendable {
            public var address: String?
            /// 0...5
            public var rating: Double?
            public var reviews: Int?
            public var hours: String?
            /// a maps link the server built from the name and address
            public var mapUrl: String?
            public init(address: String? = nil, rating: Double? = nil, reviews: Int? = nil, hours: String? = nil, mapUrl: String? = nil) {
                self.address = address; self.rating = rating; self.reviews = reviews; self.hours = hours; self.mapUrl = mapUrl
            }
        }
        public var title: String
        public var url: String
        public var domain: String
        /// Finds r01: why this result (≤ 18 words). Older servers send none (the reason then rides on `title` as
        /// "Title — why", or on the matching step).
        public var why: String?
        /// Finds r01: the page's og:image, slot `source-<i>` (0-based index into `sources`); only ever `ready`.
        public var image: FindImage?
        /// Finds r01: the site's icon (server-relative or absolute). nil → the app draws a domain-initial tile.
        public var favicon: String?
        /// layout `place`: rating, hours, address, maps link
        public var place: Place?
        public init(title: String, url: String, domain: String, why: String? = nil, image: FindImage? = nil, favicon: String? = nil, place: Place? = nil) {
            self.title = title; self.url = url; self.domain = domain; self.why = why; self.image = image; self.favicon = favicon; self.place = place
        }

        /// The title without the " — why" tail the server keeps on it for old apps (r01: the reason shows once).
        public var displayTitle: String {
            let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
            if let w = why?.trimmingCharacters(in: .whitespacesAndNewlines), !w.isEmpty {
                for sep in [" — ", " – ", " - "] where t.hasSuffix(sep + w) { return String(t.dropLast(sep.count + w.count)) }
                if let r = t.range(of: " — ") { return String(t[..<r.lowerBound]) }
            }
            return t
        }
    }
    /// `from` profile = blue "Your style/taste: …" (import, HISY corrections) · call = grey "You said: …" (this call)
    public struct Reason: Codable, Equatable, Sendable {
        public var text: String
        /// the profile line it comes from
        public var source: String
        public var from: String?
        public init(text: String, source: String, from: String? = nil) { self.text = text; self.source = source; self.from = from }
    }
    public struct Page: Codable, Equatable, Sendable {
        public var url: String
        public var opened: Bool
    }
    public var id: String
    public var kind: FindKind
    /// visual-everything: which per-info layout to draw (nil → by `kind`, as before)
    public var layout: FindLayout?
    public var createdAt: String
    public var eyebrow: String
    public var title: String
    public var subtitle: String
    public var status: String?
    public var say: String?
    /// The status pill's line, ≤ 28 characters (one line on both devices). `say` is spoken; this is shown.
    public var pill: String?
    public var hero: FindImage?
    public var camera: Camera?
    public var items: [FindItem]
    public var steps: [Step]
    public var options: [Option]
    public var why: [String]
    public var ask: [String]
    public var sources: [Source]
    /// Lane 개인화: 1–2 reason chips (optional: older servers and cards without a matching taste line send none)
    public var reasons: [Reason]?
    public var how: [String]
    public var page: Page?
    public var saved: Bool?
    /// kind `product` (PF-1 / MAC-RS): product detail pages the search really opened (≤ 2).
    public var products: [Product]?
    /// kind `product`: the import line and the situation line this answer is based on; kind `outfit`: the taste line
    /// and the occasion they named ("this weekend", CW-02).
    public var evidence: Evidence?

    public struct Product: Codable, Equatable, Identifiable, Sendable {
        public var id: String
        public var name: String
        public var url: String
        public var domain: String
        public var store: String
        /// only when the page showed it; nil → "Price on site"
        public var price: String?
        public var image: FindImage?
        /// blue chip: from the user's import (Likes & dislikes)
        public var taste: String
        /// grey chip: from what they said (weekend, weather)
        public var situation: String
        public init(id: String, name: String, url: String, domain: String, store: String, price: String? = nil, image: FindImage? = nil, taste: String, situation: String) {
            self.id = id; self.name = name; self.url = url; self.domain = domain; self.store = store; self.price = price; self.image = image
            self.taste = taste; self.situation = situation
        }
    }
    public struct Evidence: Codable, Equatable, Sendable {
        public var style: String
        public var situation: String
        public init(style: String, situation: String) { self.style = style; self.situation = situation }
    }
}

extension ServerEvent {
    public struct FindStarted: Codable, Equatable, Sendable {
        public var findId: String
        public var utteranceId: Int
        public var kind: FindKind
        public var title: String
        public var detail: String
        /// product search: the import line it follows (show as-is when present)
        public var evidence: FindCard.Evidence?
    }
    public struct FindProgress: Codable, Equatable, Sendable {
        public var findId: String
        public var detail: String
        /// product search: the import line the picks follow, once known
        public var evidence: FindCard.Evidence?
    }
    public struct FindItems: Codable, Equatable, Sendable {
        public var findId: String
        public var items: [FindItem]
        public var checking: Bool
        /// the card's pill line once it is known (fridge: after the checks)
        public var pill: String?
        public var subtitle: String?
        public var status: String?
    }
    public struct ObserveBoxes: Codable, Equatable, Sendable {
        public struct Item: Codable, Equatable, Sendable {
            public var label: String
            public var box: NormBox
            /// GENITA_SAM_MASKS=1: the item's pixel mask; then the same label may repeat (one item per match)
            public var mask: NormMask?
            public init(label: String, box: NormBox, mask: NormMask? = nil) { self.label = label; self.box = box; self.mask = mask }
        }
        public var findId: String
        public var frame: Int
        public var w: Int
        public var h: Int
        public var items: [Item]
    }
    public struct FindCreated: Codable, Equatable, Sendable {
        public var findId: String
        public var card: FindCard
    }
    public struct FindImageEvent: Codable, Equatable, Sendable {
        public var findId: String
        public var slot: String
        public var status: FindImage.Status
        public var url: String?
        /// "generated": a Muse Image picture (label it "Illustration")
        public var source: String?
        /// true (with status `failed`): no picture will come for this slot — remove its box
        public var omit: Bool?
        /// slot `product-N` only, with omit: the product that takes this slot's place (its image is ready, same slot)
        public var replace: FindCard.Product?
    }
    public struct FindFailed: Codable, Equatable, Sendable {
        public enum Reason: String, Codable, Sendable { case unclear, searchFailed = "search_failed", error, stopped }
        public var findId: String
        public var reason: Reason
        public var message: String
        public init(findId: String, reason: Reason, message: String) { self.findId = findId; self.reason = reason; self.message = message }
    }
}

extension ClientMessage {
    public struct FindConfirm: Codable, Equatable, Sendable {
        public var findId: String
        public var itemId: String
        public var yes: Bool
        public init(findId: String, itemId: String, yes: Bool) { self.findId = findId; self.itemId = itemId; self.yes = yes }
    }
}

extension FindCard {
    /// The outfit card's occasion chip (춘식이 11/4, CW-02): the server's situation reason ("Easy to wear all weekend",
    /// "Beige trench for dinner tonight.") as is; sentence case, no trailing period. nil when there is none (no row at all).
    public var occasionChip: (text: String, accessibilityLabel: String)? {
        guard kind == .outfit, let line = evidence.map({ Self.reasonLine($0.situation) }), !line.isEmpty else { return nil }
        return (line.prefix(1).uppercased() + line.dropFirst(), "Occasion: " + line)
    }

    /// The "Why" lines to list: on an outfit card whose occasion is already the chip, its copy in `why` is left out.
    public var whyLines: [String] {
        guard occasionChip != nil, let situation = evidence.map({ Self.reasonLine($0.situation).lowercased() }) else { return why }
        return why.filter { Self.reasonLine($0).lowercased() != situation }
    }

    private static func reasonLine(_ raw: String) -> String {
        var line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while line.hasSuffix(".") { line.removeLast() }
        return line.trimmingCharacters(in: .whitespaces)
    }
}
