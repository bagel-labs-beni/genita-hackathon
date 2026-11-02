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
    public init(id: String, name: String, tier: FindTier, from: From, count: Int? = nil, optional: Bool? = nil, box: NormBox? = nil, hint: NormBox? = nil, confirmed: Confirmed? = nil) {
        self.id = id; self.name = name; self.tier = tier; self.from = from; self.count = count; self.optional = optional
        self.box = box; self.hint = hint; self.confirmed = confirmed
    }
}

public struct FindImage: Codable, Equatable, Sendable {
    public enum Status: String, Codable, Sendable { case pending, ready, failed }
    public var slot: String
    public var status: Status
    /// Server-relative ("/v1/finds/<id>/images/<slot>"); add the server base and the token.
    public var url: String?
    public init(slot: String, status: Status, url: String? = nil) { self.slot = slot; self.status = status; self.url = url }
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
        public var title: String
        public var url: String
        public var domain: String
    }
    public struct Page: Codable, Equatable, Sendable {
        public var url: String
        public var opened: Bool
    }
    public var id: String
    public var kind: FindKind
    public var createdAt: String
    public var eyebrow: String
    public var title: String
    public var subtitle: String
    public var status: String?
    public var say: String?
    public var hero: FindImage?
    public var camera: Camera?
    public var items: [FindItem]
    public var steps: [Step]
    public var options: [Option]
    public var why: [String]
    public var ask: [String]
    public var sources: [Source]
    public var how: [String]
    public var page: Page?
    public var saved: Bool?
    /// kind `product` (PF-1 / MAC-RS): product detail pages the search really opened (≤ 2).
    public var products: [Product]?
    /// kind `product`: the import line and the situation line this answer is based on.
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
        public var subtitle: String?
        public var status: String?
    }
    public struct ObserveBoxes: Codable, Equatable, Sendable {
        public struct Item: Codable, Equatable, Sendable {
            public var label: String
            public var box: NormBox
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
    }
    public struct FindFailed: Codable, Equatable, Sendable {
        public enum Reason: String, Codable, Sendable { case unclear, searchFailed = "search_failed", error, stopped }
        public var findId: String
        public var reason: Reason
        public var message: String
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
