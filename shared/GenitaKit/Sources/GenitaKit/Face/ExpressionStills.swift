// L4 face · Expression stills layer state: which prepped expression still shows, and how much, at a renderer time.
// Driven only by server `expression` events (per reply clause, reply audio clock); no event → no weight, so plain
// speech keeps the still-face gates. Pure value type: same calls in the same order → same weights.
//
// v2 (11/3 23:5x, Chelsea: "too unnatural — a sticker swapped in, frozen for seconds"): a feeling is a short swell,
// not a held still. Per event (profile A):
//
//   weight   0 ↗ ease in 0.7 s → peak (cap) ≤ 0.8 s → ↘ 1.2 s → afterglow 0.15 … reply ends → ↘ 0 within 1 s
//   smiles   … reply ends → the still's own smile (mouth too) swells to its cap for 0.6 s → ↘ 0 within 1 s
//
// Caps are low (smile .5, laugh .45, surprise .35, concern .3): the photo always dominates. While the mouth talks only
// the eyes / cheeks band blends (surprise: the brows only, never wide-open eyes); the mouth of a still never mixes
// into speech. Profile B halves every cap; profile C is A for strong feelings only (intensity ≥ .8, 12 s apart).

import Foundation

struct ExpressionStills {
    /// The tuning (the app uses `.a`; the render tool can pick another for comparisons).
    struct Profile: Equatable, Sendable {
        var name: String
        /// Peak weight per server tag.
        var caps: [String: Double]
        /// What stays after the swell while the reply goes on (absolute weight, at most half the cap).
        var afterglow: Double
        /// The smile's own mouth in the moment after the reply (0 = never). Mouths can't be half-blended: at the eye
        /// caps (.45/.5) the teeth showed as a ghost over the closed lips (renders 11/3 23:5x), so it is near full.
        var mouthPeak: Double = 0.9
        /// Only events at least this intense, at least `gap` s after the last shown one (C); 0 = every event.
        var minIntensity: Double = 0, gap: Double = 0

        static let a = Profile(name: "A", caps: ["smile": 0.5, "smileopen": 0.45, "laugh": 0.45, "surprised": 0.35, "concerned": 0.3], afterglow: 0.15)
        static let b = Profile(name: "B", caps: a.caps.mapValues { $0 / 2 }, afterglow: 0.075, mouthPeak: 0)
        static let c = Profile(name: "C", caps: a.caps, afterglow: 0.15, minIntensity: 0.8, gap: 12)
        static func named(_ s: String) -> Profile? { ["a": a, "b": b, "c": c][s.lowercased()] }
    }
    /// The tuning new layers start with (the render tool switches it before it builds its renderer).
    nonisolated(unsafe) static var defaultProfile = Profile.a
    var profile = ExpressionStills.defaultProfile

    /// The swell (s): ease in, peak, ease down to the afterglow. It starts `lead` before the clause's first word.
    static let rise = 0.7, peak = 0.8, settle = 1.2, lead = 0.15
    /// After the reply's audio: everything is gone within `release` s; a smile first swells to its cap for `smilePeak` s
    /// (reaching it in `smileIn`), the still's mouth included.
    static let release = 1.0, smileIn = 0.25, smilePeak = 0.6
    /// A replaced feeling fades out over this long (s).
    static let fadeOut = 0.5

    /// The envelope of one event `tau` s after it starts (0…1 of its cap), while its reply plays.
    static func swell(_ tau: Double, cap: Double, afterglow: Double) -> Double {
        let low = cap > 0 ? min(afterglow, cap / 2) / cap : 0
        if tau <= 0 { return 0 }
        if tau < rise { return smoothstep(0, 1, tau / rise) }
        if tau < rise + peak { return 1 }
        if tau < rise + peak + settle { return 1 - (1 - low) * smoothstep(0, 1, (tau - rise - peak) / settle) }
        return low
    }

    private var events: [FaceExpressionEvent] = []
    private var utterance: Int?
    /// renderer time − reply audio time (s), from the last frame that had the audio clock.
    private var offset: Double?
    private var lastT: Double?
    /// Renderer time the reply's audio clock stopped (nil while it plays or before it started).
    private var replyEnded: Double?
    private var hadAudio = false
    /// The feeling on screen and the weights it had last frame (a replaced one fades from there).
    private var current: (key: FaceExpression, start: Int)?
    private var fading: [FaceExpression: (band: Double, face: Double, at: Double)] = [:]
    /// Renderer time of the last event shown (profile C's gap).
    private var lastShownAt = -Double.infinity
    /// Weights drawn at the last step: the eyes/brows band and the whole face (mouth included).
    private(set) var shown: [FaceExpression: (band: Double, face: Double)] = [:]

