// L4 face · The "alive base": procedural motion that makes a still read as a live selfie video.
// No video model. The frame is split into three soft layers that move separately:
//   head  — slow noise-driven tilt (±1.3°) and drift (1–2 px at output size), plus a small nod
//           on speech onsets (a critically damped spring following the loudness rise);
//   body  — breathing (≈0.25 Hz chest/shoulder scale) that the head rides on;
//   camera — handheld drift of the whole frame (±3 px, ±0.25°, ±0.4% zoom) with the person
//            moving a little more than the background (parallax).
// Everything is deterministic for a seed and time-ordered calls. Coordinates are Core Image
// image coordinates (y up) of the face-set still.

import CoreGraphics
import Foundation

struct AliveMotion {
    // Amplitudes in output pixels (converted with the still→output scale) and degrees.
    static let headRollDegrees = 1.3
    static let headDriftX = 2.0, headDriftY = 1.2
    static let nodPixels = 2.5            // at a full-loudness onset
    static let nodPitch = 0.006           // vertical foreshortening at full nod
    static let breathingHz = 0.25
    static let breathingScale = 0.006
    // Kept small: a review of the reference talking-head clip measured its background as nearly still.
    static let cameraDrift = 1.0, cameraJitter = 0.3
    static let cameraRollDegrees = 0.1
    static let cameraZoom = 0.0015
    static let parallax = 0.15            // person moves 15% more than the background
    /// Output is scaled up this much so camera drift never shows the frame edge.
    static let overscan: CGFloat = 1.03

    private var phases: [Double] = []
    private var nod = 0.0, nodVelocity = 0.0
    private var slowOpen = 0.0
    private var lastT: Double?

    /// Per-face gains (map.alive): head sway/drift and the speech nod.
    var headGain = 1.0, nodGain = 1.0, rollGain = 1.0, nodWidth = 1.0
    /// Handheld-camera drift (11/3 Chelsea: the background must stay still) — off unless a map asks.
    var cameraGain = 0.0
    /// 11/3 pm (Chelsea: "the background is locked but the person bobs up and down"): the person layer
    /// never moves vertically against the locked still — no speech nod, no vertical drift, no breathing.
    /// The nod (map nodPx 5 = 2× → ±5 px), the vertical drift (headX 3 → ±3.6 px) and the breathing
    /// scale (±0.6% about the frame bottom, ±3–4 px at the eyes) summed to 16 px peak-to-peak at the
    /// eyes on T9. Horizontal sway and the small roll stay (they read as a live selfie, not a bob).
    var lockVertical = true
    /// 11/4 (Chelsea: "the voice comes out but the face is frozen"): the whole frame moves as one rigid piece with the
    /// speech — slow sway (0.3–0.8 Hz) sized by the speech energy, a small nod on stressed onsets, a slight drop at the
    /// end of a sentence, a breath when quiet. Caps at output size: ±1.5 px, ±0.6°, ±0.4 % scale. No local warp: eyes,
    /// nose and mouth move together (the eye band stays still relative to the face). Map `alive.sway` scales it (0 = off).
    var swayGain = 1.0
    static let swayMaxPx = 1.5, swayMaxDeg = 0.6, swayMaxScale = 0.004
    private var energy = 0.0, energyPeak = 0.0

    init(seed: UInt64) {
        var rng = SplitMix64(seed: seed &+ 0xA11E)
        phases = (0..<30).map { _ in rng.nextUnit() * 2 * .pi }
    }

    /// Smooth noise in about [-1, 1]: three incommensurate sines with seeded phases.
    func noise(_ k: Int, hz: Double, _ t: Double) -> Double {
        let p = phases[(k * 3) % phases.count], q = phases[(k * 3 + 1) % phases.count], r = phases[(k * 3 + 2) % phases.count]
        let w = 2 * Double.pi * hz * t
        return (sin(w + p) + 0.6 * sin(1.73 * w + q) + 0.3 * sin(2.91 * w + r)) / 1.9
    }

