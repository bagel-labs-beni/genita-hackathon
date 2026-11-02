// L4 lips · One utterance's mouth over time, on the reply's audio timeline (ms, 0 = first sample).
//
// Inputs, in order of trust: phoneme timings > word timings > the server's legacy mouth letters >
// reply text spread over the voiced audio by letter count > loudness alone. Audio (s16le PCM)
// gives the jaw openness: RMS per 40 ms window, normalised to the utterance's loud level and gated
// on silence. Everything can be appended in any order while the reply streams in (audio arrives
// faster than it plays) and `sample(atMs:)` reflects all of it. `reset()` on utterance.cancelled
// or before the next utterance.

import Foundation

/// The mouth at one instant: shape weights (sum 1, a 60 ms crossfade) and jaw openness 0…1.
public struct LipFrame: Equatable, Sendable {
    public var weights: [LipViseme: Float]
    public var openness: Float

    public init(weights: [LipViseme: Float], openness: Float) {
        self.weights = weights
        self.openness = openness
    }

    public static let rest = LipFrame(weights: [.rest: 1], openness: 0)

    /// The heaviest shape (ties → declaration order).
    public var dominant: LipViseme {
        LipViseme.allCases.max { (weights[$0] ?? 0) < (weights[$1] ?? 0) } ?? .rest
    }
}

public struct LipWordTiming: Equatable, Sendable {
    public var text: String
    public var startMs: Int
    public var endMs: Int
    public init(text: String, startMs: Int, endMs: Int) {
        self.text = text; self.startMs = startMs; self.endMs = endMs
    }
    public init(_ w: WordTiming) { self.init(text: w.w, startMs: w.s, endMs: w.e) }
}

public struct LipPhonemeTiming: Equatable, Sendable {
    public var phoneme: String
    public var startMs: Int
    public var endMs: Int
    public init(phoneme: String, startMs: Int, endMs: Int) {
        self.phoneme = phoneme; self.startMs = startMs; self.endMs = endMs
    }
}

public final class LipTimeline: @unchecked Sendable {
    public static let windowMs = 40
    public static let crossfadeMs = 60.0
    /// Fallback pacing before all audio is in: voiced windows per letter (~64 ms a letter).
    static let windowsPerLetter = 1.6
    /// Quietest level treated as the utterance's loud level (RMS, full scale = 1).
    static let peakFloor = 0.03
    static let absoluteGate = 0.006
    static let relativeGate = 0.1

    private struct Window { var sumSquares = 0.0; var count = 0 }
    private struct Segment { var start: Double; var end: Double; var viseme: LipViseme }
    private struct Derived {
        var firstWindow = 0
        var openness: [Float] = []   // per window from firstWindow; 0 = silent or missing
        var voiced: [Bool] = []
        var segments: [Segment] = []
        var hasSegments = false
    }

    private let lock = NSLock()
    private var windows: [Int: Window] = [:]
    private var words: [LipWordTiming] = []
    private var phonemes: [LipPhonemeTiming] = []
    private var cues: [MouthCue] = []
    private var text = ""
    private var audioFinished = false
    private var cache: Derived?

    public init() {}

    // MARK: feeding

    /// PCM s16le mono at `sampleRate`, starting `offsetMs` into the reply.
    public func appendPCM(_ pcm: Data, offsetMs: Int, sampleRate: Int = GenitaProtocol.sampleRate) {
        guard offsetMs >= 0, sampleRate > 0, pcm.count >= 2 else { return }
        let rate = Double(sampleRate)
        let startSample = Int((Double(offsetMs) * rate / 1000).rounded())
        let perWindow = rate * Double(Self.windowMs) / 1000
        lock.lock(); defer { lock.unlock() }
        pcm.withUnsafeBytes { raw in
            let n = raw.count / 2
            var current = -1
            var acc = Window()
            for i in 0..<n {
                let lo = UInt16(raw[2 * i]), hi = UInt16(raw[2 * i + 1])
                let v = Double(Int16(bitPattern: lo | hi << 8)) / 32_768
                let w = Int(Double(startSample + i) / perWindow)
                if w != current {
                    if current >= 0 { merge(acc, into: current) }
                    current = w; acc = Window()
                }
                acc.sumSquares += v * v
                acc.count += 1
            }
            if current >= 0 { merge(acc, into: current) }
        }
        cache = nil
    }

