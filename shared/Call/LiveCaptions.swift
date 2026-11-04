import Foundation

/// Live captions r01 (춘식이, approved 11/4): the user's words under the face while they talk (bars → check = "heard
/// you"), then the companion's reply revealed word by word in time with its voice.
/// Spec: ./_qa-scripts/genita-design/live-caption-spec.md · board https://claude.ai/artifact/KmqapQe5rtKNy45aua6k3e
///
/// A pure value: server events go in through `apply`, and the view asks for a `Frame` every display tick with the
/// clock, the local mic level and the reply's playhead. No timers: every time rule (CAP-1 150 ms, X1 1200 ms,
/// X2 1500 + 1600 ms, CAP-6 5 s) is read off `now`, so unit tests drive it with numbers.
struct LiveCaptions: Equatable {
    enum YouPhase: Equatable { case sound, words, heard, missed }

    struct You: Equatable {
        var text: String
        var phase: YouPhase
        /// set when the row came from the local mic level alone (no `speech.start` yet): X1 may drop it as noise
        var byLevel = false
    }

    struct Reply: Equatable {
        var utteranceId: Int
        /// `reply.delta` texts in order: one sentence each (PROTOCOL.md), index = the `audio.sentence` of its voice.
        var sentences: [String] = []
        /// `reply.text` once the reply is complete (used when no delta came)
        var finalText: String?
        /// word start times per sentence (reply timeline ms): `audio.words`, replaced by `audio.timing` where it covers
        var starts: [Int: [Int]] = [:]
        var aligned: Set<Int> = []
        /// last word end per sentence
        var ends: [Int: Int] = [:]
        /// first sample of each sentence's audio (`audio.offsetMs`)
        var clauseStart: [Int: Int] = [:]
        /// device voice (`say`): no timing at all
        var device = false
        var anyAudio = false
        /// furthest playhead seen for this utterance
        var heardMs: Double = -1
        var finalAt: Double?
        var endedAt: Double?
        /// barge-in (`utterance.cancelled`): frozen at the words already shown, dimmed
        var cut = false
        var frozen: Int?
        /// words shown so far (monotonic: never takes a word back)
        var shown = 0
    }

    struct Frame: Equatable {
        struct YouRow: Equatable { var text: String; var phase: YouPhase; var dim: Bool; var rolled: Bool }
        struct ReplyRow: Equatable { var utteranceId: Int; var text: String; var words: Int; var cut: Bool; var rolled: Bool }
        var you: YouRow?
        var reply: ReplyRow?
        var isEmpty: Bool { you == nil && reply == nil }
    }

    static let levelOn: Float = 0.08
    static let soundHoldMs: Double = 150
    static let noiseDropMs: Double = 1200
    static let missWaitMs: Double = 1500
    static let missShowMs: Double = 1600
    static let clearAfterMs: Double = 5000
    /// a final line that never got a reply (couldn't answer) does not stay forever
    static let orphanHeardMs: Double = 15000
    /// a reply with no audio at all (TTS failed): shown whole this long after `reply`, never sooner
    static let noAudioMs: Double = 3000
    /// device voice: rough speaking pace to step sentence by sentence (no sample timing reaches the app)
    static let deviceMsPerChar: Double = 62
    static let youMissed = "Didn't catch that. Say it again?"
    static let youSound = "…"
    /// tail kept on screen (the newest words); lines are capped again by the view
    static let youMaxChars = 84
    static let replyMaxChars = 112

    private(set) var you: You?
    private(set) var reply: Reply?
    private var youAt: Double = 0
    private var speechStarted = false
    private var speechEndAt: Double?
    private var finalSeen = false
    private var missedAt: Double?
    private var loudSince: Double?
    private var lastLoud: Double?
    private var heardAt: Double?

    // MARK: events

