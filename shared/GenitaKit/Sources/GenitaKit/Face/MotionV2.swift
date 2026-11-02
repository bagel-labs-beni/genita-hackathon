// L4 face · Coarticulated motion v2 (human lane v23, reference genita-mouth-proto render.py `--motion v2`).
// Needs aligner phonemes (#210 `audio.timing`); without them FlowMorph keeps its v1 motion.
//   jaw   — one continuous curve from loudness: stress boost, short-vowel pre-emphasis, attack/release,
//           soft knee; closures (m/b/p) shut it
//   shape — a slow per-vowel channel (round / spread / neutral), unstressed and short vowels undershoot,
//           leaning toward the next vowel within 150 ms
//   keys  — each shape's jaw ladder interpolated at the jaw value, scaled by the lip aperture; then a
//           critically damped spring (7.5 Hz); closures land fast; a short vowel's centre frame reaches
//           ≥ 60 % of its target; a little living jitter and an idle jaw keep it from freezing
// Everything is computed per frame from what has arrived so far (the aligner sends each clause's
// phonemes before that clause finishes playing), so it works while the reply streams.

import Foundation

public struct MotionV2Params: Codable, Equatable, Sendable {
    public var jawAttackMs = 60.0, jawReleaseMs = 70.0, jawKnee = 1.8
    public var shapeTauMs = 100.0, weakShape = 0.5, shortVowelMs = 80.0
    public var anticipation = 0.3
    public var amp = 0.3, unstressed = 0.6, lip = 1.3
    /// v29: stress factor x ×= (1 − k/2 + k·stressed)
    public var stressK = 0.6
    public var preemphMs = 40.0
    public var closureFrames = 2
    public var springHz = 8.0
    public var idle = 0.2
    public var stressPercentile = 70.0
    /// 11/3 (v8.9 review: "Maybe" EY a slit): a vowel within this share below the threshold still counts as stressed
    public var stressMargin = 0.05
    public var shortStressedMs = 150.0
    /// v25: short stressed vowel floors (lip aperture, jaw ladder input)
    public var shortStressedLip = 0.7, shortStressedJaw = 0.5
    /// v25: the frame before a closure eases its targets (×closePre)
    public var closePre = 0.6
    /// v25: loudness onset micro-movement added to the jaw (×amp)
    public var micro = 0.15
    /// v25: how much the chin follows the key flows below the lower lip (applied to the flows at load)
    public var chinScale = 0.92  // chin follows the key flows 8% below the lower lip (jaw speed 3.9× → 0.9× the reference clip)
    /// 11/3 (Chelsea: "barely moves"): opening gain by stress — stressed vowels open more, unstressed less.
    public var stressedGain = 1.0, unstressedGain = 1.0
    public var stressedJawGain = 1.0, unstressedJawGain = 1.0
    /// v28: pre-emphasis cap; jaw target inside a non-closing consonant (syllable beats)
    public var preemphCap = 2.5, consonantJaw = 0.1
    public init() {}
    enum CodingKeys: String, CodingKey { case stressK, preemphCap, consonantJaw, jawAttackMs, jawReleaseMs, jawKnee, shapeTauMs, weakShape, shortVowelMs, anticipation, amp, unstressed, lip, preemphMs, closureFrames, springHz, idle, stressPercentile, shortStressedMs, shortStressedLip, shortStressedJaw, closePre, micro, chinScale, stressedGain, unstressedGain, stressedJawGain, unstressedJawGain, stressMargin }
    enum AliasKeys: String, CodingKey { case consonantDip }
    /// Any field may be missing (prep sends only what it tunes); missing ones keep the defaults.
    public init(from decoder: Decoder) throws {
        self.init()
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return }
        if let v = try? c.decodeIfPresent(Double.self, forKey: .stressK) { stressK = v }
        if let v = try? c.decodeIfPresent(Double.self, forKey: .preemphCap) { preemphCap = v }
        if let v = try? c.decodeIfPresent(Double.self, forKey: .consonantJaw) { consonantJaw = v }
        if let al = try? decoder.container(keyedBy: AliasKeys.self),
           let v = try? al.decodeIfPresent(Double.self, forKey: .consonantDip) { consonantJaw = v }   // prep #266 name
        if let v = try? c.decodeIfPresent(Double.self, forKey: .jawAttackMs) { jawAttackMs = v }
        if let v = try? c.decodeIfPresent(Double.self, forKey: .jawReleaseMs) { jawReleaseMs = v }
        if let v = try? c.decodeIfPresent(Double.self, forKey: .jawKnee) { jawKnee = v }
        if let v = try? c.decodeIfPresent(Double.self, forKey: .shapeTauMs) { shapeTauMs = v }
        if let v = try? c.decodeIfPresent(Double.self, forKey: .weakShape) { weakShape = v }
        if let v = try? c.decodeIfPresent(Double.self, forKey: .shortVowelMs) { shortVowelMs = v }
        if let v = try? c.decodeIfPresent(Double.self, forKey: .anticipation) { anticipation = v }
        if let v = try? c.decodeIfPresent(Double.self, forKey: .amp) { amp = v }
        if let v = try? c.decodeIfPresent(Double.self, forKey: .unstressed) { unstressed = v }
        if let v = try? c.decodeIfPresent(Double.self, forKey: .lip) { lip = v }
        if let v = try? c.decodeIfPresent(Double.self, forKey: .preemphMs) { preemphMs = v }
        if let v = try? c.decodeIfPresent(Int.self, forKey: .closureFrames) { closureFrames = v }
        if let v = try? c.decodeIfPresent(Double.self, forKey: .springHz) { springHz = v }
        if let v = try? c.decodeIfPresent(Double.self, forKey: .idle) { idle = v }
        if let v = try? c.decodeIfPresent(Double.self, forKey: .stressPercentile) { stressPercentile = v }
        if let v = try? c.decodeIfPresent(Double.self, forKey: .stressMargin) { stressMargin = v }
        if let v = try? c.decodeIfPresent(Double.self, forKey: .shortStressedMs) { shortStressedMs = v }
        if let v = try? c.decodeIfPresent(Double.self, forKey: .shortStressedLip) { shortStressedLip = v }
        if let v = try? c.decodeIfPresent(Double.self, forKey: .shortStressedJaw) { shortStressedJaw = v }
        if let v = try? c.decodeIfPresent(Double.self, forKey: .closePre) { closePre = v }
        if let v = try? c.decodeIfPresent(Double.self, forKey: .micro) { micro = v }
        if let v = try? c.decodeIfPresent(Double.self, forKey: .chinScale) { chinScale = v }
        if let v = try? c.decodeIfPresent(Double.self, forKey: .stressedGain) { stressedGain = v }
        if let v = try? c.decodeIfPresent(Double.self, forKey: .unstressedGain) { unstressedGain = v }
        if let v = try? c.decodeIfPresent(Double.self, forKey: .stressedJawGain) { stressedJawGain = v }
        if let v = try? c.decodeIfPresent(Double.self, forKey: .unstressedJawGain) { unstressedJawGain = v }
    }
}