    private func merge(_ w: Window, into index: Int) {
        var cur = windows[index] ?? Window()
        cur.sumSquares += w.sumSquares
        cur.count += w.count
        windows[index] = cur
    }

    public func appendWords(_ list: [LipWordTiming]) {
        guard !list.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        for w in list where w.endMs > w.startMs {
            // A word can split across two audio chunks: same text, overlapping time → one word.
            if let i = words.lastIndex(where: { $0.text.lowercased() == w.text.lowercased() && $0.startMs < w.endMs && w.startMs < $0.endMs }) {
                words[i].startMs = min(words[i].startMs, w.startMs)
                words[i].endMs = max(words[i].endMs, w.endMs)
            } else {
                words.append(w)
            }
        }
        cache = nil
    }

    public func appendPhonemes(_ list: [LipPhonemeTiming]) {
        guard !list.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        phonemes += list.filter { $0.endMs > $0.startMs }
        cache = nil
    }

    /// The server's legacy `audio.mouth` cues (absolute ms).
    public func appendMouthCues(_ list: [MouthCue]) {
        guard !list.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        cues += list
        cache = nil
    }

    /// Reply text as it streams (`reply.delta`); used only when no timings came with the audio.
    public func appendText(_ delta: String) {
        guard !delta.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        text += delta
        cache = nil
    }

    /// All audio of the utterance is in: the text fallback can use the real voiced length.
    public func finishAudio() {
        lock.lock(); defer { lock.unlock() }
        audioFinished = true
        cache = nil
    }

    /// One server `audio` event and the PCM of the binary frame that followed it.
    public func append(_ audio: ServerEvent.Audio, pcm: Data) {
        appendPCM(pcm, offsetMs: audio.offsetMs, sampleRate: audio.sampleRate)
        appendWords(audio.words.map(LipWordTiming.init))
        if let mouth = audio.mouth { appendMouthCues(mouth) }
    }

    public func reset() {
        lock.lock(); defer { lock.unlock() }
        windows = [:]; words = []; phonemes = []; cues = []; text = ""
        audioFinished = false
        cache = nil
    }

    /// True when the shapes come from timings (phonemes, words or mouth cues), not the text fallback.
    public var hasTimings: Bool {
        lock.lock(); defer { lock.unlock() }
        return !phonemes.isEmpty || !words.isEmpty || !cues.isEmpty
    }

    /// Last ms covered by audio received so far (0 when none).
    public var receivedAudioEndMs: Int {
        lock.lock(); defer { lock.unlock() }
        guard let last = windows.keys.max() else { return 0 }
        return (last + 1) * Self.windowMs
    }

    // MARK: sampling

    public func sample(atMs t: Double) -> LipFrame {
        lock.lock()
        let d: Derived
        if let c = cache { d = c } else { d = derive(); cache = d }
        lock.unlock()

        let half = Self.crossfadeMs / 2
        let lo = t - half, hi = t + half
        var cuts: [Double] = [lo, hi]
        if !d.voiced.isEmpty {
            var b = (lo / Double(Self.windowMs)).rounded(.up) * Double(Self.windowMs)
            while b < hi { cuts.append(b); b += Double(Self.windowMs) }
        }
        if d.hasSegments {
            var i = firstSegment(endingAfter: lo, in: d.segments)
            while i < d.segments.count, d.segments[i].start < hi {
                cuts.append(d.segments[i].start); cuts.append(d.segments[i].end); i += 1
            }
        }
        cuts = cuts.filter { $0 >= lo && $0 <= hi }.sorted()
        var weights: [LipViseme: Float] = [:]
        for k in 0..<(cuts.count - 1) where cuts[k + 1] > cuts[k] {
            let v = target(at: (cuts[k] + cuts[k + 1]) / 2, d)
            weights[v, default: 0] += Float((cuts[k + 1] - cuts[k]) / Self.crossfadeMs)
        }
        let sum = weights.values.reduce(0, +)
        if sum > 0 { for (k, v) in weights { weights[k] = v / sum } } else { weights = [.rest: 1] }

        var open: Float
        if d.voiced.isEmpty {
            open = weights.reduce(0) { $0 + $1.value * $1.key.naturalOpenness }
        } else {
            open = interpolatedOpenness(t, d)
        }
        open *= max(0, 1 - (weights[.MBP] ?? 0))
        return LipFrame(weights: weights, openness: min(1, max(0, open)))
    }

