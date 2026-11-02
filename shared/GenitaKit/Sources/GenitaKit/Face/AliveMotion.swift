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
    static let cameraDrift = 3.0, cameraJitter = 0.8
    static let cameraRollDegrees = 0.25
    static let cameraZoom = 0.004
    static let parallax = 0.15            // person moves 15% more than the background
    /// Output is scaled up this much so camera drift never shows the frame edge.
    static let overscan: CGFloat = 1.03

    private var phases: [Double] = []
    private var nod = 0.0, nodVelocity = 0.0
    private var slowOpen = 0.0
    private var lastT: Double?

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
                slowOpen += (open - slowOpen) * min(1, h / 0.4)
                let target = max(0, open - slowOpen) * 1.6
                let a = omega * omega * (min(1, target) - nod) - 2 * omega * nodVelocity
                nodVelocity += a * h
                nod += nodVelocity * h
            }
        }
        lastT = t

        // Camera (whole frame) about the frame centre.
        let c = CGPoint(x: extent.midX, y: extent.midY)
        let camX = (Self.cameraDrift * noise(0, hz: 0.06, t) + Self.cameraJitter * noise(1, hz: 0.33, t)) * k
        let camY = (Self.cameraDrift * noise(2, hz: 0.05, t) + Self.cameraJitter * noise(3, hz: 0.29, t)) * k
        let camRoll = Self.cameraRollDegrees * .pi / 180 * noise(4, hz: 0.045, t)
        let zoom = 1 + Self.cameraZoom * noise(5, hz: 0.04, t)
        let camera = CGAffineTransform(translationX: -c.x, y: -c.y)
            .concatenating(CGAffineTransform(rotationAngle: camRoll))
            .concatenating(CGAffineTransform(scaleX: zoom, y: zoom))
            .concatenating(CGAffineTransform(translationX: c.x + camX, y: c.y + camY))
        let parallax = CGAffineTransform(translationX: Self.parallax * camX, y: Self.parallax * camY)

        // Body: breathing about the bottom of the frame under the face, plus parallax.
        let breath = sin(2 * .pi * Self.breathingHz * t)
        let bottom = CGPoint(x: face.midX, y: extent.minY)
        let body = CGAffineTransform(translationX: -bottom.x, y: -bottom.y)
            .concatenating(CGAffineTransform(scaleX: 1 + Self.breathingScale * 0.5 * breath, y: 1 + Self.breathingScale * breath))
            .concatenating(CGAffineTransform(translationX: bottom.x, y: bottom.y))
            .concatenating(parallax)

        // Head: tilt about the neck, drift, nod (down + slight pitch), then it rides the body.
        let neck = CGPoint(x: face.midX, y: face.minY - face.height * 0.15)
        let roll = Self.headRollDegrees * .pi / 180 * noise(6, hz: 0.11, t)
        let dx = Self.headDriftX * noise(7, hz: 0.08, t) * k
        let dy = (Self.headDriftY * noise(8, hz: 0.13, t) - Self.nodPixels * nod) * k
        let pitch = 1 - Self.nodPitch * nod
        let headLocal = CGAffineTransform(translationX: -neck.x, y: -neck.y)
            .concatenating(CGAffineTransform(scaleX: 1, y: pitch))
            .concatenating(CGAffineTransform(rotationAngle: roll))
            .concatenating(CGAffineTransform(translationX: neck.x + dx, y: neck.y + dy))
        return (headLocal.concatenating(body), body, camera)
    }
}
