// F8-U-INT · What the interpretation screens show, derived from server events.
// Pure value type: feed it every ServerEvent (and the local hold state) and
// read the bar, the speaker line, the bubbles and the hold button from it.
// Screens: iPhone INT-1~6, Mac INT-M1/M2 (design-flow r01 board, section 8).

import Foundation

public struct InterpretBoard: Equatable, Sendable {
    public typealias Bubble = ServerEvent.InterpretBubble

    public enum Route: Equatable, Sendable {
        /// face to face: the phone's speaker, as usual
        case normal
        /// Mac call, translation of the other person: the user's headphones only, quietly
        case whisper
        /// Mac call, the user's reply in the other language: the Mac speaker the call app's mic hears
        case speaker
    }

    public struct Bar: Equatable, Sendable {
        public var title: String
        public var subtitle: String
        public var warn: Bool
    }

    public struct SpeakerLine: Equatable, Sendable {
        public enum Who: Equatable, Sendable { case them, you, companion }
        public var who: Who
        public var name: String
        public var detail: String
        /// someone is talking right now (wave)
        public var live: Bool
    }

    public var active = false
    public var source: InterpretOptions.Source = .face
    public var app: String?
    public var user = "English"
    public var other: String?
    public var companionName: String
    public var holding = false
    /// every bubble the server sent, by id (skipped ones removed)
    public private(set) var bubbles: [Bubble] = []
    /// the newest bubble could not be passed on (INT-6)
    public var unclear: Bool { bubbles.last?.status == .unknown && bubbles.last?.reason == "language_unclear" }

    public init(companionName: String = "Jin") {
        self.companionName = companionName
    }

    // MARK: input

    public mutating func apply(_ event: ServerEvent) {
        switch event {
        case let .interpretPair(p):
            active = true
            user = p.user
            other = p.other
            source = p.source
            app = p.app
        case let .interpretBubble(b):
            if let i = bubbles.firstIndex(where: { $0.bubbleId == b.bubbleId }) {
                if b.status == .skipped || b.status == .cancelled { bubbles.remove(at: i) } else { bubbles[i] = b }
            } else if b.status != .skipped && b.status != .cancelled {
                bubbles.append(b)
                bubbles.sort { $0.bubbleId < $1.bubbleId }
                if bubbles.count > 20 { bubbles.removeFirst(bubbles.count - 20) }
            }
        case let .modeChanged(m):
            if m.mode == .chat { self = InterpretBoard(companionName: companionName) } else { active = true }
        case let .ready(r):
            if r.mode == .chat { active = false }
        default:
            break
        }
    }

    // MARK: output

    public var pairLabel: String? {
        guard let other else { return nil }
        return "\(other) ↔ \(user)"
    }

    public var bar: Bar {
        if unclear { return Bar(title: "Couldn’t tell the language", subtitle: "I didn’t pass that on. Say it again?", warn: true) }
        if source == .call {
            let app = app ?? "Call"
            guard let pairLabel else { return Bar(title: "\(app) · Interpreting", subtitle: "Call sound in · listening for their language", warn: false) }
            if let b = bubbles.last, b.speaker == .me, b.status != .done || holding, let to = b.translation?.lang ?? other {
                return Bar(title: "\(app) · \(pairLabel)", subtitle: "Your reply goes out in \(to)", warn: false)
            }
            return Bar(title: "\(app) · \(pairLabel)", subtitle: "Call sound in · whispering to you", warn: false)
        }
        guard let pairLabel else { return Bar(title: "Interpreting", subtitle: "Listening for the other language", warn: false) }
        return Bar(title: pairLabel, subtitle: "Detected automatically", warn: false)
    }

    /// Bubbles to draw, oldest first; only the newest one is at full strength.
    public var visible: [Bubble] { unclear ? Array(bubbles.suffix(1)) : Array(bubbles.suffix(2)) }

    public func isFaint(_ b: Bubble) -> Bool {
        b.bubbleId != bubbles.last?.bubbleId || b.status == .unknown
    }

    /// INT-1 explainer while nothing has been heard yet.
    public var showsIntro: Bool { bubbles.isEmpty && source == .face }

    public var speakerLine: SpeakerLine? {
        guard let b = bubbles.last else { return nil }
        if b.status == .unknown { return SpeakerLine(who: .them, name: "Them", detail: "Not sure", live: false) }
        let to = b.translation?.lang
        switch b.status {
        case .hearing:
            if b.speaker == .me || holding { return SpeakerLine(who: .you, name: "You", detail: b.original.lang ?? user, live: true) }
            return SpeakerLine(who: .them, name: "Them", detail: b.original.lang ?? "Listening…", live: true)
        case .translating, .speaking:
            guard let to else { return nil }
            let detail: String
            if source == .call {
                detail = b.speaker == .them ? "whispering in \(to), headphones only" : "speaking \(to) through your speaker"
            } else {
                detail = "saying it in \(to)"
            }
            return SpeakerLine(who: .companion, name: companionName, detail: detail, live: b.status == .speaking)
        case .done:
            if b.speaker == .me { return SpeakerLine(who: .you, name: "You", detail: b.original.lang ?? user, live: false) }
            return SpeakerLine(who: .them, name: "Them", detail: b.original.lang ?? "", live: false)
        case .skipped, .cancelled, .unknown:
            return nil
        }
    }

    public var holdTitle: String {
        if source == .call { return holding ? "Release to send" : "Hold to reply" }
        return holding ? "Release to translate" : "Hold to talk in \(user)"
    }

    public var holdNote: String {
        if source == .call {
            let to = other ?? "their language"
            return holding ? "\(companionName) says it in \(to) after you let go." : "Say it in \(user). They hear \(companionName) say it in \(to)."
        }
        return holding ? "Only your voice goes through while you hold." : "Or just talk. I tell you apart by language."
    }

    /// Mac call mode: where an utterance's audio should play.
    public func route(utteranceId: Int) -> Route {
        guard active, source == .call, let b = bubbles.last(where: { $0.utteranceId == utteranceId }) else { return .normal }
        return b.speaker == .me ? .speaker : .whisper
    }

    /// More sheet row subtitle (INT-0): "On · Korean ↔ English".
    public var moreSubtitle: String {
        guard active else { return "Off" }
        return "On · " + (pairLabel ?? "listening")
    }
}