    private func windowIndex(_ ms: Double) -> Int { Int((ms / Double(Self.windowMs)).rounded(.down)) }

    private func target(at ms: Double, _ d: Derived) -> LipViseme {
        if !d.voiced.isEmpty {
            let i = windowIndex(ms) - d.firstWindow
            guard i >= 0, i < d.voiced.count, d.voiced[i] else { return .rest }
            if !d.hasSegments {
                // Loudness only: open shapes by level so the mouth still reads as speech.
                let o = d.openness[i]
                return o > 0.6 ? .A : o > 0.3 ? .EI : .CDG
            }
        }
        guard d.hasSegments else { return .rest }
        let k = firstSegment(endingAfter: ms, in: d.segments)
        if k < d.segments.count, d.segments[k].start <= ms { return d.segments[k].viseme }
        // Voiced but untimed and untexted: loudness shapes rather than a shut mouth.
        if !d.voiced.isEmpty {
            let i = windowIndex(ms) - d.firstWindow
            if i >= 0, i < d.voiced.count, d.voiced[i] { let o = d.openness[i]; return o > 0.6 ? .A : o > 0.3 ? .EI : .CDG }
        }
        return .rest
    }

    /// Index of the first segment whose end is after `ms` (segments are sorted and disjoint).
    private func firstSegment(endingAfter ms: Double, in s: [Segment]) -> Int {
        var lo = 0, hi = s.count
        while lo < hi {
            let mid = (lo + hi) / 2
            if s[mid].end <= ms { lo = mid + 1 } else { hi = mid }
        }
        return lo
    }

    private func interpolatedOpenness(_ t: Double, _ d: Derived) -> Float {
        let w = Double(Self.windowMs)
        let x = t / w - 0.5 - Double(d.firstWindow)    // window centres at integer x
        let i0 = Int(x.rounded(.down))
        let f = Float(x - Double(i0))
        func at(_ i: Int) -> Float { i >= 0 && i < d.openness.count ? d.openness[i] : 0 }
        // Outside received audio there is no sound.
        let i = windowIndex(t) - d.firstWindow
        guard i >= 0, i < d.openness.count else { return 0 }
        return at(i0) * (1 - f) + at(i0 + 1) * f
    }

    // MARK: derivation (under lock)