    /// Advances the nod spring to `t` with the current openness and returns the layer transforms.
    mutating func transforms(at t: Double, open: Double, face: CGRect, extent: CGRect, outputWidth: CGFloat)
        -> (head: CGAffineTransform, body: CGAffineTransform, camera: CGAffineTransform)
    {
        // Output px → still px.
        let k = Double(extent.width) / max(1, Double(outputWidth))

        // Speech onset energy: openness above its own slow average drives the nod target.
        let dt = lastT.map { t - $0 } ?? 0
        if dt < 0 || dt > 0.5 { nod = 0; nodVelocity = 0; slowOpen = open }   // jump: restart
        else if dt > 0 {
            let steps = max(1, Int((dt * 120).rounded(.up)))
            let h = dt / Double(steps)
            let omega = 14.0
            for _ in 0..<steps {
                slowOpen += (open - slowOpen) * min(1, h / (0.4 * max(0.25, nodWidth)))   // wider pulse, same peak
                // a wider envelope also raises the peak (~×1.2 at width 2, codex): keep the peak
                let target = max(0, open - slowOpen) * 1.6 * pow(max(0.25, nodWidth), -0.26)
                let a = omega * omega * (min(1, target) - nod) - 2 * omega * nodVelocity
                nodVelocity += a * h
                nod += nodVelocity * h
            }
        }
        lastT = t

        // Camera (whole frame) about the frame centre.
        let c = CGPoint(x: extent.midX, y: extent.midY)
        let cg = cameraGain
        let camX = (Self.cameraDrift * noise(0, hz: 0.06, t) + Self.cameraJitter * noise(1, hz: 0.33, t)) * k * cg
        let camY = (Self.cameraDrift * noise(2, hz: 0.05, t) + Self.cameraJitter * noise(3, hz: 0.29, t)) * k * cg
        let camRoll = Self.cameraRollDegrees * .pi / 180 * noise(4, hz: 0.045, t) * cg
        let zoom = 1 + Self.cameraZoom * noise(5, hz: 0.04, t) * cg
        let camera = CGAffineTransform(translationX: -c.x, y: -c.y)
            .concatenating(CGAffineTransform(rotationAngle: camRoll))
            .concatenating(CGAffineTransform(scaleX: zoom, y: zoom))
            .concatenating(CGAffineTransform(translationX: c.x + camX, y: c.y + camY))
        let parallax = CGAffineTransform(translationX: Self.parallax * camX, y: Self.parallax * camY)

        // Body: breathing about the bottom of the frame under the face, plus parallax.
        let breath = lockVertical ? 0 : sin(2 * .pi * Self.breathingHz * t)
        let bottom = CGPoint(x: face.midX, y: extent.minY)
        let body = CGAffineTransform(translationX: -bottom.x, y: -bottom.y)
            .concatenating(CGAffineTransform(scaleX: 1 + Self.breathingScale * 0.5 * breath, y: 1 + Self.breathingScale * breath))
            .concatenating(CGAffineTransform(translationX: bottom.x, y: bottom.y))
            .concatenating(parallax)

        // Speech-coupled rigid sway (see swayGain): energy low-passed (0.6 s), its recent peak decays over 1.5 s.
        if dt > 0, dt <= 0.5 {
            energy += (open - energy) * min(1, dt / 0.6)
            energyPeak = max(energy, energyPeak * exp(-dt / 1.5))
        } else if dt < 0 || dt > 0.5 { energy = open; energyPeak = open }
        var sway = CGAffineTransform.identity
        if swayGain > 0 {
            let live = 0.3 + 0.7 * min(1, energy / 0.5)                      // quiet: a breath of motion; talking: full
            let endDrop = max(0, min(1, (energyPeak - energy) / 0.3))        // a sentence ends: the head settles down a little
            let sx = Self.swayMaxPx * swayGain * live * noise(9, hz: 0.45, t)
            var sy = 0.6 * Self.swayMaxPx * swayGain * live * noise(10, hz: 0.55, t)
            sy -= 0.6 * swayGain * min(1, nod)                                 // stressed onset: a small nod (down)
            sy -= 0.5 * swayGain * endDrop
            sy += 0.25 * swayGain * (1 - live) * sin(2 * .pi * Self.breathingHz * t)   // quiet breath
            let cx = max(-Self.swayMaxPx, min(Self.swayMaxPx, sx)) * k
            let cy = max(-Self.swayMaxPx, min(Self.swayMaxPx, sy)) * k
            let rr = max(-Self.swayMaxDeg, min(Self.swayMaxDeg, Self.swayMaxDeg * swayGain * live * noise(11, hz: 0.35, t))) * .pi / 180
            let sc = 1 + max(-Self.swayMaxScale, min(Self.swayMaxScale, Self.swayMaxScale * swayGain * live * noise(12, hz: 0.3, t)))
            // about the face centre: the eyes, nose and mouth stay within the caps (a neck pivot swung the forehead 3 px per 0.5°)
            let pivot = CGPoint(x: face.midX, y: face.midY)
            sway = CGAffineTransform(translationX: -pivot.x, y: -pivot.y)
                .concatenating(CGAffineTransform(scaleX: sc, y: sc))
                .concatenating(CGAffineTransform(rotationAngle: rr))
                .concatenating(CGAffineTransform(translationX: pivot.x + cx, y: pivot.y + cy))
        }

        // Head: tilt about the neck, drift, nod (down + slight pitch), then it rides the body.
        let neck = CGPoint(x: face.midX, y: face.minY - face.height * 0.15)
        let roll = Self.headRollDegrees * rollGain * .pi / 180 * noise(6, hz: 0.11, t)
        let dx = Self.headDriftX * headGain * noise(7, hz: 0.08, t) * k
        let dy = lockVertical ? 0 : (Self.headDriftY * headGain * noise(8, hz: 0.13, t) - Self.nodPixels * nodGain * nod) * k
        let pitch = lockVertical ? 1 : 1 - Self.nodPitch * nod
        let headLocal = CGAffineTransform(translationX: -neck.x, y: -neck.y)
            .concatenating(CGAffineTransform(scaleX: 1, y: pitch))
            .concatenating(CGAffineTransform(rotationAngle: roll))
            .concatenating(CGAffineTransform(translationX: neck.x + dx, y: neck.y + dy))
        // 11/4 01:00 (Chelsea: the clay's outline shimmered): the sway moves the whole frame like a hand-held phone,
        // background included — no head-mask seam can stretch. The output is already over-scanned (`overscan`), so a
        // 1.5 px move never shows an edge.
        return (headLocal.concatenating(body), body, sway.concatenating(camera))
    }
}