struct MotionV2 {
    static let round: Set<String> = ["AO", "OW", "OY", "UW", "UH", "W"]
    static let spread: Set<String> = ["IY", "IH", "EY", "EH", "Y"]
    static let open: Set<String> = ["AA", "AH", "AE", "AY", "AW", "ER"]
    static var vowels: Set<String> { round.union(spread).union(open) }
    static let ladders: [[(String, Double)]] = [
        [("U", 0), ("OH", 0.45)],
        [("EI", 0), ("EH", 0.45), ("AH2", 0.85)],
        [("MID", 0), ("AH", 0.35), ("AH2", 0.7)],
    ]

    var p: MotionV2Params
    var faceNorm: Double
    private var jv = 0.0
    private var shape: [Double] = [0, 0, 1]
    private var x: [Double] = [], v: [Double] = []
    private var lastMs: Double?
    private var rng = SplitMix64(seed: 9)
    private var jitter: [Double] = [0, 0, 0]
    private var idleNoise: [Double] = Array(repeating: 0, count: 12)
    private var f1 = 0.0, f2 = 0.0, fPeak = 0.05
    /// the last step was the frame before a closure
    private(set) var preClose = false

    init(params: MotionV2Params, faceNorm: Double) { p = params; self.faceNorm = faceNorm }

    mutating func reset() { jv = 0; shape = [0, 0, 1]; x = []; v = []; lastMs = nil; f1 = 0; f2 = 0; fPeak = 0.05 }