    private func derive() -> Derived {
        var d = Derived()
        if let first = windows.keys.min(), let last = windows.keys.max() {
            d.firstWindow = first
            let rms: [Double] = (first...last).map { i in
                guard let w = windows[i], w.count > 0 else { return 0 }
                return (w.sumSquares / Double(w.count)).squareRoot()
            }
            let loud = rms.filter { $0 >= Self.absoluteGate }.sorted()
            let p90 = loud.isEmpty ? 0 : loud[min(loud.count - 1, Int(Double(loud.count) * 0.9))]
            let peak = max(Self.peakFloor, p90)
            let gate = max(Self.absoluteGate, Self.relativeGate * peak)
            d.voiced = rms.map { $0 >= gate }
            d.openness = rms.map { r in
                guard r >= gate else { return 0 }
                return Float(pow(min(1, (r - gate) / (peak - gate)), 0.75))
            }
        }
        // Timings win only where they are: phonemes over their clause, words elsewhere, the reply
        // text over the voiced audio nothing timed (a clause the aligner skipped, a gap between
        // timed words). Voiced audio with no shape at all falls back to loudness shapes.
        var segs: [Segment] = []
        var covered: [ClosedRange<Double>] = []
        if !phonemes.isEmpty {
            let ps = phonemes.sorted { $0.startMs < $1.startMs }
            segs += ps.map { Segment(start: Double($0.startMs), end: Double($0.endMs), viseme: LipViseme(phoneme: $0.phoneme)) }
            covered += Self.runs(ps.map { Double($0.startMs)...Double($0.endMs) }, joinGapMs: 300)
        }
        if !words.isEmpty {
            for w in words {
                for seg in spread(LipGraphemes.visemes(in: w.text), from: Double(w.startMs), to: Double(w.endMs)) {
                    segs += Self.clip(seg, outside: covered)
                }
            }
        }
        if phonemes.isEmpty, words.isEmpty, !cues.isEmpty {
            let sorted = cues.sorted { $0.t < $1.t }
            for (k, c) in sorted.enumerated() {
                let v = LipViseme(legacy: c.v)
                guard v != .rest else { continue }
                let end = k + 1 < sorted.count ? sorted[k + 1].t : c.t + 200
                if end > c.t { segs.append(Segment(start: Double(c.t), end: Double(end), viseme: v)) }
            }
        }
        covered += words.map { Double($0.startMs)...Double($0.endMs) }
        if !text.isEmpty, !d.voiced.isEmpty, cues.isEmpty || !words.isEmpty || !phonemes.isEmpty {
            let tokens = Self.tokens(text)
            if words.isEmpty {
                // No word anchors: the whole text over whatever voiced audio is not timed.
                segs += textSegments(d, tokens: tokens, fromMs: -.infinity, toMs: .infinity, covered: covered)
            } else {
                // Anchor the text to the timed words; untimed words go to the gaps around them.
                let timed = words.sorted { $0.startMs < $1.startMs }
                var j = 0
                var prevEnd = -Double.infinity
                for w in timed {
                    let key = Self.norm(w.text)
                    guard let m = (j..<min(tokens.count, j + 6)).first(where: { Self.norm(tokens[$0]) == key }) else {
                        prevEnd = max(prevEnd, Double(w.endMs)); continue
                    }
                    if m > j { segs += textSegments(d, tokens: Array(tokens[j..<m]), fromMs: prevEnd, toMs: Double(w.startMs), covered: covered) }
                    j = m + 1
                    prevEnd = max(prevEnd, Double(w.endMs))
                }
                if j < tokens.count { segs += textSegments(d, tokens: Array(tokens[j...]), fromMs: prevEnd, toMs: .infinity, covered: covered) }
            }
        }
        d.segments = disjoint(segs)
        d.hasSegments = !d.segments.isEmpty
        return d
    }

    /// Shapes of one word laid over [start, end) by their relative durations.
    private func spread(_ shapes: [LipViseme], from start: Double, to end: Double) -> [Segment] {
        guard !shapes.isEmpty, end > start else { return [] }
        let total = shapes.reduce(0) { $0 + LipGraphemes.duration(of: $1) }
        var out: [Segment] = []
        var t = start
        for v in shapes {
            let len = (end - start) * LipGraphemes.duration(of: v) / total
            out.append(Segment(start: t, end: t + len, viseme: v))
            t += len
        }
        return out
    }

    // Text fallback: voiced windows go to words in proportion to their letter count.
    private static func tokens(_ text: String) -> [String] {
        text.split(whereSeparator: { $0.isWhitespace }).map(String.init)
    }

