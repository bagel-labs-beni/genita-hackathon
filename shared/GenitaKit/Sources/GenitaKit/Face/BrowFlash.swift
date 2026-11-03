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

    /// 0…1 lift at `ms` (reply clock).
    static func weight(atMs ms: Double, phonemes: [LipPhonemeTiming], loudness: (Double) -> Double) -> Double {
        guard !phonemes.isEmpty else { return 0 }
        let t = ms / 1000
        for s in onsets(phonemes: phonemes, loudness: loudness) where t >= s && t < s + rise + hold + fall {
            let u = t - s
            if u < rise { let k = u / rise; return k * k * (3 - 2 * k) }
            if u < rise + hold { return 1 }
            let k = 1 - (u - rise - hold) / fall
            return k * k * (3 - 2 * k)
        }
        return 0
    }
}