    mutating func apply(_ event: ServerEvent, now: Double) {
        switch event {
        case .ready:
            self = LiveCaptions()
        case .speechStart:
            // while the reply still plays this may be an echo or a barge-in: the reply stays until words or a cancel come
            let replyPlaying = reply != nil && reply?.endedAt == nil
            if !replyPlaying && (you?.phase == .heard || you?.phase == .missed || reply != nil) { newTurn(now: now) }
            if you == nil { you = You(text: Self.youSound, phase: .sound) }
            if you?.phase == .sound { you?.byLevel = false }
            speechStarted = true
            speechEndAt = nil
        case .speechEnd:
            speechEndAt = now
        case let .transcript(t):
            let text = t.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if t.final {
                // a typed turn goes straight to CAP-3
                if t.source == .text || you == nil || you?.phase == .missed || reply != nil && you?.phase == .heard { newTurn(now: now) }
                guard !text.isEmpty else { break }
                you = You(text: text, phase: .heard)
                finalSeen = true; speechEndAt = nil; missedAt = nil; heardAt = now
            } else {
                guard !text.isEmpty else { break }
                if you == nil || you?.phase == .heard || you?.phase == .missed || reply != nil { newTurn(now: now) }
                you = You(text: text, phase: .words)
                speechStarted = true
            }
        case let .replyDelta(d):
            if reply?.utteranceId != d.utteranceId { reply = Reply(utteranceId: d.utteranceId) }
            reply?.sentences.append(d.text)
        case let .reply(r):
            guard !r.interpret else { break }
            if reply?.utteranceId != r.utteranceId { reply = Reply(utteranceId: r.utteranceId) }
            reply?.finalText = r.text
            reply?.finalAt = now
        case let .audio(a):
            guard reply?.utteranceId == a.utteranceId else { break }
            reply?.anyAudio = true
            if reply?.clauseStart[a.sentence] == nil { reply?.clauseStart[a.sentence] = a.offsetMs }
            if reply?.aligned.contains(a.sentence) != true, !a.words.isEmpty {
                reply?.starts[a.sentence, default: []].append(contentsOf: a.words.map(\.s))
                reply?.ends[a.sentence] = max(reply?.ends[a.sentence] ?? 0, a.words.map(\.e).max() ?? 0)
            }
        case let .audioTiming(t):
            guard reply?.utteranceId == t.utteranceId, !t.words.isEmpty else { break }
            reply?.aligned.insert(t.sentence)
            reply?.starts[t.sentence] = t.words.map(\.s)
            reply?.ends[t.sentence] = t.words.map(\.e).max() ?? 0
        case let .say(s):
            if reply?.utteranceId != s.utteranceId { reply = Reply(utteranceId: s.utteranceId) }
            reply?.device = true
            reply?.anyAudio = true
        case let .utteranceCancelled(c):
            guard reply?.utteranceId == c.utteranceId, reply?.endedAt == nil else { break }
            reply?.cut = true
            reply?.frozen = reply?.shown ?? 0
            reply?.endedAt = now   // CAP-6 clears it like a finished reply
        default:
            break
        }
    }

    /// Server mode with device voice (`ready.tts == device`): the reply has no sample timing.
    mutating func markDevice() { reply?.device = true }

    private mutating func newTurn(now: Double) {
        you = nil; reply = nil
        speechStarted = false; speechEndAt = nil; finalSeen = false; missedAt = nil; heardAt = nil
        youAt = now
    }

    // MARK: frame

    /// One display tick. `level` = local mic 0…1 (nil when the mic is off), `playheadMs` = where the reply's audio is
    /// (nil when it isn't playing).
    mutating func frame(now: Double, level: Float?, playheadMs: Double?) -> Frame {
        tickYou(now: now, level: level)
        tickReply(now: now, playheadMs: playheadMs)
        // CAP-6: 5 s after the companion's last word both lines go
        if let end = reply?.endedAt, now - end >= Self.clearAfterMs { you = nil; reply = nil }
        if reply == nil, you?.phase == .heard, let h = heardAt, now - h >= Self.orphanHeardMs { you = nil }

        var out = Frame()
        let replyText = reply.map { words(of: $0).prefix($0.frozen ?? $0.shown).joined(separator: " ") } ?? ""
        if let r = reply, !replyText.isEmpty {
            let (t, rolled) = Self.tail(replyText, max: Self.replyMaxChars)
            out.reply = .init(utteranceId: r.utteranceId, text: t, words: r.frozen ?? r.shown, cut: r.cut, rolled: rolled)
        }
        if let y = you {
            let dim = out.reply != nil
            let (t, rolled) = dim ? (y.text, false) : Self.tail(y.text, max: Self.youMaxChars)
            out.you = .init(text: t, phase: y.phase, dim: dim, rolled: rolled)
        }
        return out
    }