    /// Text fallback over the voiced windows at or after `fromWindow` (absolute window index).
    private func textSegments(_ d: Derived, tokens: [String], fromMs: Double, toMs: Double, covered: [ClosedRange<Double>]) -> [Segment] {
        let shaped = tokens.map { (LipGraphemes.visemes(in: $0), max(1, $0.filter { $0.isLetter || $0.isNumber }.count)) }
            .filter { !$0.0.isEmpty }
        guard !shaped.isEmpty else { return [] }
        let wms = Double(Self.windowMs)
        let voicedIdx = d.voiced.indices.filter { i in
            let mid = (Double(d.firstWindow + i) + 0.5) * wms
            return d.voiced[i] && mid >= fromMs && mid < toMs && !covered.contains { $0.contains(mid) }
        }
        guard !voicedIdx.isEmpty else { return [] }
        let letters = Double(shaped.reduce(0) { $0 + $1.1 })
        let v = Double(voicedIdx.count)
        // A gap closed by a later timed word is fully received; an open tail may still grow.
        let denom = audioFinished || toMs.isFinite ? v : max(v, letters * Self.windowsPerLetter)
        let w = Double(Self.windowMs)
        var out: [Segment] = []
        var cum = 0.0
        for (shapes, count) in shaped {
            let a = Int((cum / letters * denom).rounded(.down))
            cum += Double(count)
            let b = Int((cum / letters * denom).rounded(.down))
            let mine = Array(voicedIdx[min(a, voicedIdx.count)..<min(max(a, b), voicedIdx.count)])
            if a >= voicedIdx.count { break }
            guard !mine.isEmpty else { continue }
            // Half-window steps across the word's windows, shapes by relative duration.
            let steps = mine.count * 2
            let total = shapes.reduce(0) { $0 + LipGraphemes.duration(of: $1) }
            var bounds: [Double] = [0]
            for s in shapes { bounds.append(bounds.last! + LipGraphemes.duration(of: s) / total) }
            for s in 0..<steps {
                let frac = (Double(s) + 0.5) / Double(steps)
                let k = min(shapes.count - 1, bounds.lastIndex { $0 <= frac } ?? 0)
                let start = Double(d.firstWindow + mine[s / 2]) * w + Double(s % 2) * w / 2
                out.append(Segment(start: start, end: start + w / 2, viseme: shapes[k]))
            }
        }
        return out
    }

    static func norm(_ s: String) -> String { s.lowercased().filter { $0.isLetter || $0.isNumber } }

    /// Merges ranges closer than `joinGapMs` into runs.
    static func runs(_ r: [ClosedRange<Double>], joinGapMs: Double) -> [ClosedRange<Double>] {
        var out: [ClosedRange<Double>] = []
        for x in r.sorted(by: { $0.lowerBound < $1.lowerBound }) {
            if let last = out.last, x.lowerBound - last.upperBound <= joinGapMs {
                out[out.count - 1] = last.lowerBound...max(last.upperBound, x.upperBound)
            } else { out.append(x) }
        }
        return out
    }

    /// The parts of `seg` outside every covered range.
    private static func clip(_ seg: Segment, outside covered: [ClosedRange<Double>]) -> [Segment] {
        var parts = [seg]
        for c in covered {
            parts = parts.flatMap { p -> [Segment] in
                guard p.end > c.lowerBound, p.start < c.upperBound else { return [p] }
                var out: [Segment] = []
                if p.start < c.lowerBound { out.append(Segment(start: p.start, end: c.lowerBound, viseme: p.viseme)) }
                if p.end > c.upperBound { out.append(Segment(start: c.upperBound, end: p.end, viseme: p.viseme)) }
                return out
            }
        }
        return parts
    }

    /// Sorted, non-overlapping (a later segment wins where two overlap), neighbours merged.
    private func disjoint(_ s: [Segment]) -> [Segment] {
        let sorted = s.filter { $0.end > $0.start }.sorted { $0.start < $1.start }
        var out: [Segment] = []
        for var seg in sorted {
            if let last = out.last, last.end > seg.start {
                out[out.count - 1].end = seg.start
                if out[out.count - 1].end <= out[out.count - 1].start { out.removeLast() }
            }
            if let last = out.last, last.viseme == seg.viseme, abs(last.end - seg.start) < 1e-9 {
                out[out.count - 1].end = seg.end
                continue
            }
            seg.start = max(seg.start, out.last?.end ?? seg.start)
            out.append(seg)
        }
        return out
    }
}
