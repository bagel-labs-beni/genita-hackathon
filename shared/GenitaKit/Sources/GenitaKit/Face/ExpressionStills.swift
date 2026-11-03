// L4 face · Expression stills layer state (11/3 night): which prepped expression still shows, and how much, at a
// renderer time. Driven only by server `expression` events (per reply clause, reply audio clock); no event → no
// weight, so plain speech keeps the still-face gates. Pure value type: same calls in the same order → same weights.
//
//   event  ─ lead ─┬── clause (startMs…endMs) ──┬── rest of the reply ──┬ audio ends ┬ 2 s ┐
//   weight   0 ↗ fade in (smoothstep, 0.3 s; surprise 0.45 s) → hold level ………………………………………………………………… ↘ fade out (0.5 s) → 0
//   mouth     talking (lip layer; eyes/brows at the still's talk share)          │ the still's own smile joins
//
// The hold level follows the server intensity (a warm 0.45 is a soft look, an excited 0.9 the full still). A later
// clause's event takes over (its still fades in while the old one fades out). The renderer blends the eyes, brows
// and cheeks always, and the whole face (the still's own smile) once the reply's audio has ended and the mouth has been
// quiet for `restAfter` (the mood hold after the last clause).

import Foundation

struct ExpressionStills {
    /// Fade in, starting `lead` before the clause's first word (s). Surprise is the biggest change on the face (brows
    /// and lids): 0.45 s keeps its single-frame step under the gate (clay 3.82 grey levels at 0.3 s, 3.07 at 0.4 s).
    static let fadeIn = 0.3, lead = 0.15
    static func fadeIn(_ e: FaceExpression) -> Double { e == .surprised ? 0.45 : fadeIn }
    /// Fade out after the mood hold (s).
    static let fadeOut = 0.5
    /// The feeling lingers this long after the clause's last word (s), and at least through the rest of the reply
    /// and `replyHold` after its audio ends (the reply's mood).
    static let moodHold = 1.2, replyHold = 2.0
    /// While the mouth talks, the eyes/brows band shows this share of the still: a smiling-eyes look without the
    /// smiling mouth reads as a squint, so smiles stay light until the reply ends and the whole smile shows.
    static func talkShare(_ e: FaceExpression) -> Double {
        switch e {
        case .smile: return 0.6
        case .warm: return 0.75
        default: return 1
        }
    }
    /// The still's own mouth joins once the reply's audio has ended and the lips have been quiet this long (s), fading in over `restFadeIn`;
    /// it leaves within `restFadeOut` when the mouth moves again.
    static let restAfter = 0.4, restFadeIn = 0.35, restFadeOut = 0.12
    /// Lip openness above this counts as talking.
    static let voiced = 0.03

    /// Server intensity → how far the still is blended in while held.
    static func holdLevel(_ intensity: Double) -> Double {
        min(1, max(0.5, 0.55 + 0.5 * (intensity.isFinite ? intensity : 0.7)))
    }

    private var events: [FaceExpressionEvent] = []
    private var utterance: Int?
    /// renderer time − reply audio time (s), from the last frame that had the audio clock.
    private var offset: Double?
    private var presence: [FaceExpression: Double] = [:]
    private var level: [FaceExpression: Double] = [:]
    private var lastT: Double?
    private var lastVoiced = -Double.infinity
    /// Renderer time the reply's audio clock stopped (nil while it plays or before it started).
    private var replyEnded: Double?
    private var hadAudio = false
    private var restV = 0.0
    /// Weights drawn at the last step.
    private(set) var shown: [FaceExpression: Double] = [:]

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
        events.append(e)
    }

    /// Barge-in / cancel: the reply's events go; whatever is on screen fades out.
    mutating func cancel() { events = []; offset = nil; utterance = nil; replyEnded = nil; hadAudio = false }

    /// Advances to renderer time `t` (s). `audioMs` = the reply's audio clock this frame (nil when nothing plays: the
    /// clock is extrapolated from the last frame that had it, so the mood hold runs out after the audio ends).
    mutating func step(at t: Double, audioMs: Double?, openness: Double, available: Set<FaceExpression>) -> (weights: [FaceExpression: Double], rest: Double) {
        let dt = lastT.map { min(0.1, max(0, t - $0)) } ?? 0
        lastT = t
        if let a = audioMs { offset = t - a / 1000; hadAudio = true; replyEnded = nil } else if hadAudio, replyEnded == nil { replyEnded = t }
        let now: Double? = audioMs ?? offset.map { (t - $0) * 1000 }
        // the reply's mood holds while its audio plays and `replyHold` after it ends
        let replyOn = audioMs != nil || (replyEnded.map { t - $0 < Self.replyHold } ?? false)

        // the latest-starting event whose window holds `now`; a face without a still for it shows none (the
        // earlier feeling does not linger on, codex P2)
        var target: FaceExpression?
        if let ms = now {
            var latest: FaceExpressionEvent?
            for e in events where ms >= Double(e.startMs) - Self.lead * 1000 && Double(e.startMs) >= Double(latest?.startMs ?? Int.min)
                && (ms <= Double(e.endMs) + Self.moodHold * 1000 || replyOn) { latest = e }
            if let e = latest, let k = FaceExpression.stills(forTag: e.tag, intensity: e.intensity).first(where: { available.contains($0) }) {
                target = k; level[k] = Self.holdLevel(e.intensity)
            }
        }
        var keys = Set(presence.keys)
        if let target { keys.insert(target) }
        for k in keys {
            let p = presence[k] ?? 0
            presence[k] = k == target ? min(1, p + dt / Self.fadeIn(k)) : max(0, p - dt / Self.fadeOut)
        }
        presence = presence.filter { $0.value > 0 }
        if target == nil && presence.isEmpty { level = [:] }

        // the mouth joins only after the reply's audio has ended (never between clauses: no mouth flicker mid-reply)
        if openness > Self.voiced || audioMs != nil { lastVoiced = t }
        restV = t - lastVoiced >= Self.restAfter ? min(1, restV + dt / Self.restFadeIn) : max(0, restV - dt / Self.restFadeOut)

        shown = presence.reduce(into: [:]) { out, kv in
            let w = (level[kv.key] ?? 1) * smoothstep(0, 1, kv.value)
            if w > 0 { out[kv.key] = w }
        }
        return (shown, shown.isEmpty ? 0 : smoothstep(0, 1, restV))
    }
}