    /// Key amounts at audio time `ms` (lookahead already added). `phonemes`: everything received so far
    /// for this reply (ms, sorted); `openness(ms)`: loudness 0…1. Returns nil when there are no phonemes.
    mutating func step(ms: Double, phonemes: [LipPhonemeTiming], openness: (Double) -> Double,
                       order: [String], resolve: (String) -> String?) -> (amounts: [Float], closed: Bool)? {
        guard !phonemes.isEmpty else { return nil }
        let dt = lastMs.map { min(500, max(0, ms - $0)) } ?? 40
        lastMs = ms
        let ph = phonemes.map { (p: $0.phoneme.uppercased().trimmingCharacters(in: CharacterSet(charactersIn: "012")), s: Double($0.startMs), e: Double($0.endMs)) }
        let vow = ph.filter { Self.vowels.contains($0.p) }
        func peak(_ s: Double, _ e: Double) -> Double {
            var m = 0.0, t = s
            repeat { m = max(m, openness(t)); t += 40 } while t < e
            return m
        }
        let peaks = vow.map { peak($0.s, $0.e) }
        let thr: Double = {
            guard !peaks.isEmpty else { return 1 }
            let sorted = peaks.sorted(); let idx = Int((Double(sorted.count - 1) * p.stressPercentile / 100).rounded())
            return sorted[min(sorted.count - 1, max(0, idx))] * (1 - p.stressMargin)
        }()
        // where are we
        let curVowel = vow.indices.first { vow[$0].s <= ms && ms < vow[$0].e }
        let stressed = curVowel.map { peaks[$0] >= thr } ?? false
        let shortStressed = curVowel.map { stressed && vow[$0].e - vow[$0].s < p.shortStressedMs } ?? false
        // closure (m/b/p), with a 1-frame minimum next to a short vowel
        var closed = false
        for q in ph where ["M", "B", "P"].contains(q.p) {
            let nearShort = vow.contains { (abs($0.s - q.e) < 30 || abs($0.e - q.s) < 30) && $0.e - $0.s < 120 }
            let minMs = Double(nearShort ? 1 : p.closureFrames) * 40
            // closed from the phoneme start (with lookahead) until its end on the audio clock (v29)
            if ms >= q.s && ms < max(q.e + 40, q.s + minMs) { closed = true; break }
        }
        // shape target: the current (or last) vowel, leaning toward the next one within 150 ms
        func shapeOf(_ i: Int) -> [Double] {
            let q = vow[i]
            let cls = Self.round.contains(q.p) ? 0 : Self.spread.contains(q.p) ? 1 : 2
            var st = peaks[i] >= thr ? 1.0 : p.weakShape
            if q.e - q.s < p.shortVowelMs { st *= 0.5 }
            var t = [0.0, 0, 1 - st]; t[cls] += st
            if cls == 1, peaks[i] >= thr { t = [0.6 * t[0], 0.6 * t[1], 0.6 * t[2] + 0.4] }
            return t
        }
        var target = shape
        if let i = curVowel { target = shapeOf(i) }
        else if let last = vow.lastIndex(where: { $0.e <= ms }) { target = shapeOf(last) }
        if let n = vow.firstIndex(where: { $0.s > ms }), vow[n].s - ms < 150, p.anticipation > 0 {
            let nt = shapeOf(n)
            let a = p.anticipation * (nt.max()! >= 0.99 ? 0.66 : 1)
            target = zip(target, nt).map { (1 - a) * $0 + a * $1 }
        }
        let al = 1 - exp(-dt / p.shapeTauMs)
        shape = zip(shape, target).map { $0 + al * ($1 - $0) }
        // jaw
        var pre = 1.0
        if let i = curVowel, p.preemphMs > 0 { pre = min(p.preemphCap, 1 / (1 - exp(-max(vow[i].e - vow[i].s, 20) / p.preemphMs))) }
        let st = stressed ? 1.0 : 0.0
        let amp = p.amp * faceNorm
        var xj = closed ? 0 : openness(ms) * pre * amp * (p.unstressed + (1 - p.unstressed) * st) * (1 - p.stressK / 2 + p.stressK * st)
        // inside a consonant (not a closure) the jaw heads back up: the syllable beat
        if curVowel == nil, ph.contains(where: { $0.s <= ms && ms < $0.e && !Self.vowels.contains($0.p) }) { xj *= p.consonantJaw }
        let aa = 1 - exp(-dt / p.jawAttackMs), ar = 1 - exp(-dt / p.jawReleaseMs)
        jv = closed ? 0 : jv + (xj > jv ? aa : ar) * (xj - jv)
        // loudness onsets: a fast-minus-slow envelope nudges the jaw (running p95 ≈ decaying peak)
        let o = openness(ms)
        f1 += (1 - exp(-dt / 30)) * (o - f1); f2 += (1 - exp(-dt / 160)) * (o - f2)
        fPeak = max(abs(f1 - f2), fPeak * exp(-dt / 2000))
        if p.micro > 0, !closed, o > 0.05 { jv += p.micro * p.amp * max(0, (f1 - f2) / max(0.02, 0.8 * fPeak)) }
        var J = tanh(jv * p.jawKnee)
        if p.idle > 0, !closed { J = max(0, J + 0.15 * p.idle * sin(2 * .pi * 0.3 * ms / 1000 + 0.7)) }
        var A = p.lip > 0 ? min(1, jv / max(p.amp, 1e-3) * p.lip) : J
        if curVowel != nil {
            let g = stressed ? p.stressedGain : p.unstressedGain
            // the jaw ladder decides which key (how open): stressed vowels climb it further
            A = min(1, A * g); J = min(0.95, J * (stressed ? p.stressedJawGain : p.unstressedJawGain))
        }
        if shortStressed { A = max(A, p.shortStressedLip); J = max(J, p.shortStressedJaw) }
        else if let i = curVowel, vow[i].e - vow[i].s < p.shortStressedMs { A = max(A, 0.35) }   // every short vowel shows
        // inside a consonant that doesn't close the lips, the lips come back too (syllable beat)
        if curVowel == nil, !closed, ph.contains(where: { $0.s <= ms && ms < $0.e && !Self.vowels.contains($0.p) }) { A *= 0.4 }
        // key targets
        var tgt = [Double](repeating: 0, count: order.count)
        let mbp = order.firstIndex(of: "MBP")
        if closed { if let m = mbp { tgt[m] = 1 } } else {
            for c in 0..<3 where shape[c] > 1e-3 {
                let steps = Self.ladders[c].compactMap { k, x -> (Int, Double)? in
                    guard let r = resolve(k), let i = order.firstIndex(of: r) else { return nil }
                    return (i, x)
                }
                guard !steps.isEmpty else { continue }
                var w: [(Int, Double)] = []
                if J <= steps[0].1 || steps.count == 1 { w = [(steps[0].0, 1)] } else {
                    w = [(steps[steps.count - 1].0, 1)]
                    for k in 0..<(steps.count - 1) where J <= steps[k + 1].1 {
                        let u = (J - steps[k].1) / (steps[k + 1].1 - steps[k].1)
                        w = [(steps[k].0, 1 - u), (steps[k + 1].0, u)]; break
                    }
                }
                for (i, wi) in w { tgt[i] += A * shape[c] * wi }
            }
            // living jitter on the leading key, idle jaw when little is open
            jitter.removeFirst(); jitter.append(Double(rng.nextUnit() * 2 - 1))
            if tgt.reduce(0, +) > 0.2, let lead = tgt.indices.max(by: { tgt[$0] < tgt[$1] }) {
                tgt[lead] = max(0, tgt[lead] + 0.03 * jitter.reduce(0, +) / 3)
            }
            idleNoise.removeFirst(); idleNoise.append(Double(rng.nextUnit() * 2 - 1) * 1.7)
            if p.idle > 0, let mid = order.firstIndex(of: "MID"), tgt.reduce(0, +) < 0.9 {
                let n = idleNoise.reduce(0, +) / 12
                tgt[mid] += max(0, p.idle * (0.6 + 0.4 * sin(2 * .pi * 0.3 * ms / 1000) + 0.6 * n))
            }
        }
        // the frame before a closure eases off (the lips are already on their way)
        preClose = !closed && ph.contains(where: { ["M", "B", "P"].contains($0.p) && $0.s > ms && $0.s <= ms + 40 })
        if preClose, p.closePre < 1 { tgt = tgt.map { $0 * p.closePre } }
        let target0 = tgt
        // spring (closures fast)
        if x.count != order.count { x = tgt; v = tgt.map { _ in 0 } }
        if closed { for i in x.indices { x[i] += 0.7 * (tgt[i] - x[i]); v[i] = 0 } } else {
            let w0 = 2 * Double.pi * p.springHz, sub = 8, h = dt / 1000 / Double(sub)
            for _ in 0..<sub { for i in x.indices {
                let acc = w0 * w0 * (tgt[i] - x[i]) - 2 * w0 * v[i]
                v[i] += h * acc; x[i] += h * v[i]
            } }
        }
        var out = x.map { min(1, max(0, $0)) }
        // a short vowel's centre reaches ≥ 60 % of its own target
        if let i = curVowel, !closed, vow[i].e - vow[i].s <= 160, abs(ms - (vow[i].s + vow[i].e) / 2) <= 20 {
            out = zip(out, target0).map { max($0, 0.6 * $1) }
        }
        return (out.map(Float.init), closed)
    }
}