    /// A new reply (any of its events reached the driver first): the old reply's events and audio clock go, so its
    /// expression can't come back on the new reply's clock (codex P2). Same id again: nothing changes.
    mutating func begin(utterance u: Int) {
        guard u != utterance else { return }
        events = []; offset = nil; utterance = u; replyEnded = nil; hadAudio = false
    }

    mutating func add(_ e: FaceExpressionEvent, utterance u: Int?) {
        // the driver begins every reply before its events; a caller that does not (the render tool) begins here.
        // An event arriving after its reply's audio keeps that reply's clock (codex P2).
        if let u { begin(utterance: u) }
        let p = profile
        if p.minIntensity > 0 {
            guard e.intensity >= p.minIntensity, (lastT ?? 0) - lastShownAt >= p.gap else { return }
            lastShownAt = lastT ?? 0
        }
        events.append(e)
    }

    /// Barge-in / cancel: the reply's events go; whatever is on screen fades out.
    mutating func cancel() { events = []; offset = nil; utterance = nil; replyEnded = nil; hadAudio = false }

    /// Advances to renderer time `t` (s). `audioMs` = the reply's audio clock this frame (nil when nothing plays: the
    /// clock is extrapolated from the last frame that had it).
    mutating func step(at t: Double, audioMs: Double?, openness: Double, available: Set<FaceExpression>) -> [FaceExpression: (band: Double, face: Double)] {
        lastT = t
        if let a = audioMs { offset = t - a / 1000; hadAudio = true; replyEnded = nil } else if hadAudio, replyEnded == nil { replyEnded = t }
        let now: Double? = audioMs ?? offset.map { (t - $0) * 1000 }
        let post = replyEnded.map { t - $0 }   // s since the reply's audio ended
        let p = profile

        // the latest-starting event that has begun; a face without a still for it shows none (codex P2)
        var target: (key: FaceExpression, event: FaceExpressionEvent)?
        if let ms = now, post.map({ $0 < Self.smileIn + Self.smilePeak + Self.release }) ?? true {
            let latest = events.filter { ms >= Double($0.startMs) - Self.lead * 1000 }.max { $0.startMs < $1.startMs }
            if let e = latest, let k = FaceExpression.stills(forTag: e.tag, intensity: e.intensity).first(where: { available.contains($0) }) {
                target = (k, e)
            }
        }
        if let c = current, c.key != target?.key || c.start != target?.event.startMs {
            if let w = shown[c.key] { fading[c.key] = (w.band, w.face, t) }
            current = nil
        }
        var out: [FaceExpression: (band: Double, face: Double)] = [:]
        if let (k, e) = target, let ms = now {
            current = (k, e.startMs)
            fading[k] = nil
            let cap = p.caps[e.tag] ?? 0.3
            let tau = (ms - (Double(e.startMs) - Self.lead * 1000)) / 1000
            var band = cap * Self.swell(tau, cap: cap, afterglow: p.afterglow)
            var face = 0.0
            if let post {
                // after the reply: what was showing goes within `release`; a smile first swells (mouth too) for a moment
                band *= 1 - smoothstep(0, 1, post / Self.release)
                if k == .smile || k == .warm {
                    let up = post < Self.smileIn ? smoothstep(0, 1, post / Self.smileIn)
                        : post < Self.smileIn + Self.smilePeak ? 1
                        : 1 - smoothstep(0, 1, (post - Self.smileIn - Self.smilePeak) / Self.release)
                    face = p.mouthPeak * up
                    band = max(band, cap * up)
                }
            }
            if band > 0.002 || face > 0.002 { out[k] = (band, face) }
        }
        for (k, f) in fading where out[k] == nil {
            let a = 1 - smoothstep(0, 1, (t - f.at) / Self.fadeOut)
            if a <= 0 { fading[k] = nil; continue }
            out[k] = (f.band * a, f.face * a)
        }
        _ = openness
        shown = out
        return out
    }
}