    private mutating func tickYou(now: Double, level: Float?) {
        let loud = (level ?? 0) >= Self.levelOn
        if loud { lastLoud = now; if loudSince == nil { loudSince = now } } else { loudSince = nil }
        // CAP-1 from the local mic: sound held 150 ms shows bars + "…" before the server says anything
        if let since = loudSince, now - since >= Self.soundHoldMs {
            let idle = you == nil || you?.phase == .heard || you?.phase == .missed
            // the companion's own voice leaks into the mic while it talks: only a new turn the server confirms clears a reply
            if idle && (reply == nil || reply?.endedAt != nil) {
                newTurn(now: now)
                you = You(text: Self.youSound, phase: .sound, byLevel: true)
            }
        }
        // X1: sound with no speech.start that went quiet → it was noise
        if you?.phase == .sound, you?.byLevel == true, !speechStarted, !loud, now - (lastLoud ?? youAt) >= Self.noiseDropMs { you = nil }
        // X2: the user stopped and no final transcript came
        if let end = speechEndAt, !finalSeen, reply == nil || reply?.endedAt != nil, now - end >= Self.missWaitMs, missedAt == nil {
            you = You(text: Self.youMissed, phase: .missed); missedAt = now; speechEndAt = nil
        }
        if let m = missedAt, you?.phase == .missed, now - m >= Self.missShowMs { you = nil; missedAt = nil }
    }

    private mutating func tickReply(now: Double, playheadMs: Double?) {
        guard var r = reply, !r.cut else { return }
        if let p = playheadMs, p >= 0 { r.heardMs = max(r.heardMs, p) }
        let all = words(of: r)
        var n = 0
        if r.heardMs >= 0 || (!r.anyAudio && r.finalAt.map { now - $0 >= Self.noAudioMs } == true) {
            n = revealed(r, total: all.count)
        }
        r.shown = max(r.shown, min(n, all.count))
        // the voice is done: a final reply whose playhead stopped (or passed its last word)
        if r.endedAt == nil, r.finalAt != nil {
            let lastEnd = r.ends.values.max() ?? 0
            let played = r.heardMs >= 0 && (playheadMs == nil || (!r.ends.isEmpty && r.heardMs >= Double(lastEnd)))
            let silent = !r.anyAudio && r.finalAt.map { now - $0 >= Self.noAudioMs } == true
            if played || silent { r.shown = all.count; r.endedAt = now }
        }
        reply = r
    }

    /// Words of the reply as written: the deltas (or `reply.text`), split on spaces.
    private func words(of r: Reply) -> [String] {
        let text = r.sentences.isEmpty ? (r.finalText ?? "") : r.sentences.joined()
        return text.split(whereSeparator: \.isWhitespace).map(String.init)
    }

    /// How many words the voice has reached. Sentence by sentence, in order, never past the playhead.
    private func revealed(_ r: Reply, total: Int) -> Int {
        guard r.anyAudio else { return total }   // no audio at all: whole text (only asked after noAudioMs)
        let t = r.heardMs
        let sentences = r.sentences.isEmpty ? [r.finalText ?? ""] : r.sentences
        var n = 0
        var charsBefore = 0
        for (i, s) in sentences.enumerated() {
            let count = s.split(whereSeparator: \.isWhitespace).count
            if let starts = r.starts[i], !starts.isEmpty {
                let k = starts.filter { Double($0) <= t }.count
                if k >= starts.count && t >= Double(r.ends[i] ?? 0) { n += count; continue }
                // timed words map onto the written words in order; a word without timing shows with the next timed one
                n += min(k, count)
                return n
            } else if let c = r.clauseStart[i] {
                guard Double(c) <= t else { return n }
                n += count
            } else if r.device {
                guard Double(charsBefore) * Self.deviceMsPerChar <= t else { return n }
                n += count
            } else {
                return n   // this sentence's audio hasn't come yet
            }
            charsBefore += s.count
        }
        return n
    }

    /// The newest `max` characters, cut at a word boundary. `rolled` = something older was dropped.
    static func tail(_ text: String, max: Int) -> (String, Bool) {
        guard text.count > max else { return (text, false) }
        let cut = text.suffix(max)
        if let space = cut.firstIndex(where: \.isWhitespace) { return (String(cut[cut.index(after: space)...]), true) }
        return (String(cut), true)
    }

    #if DEBUG
    /// Review renders (Mac CI, UI tests): a finished turn on screen without a server.
    static func review(you: String, reply: String) -> LiveCaptions {
        var c = LiveCaptions()
        c.you = You(text: you, phase: .heard)
        var r = Reply(utteranceId: 1, sentences: [reply])
        r.finalText = reply
        r.shown = reply.split(whereSeparator: \.isWhitespace).count
        r.heardMs = 0
        c.reply = r
        return c
    }
    #endif
}
