// L4 face · Brow flash (11/4, Chelsea: "the face is frozen"): on stressed words the brows lift a little for 0.3 s,
// the way people mark emphasis. Stress = the loudest aligner vowels (top 20 % of vowel peaks so far), at least 1.6 s
// apart (0–2 per sentence). Pure function of the phoneme list and loudness: same input, same flashes.

import Foundation

enum BrowFlash {
    static let vowels: Set<String> = ["AA", "AE", "AH", "AO", "AW", "AY", "EH", "ER", "EY", "IH", "IY", "OW", "OY", "UH", "UW"]
    static let rise = 0.1, hold = 0.1, fall = 0.1, lead = 0.06, minGap = 1.6, topShare = 0.2

    /// Stress onsets (s on the reply clock) from the phonemes received so far.
    static func onsets(phonemes: [LipPhonemeTiming], loudness: (Double) -> Double) -> [Double] {
        let vs = phonemes.filter { vowels.contains($0.phoneme.uppercased().trimmingCharacters(in: CharacterSet(charactersIn: "012"))) }
        guard vs.count >= 3 else { return [] }
        let peaks: [Double] = vs.map { v in
            var m = 0.0, t = Double(v.startMs)
            repeat { m = max(m, loudness(t)); t += 20 } while t < Double(v.endMs)
            return m
        }
        let sorted = peaks.sorted()
        let thr = sorted[min(sorted.count - 1, Int(Double(sorted.count - 1) * (1 - topShare)))]
        var out: [Double] = []
        for (v, p) in zip(vs, peaks) where p >= thr && p > 0.05 {
            let s = Double(v.startMs) / 1000 - lead
            if let last = out.last, s - last < minGap { continue }
            out.append(s)
        }
        return out
    }

    /// 0…1 lift at `ms` (reply clock) — stateless, from the onsets of this phoneme list.
    static func weight(atMs ms: Double, phonemes: [LipPhonemeTiming], loudness: (Double) -> Double) -> Double {
        guard !phonemes.isEmpty else { return 0 }
        return envelope(at: ms / 1000, onsets: onsets(phonemes: phonemes, loudness: loudness))
    }

    static func envelope(at t: Double, onsets: [Double]) -> Double {
        for s in onsets where t >= s && t < s + rise + hold + fall {
            let u = t - s
            if u < rise { let k = u / rise; return k * k * (3 - 2 * k) }
            if u < rise + hold { return 1 }
            let k = 1 - (u - rise - hold) / fall
            return k * k * (3 - 2 * k)
        }
        return 0
    }

    /// 11/4 watch "inhale" backchannel (#613): one flash on the render clock (s), no reply audio needed — the companion
    /// reacts to a big move on the shared screen with a small inhale and its brows go up once (0.3 s, the same envelope).
    /// A new trigger restarts it; a clock that goes back drops it.
    struct Timed {
        private(set) var onset: Double?
        mutating func trigger(at t: Double) { onset = t }
        mutating func weight(at t: Double) -> Double {
            guard let s = onset else { return 0 }
            // a frame stamped just before the trigger (in flight on the render queue) waits; a clock reset drops it
            if t < s - 0.5 || t - s >= BrowFlash.rise + BrowFlash.hold + BrowFlash.fall { onset = nil; return 0 }
            return BrowFlash.envelope(at: t, onsets: [s])
        }
    }

    /// Codex P2: the aligner sends phonemes clause by clause, so the loudness ranking changes as a reply streams.
    /// A flash that has started is kept to its end, and a new one must start ≥ minGap after the last one shown.
    struct Tracker {
        private(set) var shown: [Double] = []
        private var lastT: Double?
        /// codex P3: onsets are recomputed only when the phoneme list or the received audio changes (`audioRevision`:
        /// more PCM re-ranks the loudness, codex P2), at most every `refresh` s otherwise, not on every frame.
        private var cache: (count: Int, endMs: Int, audio: Int, at: Double, onsets: [Double])?
        static let refresh = 0.5
        mutating func weight(atMs ms: Double, phonemes: [LipPhonemeTiming], audioRevision: Int = 0, loudness: (Double) -> Double) -> Double {
            let t = ms / 1000
            // a new reply (cancel / next utterance restarts the clock) or any jump back: forget the old flashes (codex P2)
            if phonemes.isEmpty || (lastT.map { t < $0 - 0.05 } ?? false) { shown = []; cache = nil }
            lastT = t
            guard !phonemes.isEmpty else { return 0 }
            let endMs = Int(phonemes.last!.endMs)
            if cache == nil || cache!.count != phonemes.count || cache!.endMs != endMs || cache!.audio != audioRevision
                || t - cache!.at >= Self.refresh {
                cache = (phonemes.count, endMs, audioRevision, t, BrowFlash.onsets(phonemes: phonemes, loudness: loudness))
            }
            for s in cache!.onsets where s <= t {
                if shown.contains(where: { abs($0 - s) < 1e-6 }) { continue }
                if let last = shown.last, s - last < BrowFlash.minGap { continue }
                if t - s >= BrowFlash.rise + BrowFlash.hold + BrowFlash.fall { continue }   // only flashes still live now
                shown.append(s)
            }
            return BrowFlash.envelope(at: t, onsets: shown)
        }
    }
}
