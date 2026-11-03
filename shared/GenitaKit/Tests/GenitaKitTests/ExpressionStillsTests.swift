import CoreGraphics
import Foundation
import Testing
@testable import GenitaKit

private let fixture = Bundle.module.url(forResource: "face-animal", withExtension: nil, subdirectory: "Fixtures")!
private let dogSet: FaceSet = try! FaceSet(directory: fixture)
private let all = Set(FaceExpression.allCases)

private func px(_ image: CGImage?) -> [UInt8] {
    guard let image, let data = image.dataProvider?.data else { return [] }
    return [UInt8](data as Data)
}

/// Mean |a − b| over rows y0..<y1 of two RGBA frames of width w.
private func bandDiff(_ a: [UInt8], _ b: [UInt8], w: Int, y0: Int, y1: Int) -> Double {
    var s = 0.0, n = 0
    for y in y0..<y1 { for x in 0..<w { for c in 0..<3 { let k = (y * w + x) * 4 + c; s += abs(Double(a[k]) - Double(b[k])); n += 1 } } }
    return s / Double(max(1, n))
}

struct ExpressionStillsTests {
    /// 30 fps through `seconds`, audio clock = t (ms) while `audioUntil`, then none (the reply has played out).
    private func run(_ s: inout ExpressionStills, seconds: Double, audioUntil: Double = .infinity, open: Double = 0.2) -> [(t: Double, w: [FaceExpression: Double], rest: Double)] {
        var out: [(Double, [FaceExpression: Double], Double)] = []
        for i in 0...Int(seconds * 30) {
            let t = Double(i) / 30
            let speaking = t < audioUntil
            let r = s.step(at: t, audioMs: speaking ? t * 1000 : nil, openness: speaking ? open : 0, available: all)
            out.append((t, r.weights, r.rest))
        }
        return out
    }

    @Test func noEventNoWeight() {
        var s = ExpressionStills()
        for f in run(&s, seconds: 5) { #expect(f.w.isEmpty); #expect(f.rest == 0) }
    }

    @Test func tagsPickTheirStillWithFallbacks() {
        #expect(FaceExpression.stills(forTag: "smile", intensity: 0.45).first == .warm)
        #expect(FaceExpression.stills(forTag: "smile", intensity: 0.65).first == .smile)
        #expect(FaceExpression.stills(forTag: "smileopen", intensity: 0.9).first == .smile)
        #expect(FaceExpression.stills(forTag: "laugh", intensity: 1) == [.smile, .warm])
        #expect(FaceExpression.stills(forTag: "surprised", intensity: 0.85) == [.surprised])
        #expect(FaceExpression.stills(forTag: "concerned", intensity: 0.6) == [.concerned])
        #expect(FaceExpression.stills(forTag: "neutral", intensity: 1).isEmpty)
        // a face with only a warm still smiles with it
        var s = ExpressionStills()
        s.add(FaceExpressionEvent(tag: "laugh", intensity: 1, startMs: 0, endMs: 1000), utterance: 1)
        _ = s.step(at: 0, audioMs: 0, openness: 0.2, available: [.neutral, .warm])
        #expect(s.step(at: 0.2, audioMs: 200, openness: 0.2, available: [.neutral, .warm]).weights.keys.contains(.warm))
        // a face prepped before surprised / concerned existed shows nothing for them
        var n = ExpressionStills()
        n.add(FaceExpressionEvent(tag: "surprised", intensity: 0.85, startMs: 0, endMs: 1000), utterance: 1)
        _ = n.step(at: 0, audioMs: 0, openness: 0.2, available: [.neutral, .smile, .warm])
        #expect(n.step(at: 0.5, audioMs: 500, openness: 0.2, available: [.neutral, .smile, .warm]).weights.isEmpty)
    }

    /// The envelope: in by the clause start (300 ms fade), held at the intensity's level through the rest of the
    /// reply and 2 s after its audio ends, out over 0.5 s; never a jump between frames (smoothstep ends).
    @Test func envelopeIsSmoothHeldAndRelaxes() {
        var s = ExpressionStills()
        s.add(FaceExpressionEvent(tag: "smile", intensity: 0.45, startMs: 1000, endMs: 2000), utterance: 3)
        let f = run(&s, seconds: 6, audioUntil: 2.5)
        let level = ExpressionStills.holdLevel(0.45)
        #expect(abs(level - 0.775) < 1e-9)
        func w(_ t: Double) -> Double { f.min(by: { abs($0.t - t) < abs($1.t - t) })!.w[.warm] ?? 0 }
        #expect(w(0.5) == 0)
        #expect(w(0.9) > 0 && w(0.9) < 0.1, "starts 150 ms early")
        #expect(abs(w(1.5) - level) < 1e-9)
        #expect(abs(w(4.4) - level) < 1e-9, "the reply's mood: held until 2 s after its audio")
        #expect(w(4.75) < level && w(4.75) > 0)
        #expect(w(5.2) == 0)
        var maxStep = 0.0
        for (a, b) in zip(f, f.dropFirst()) { maxStep = max(maxStep, abs((b.w[.warm] ?? 0) - (a.w[.warm] ?? 0))) }
        #expect(maxStep < 0.17 * level, "max frame-to-frame change \(maxStep)")
        #expect(f.allSatisfy { $0.w[.smile] == nil }, "a warm 0.45 is the soft look")
        // surprise, the biggest change on the face, comes in over 0.45 s (gate: single-frame eye-band step ≤ 3.0)
        #expect(ExpressionStills.fadeIn(.surprised) == 0.45 && ExpressionStills.fadeIn(.smile) == 0.3)
        // a short reply lets go 2 s after its audio
        var c = ExpressionStills()
        c.add(FaceExpressionEvent(tag: "concerned", intensity: 0.6, startMs: 0, endMs: 500), utterance: 1)
        #expect(run(&c, seconds: 4, audioUntil: 0.6).last!.w.isEmpty)
    }

    @Test func aLaterClauseTakesOverAndANewReplyDropsTheOld() {
        var s = ExpressionStills()
        s.add(FaceExpressionEvent(tag: "concerned", intensity: 0.6, startMs: 0, endMs: 1000), utterance: 1)
        s.add(FaceExpressionEvent(tag: "smile", intensity: 0.7, startMs: 1500, endMs: 2500), utterance: 1)
        let f = run(&s, seconds: 3)
        let at2 = f.first { $0.t >= 2.2 }!.w
        #expect((at2[.smile] ?? 0) > 0.8)
        #expect(at2[.concerned] == nil)
        // utterance 2's events replace utterance 1's (its audio clock restarts at 0)
        var r = ExpressionStills()
        r.add(FaceExpressionEvent(tag: "surprised", intensity: 0.85, startMs: 0, endMs: 3000), utterance: 1)
        r.add(FaceExpressionEvent(tag: "smile", intensity: 0.7, startMs: 5000, endMs: 6000), utterance: 2)
        #expect(run(&r, seconds: 2).allSatisfy { $0.w[.surprised] == nil })
    }

    /// Codex P2 ×3: a next reply without events never brings the old one back on its restarted clock; an event that
    /// arrives after its reply's audio keeps that reply's clock; a newer feeling the face has no still for ends the old one.
    @Test func repliesKeepTheirOwnEventsAndClock() {
        var s = ExpressionStills()
        s.begin(utterance: 1)
        s.add(FaceExpressionEvent(tag: "smile", intensity: 0.7, startMs: 0, endMs: 800), utterance: 1)
        _ = run(&s, seconds: 5, audioUntil: 1.0)
        s.begin(utterance: 2)   // the next reply's audio starts; it has no expression
        var w: [FaceExpression: Double] = [:]
        for i in 0...60 { let t = 5 + Double(i) / 30; w = s.step(at: t, audioMs: Double(i) / 30 * 1000, openness: 0.2, available: all).weights; #expect(w.isEmpty, "t=\(t)") }

        var late = ExpressionStills()
        late.begin(utterance: 4)
        for i in 0...30 { _ = late.step(at: Double(i) / 30, audioMs: Double(i) / 30 * 1000, openness: 0.2, available: all) }
        late.add(FaceExpressionEvent(tag: "surprised", intensity: 0.85, startMs: 200, endMs: 900), utterance: 4)   // after the audio
        var shown = 0.0
        for i in 31...60 { shown = max(shown, late.step(at: Double(i) / 30, audioMs: nil, openness: 0, available: all).weights[.surprised] ?? 0) }
        #expect(shown > 0.9, "the reply's mood still shows after its audio")

        var gone = ExpressionStills()
        gone.add(FaceExpressionEvent(tag: "smile", intensity: 0.7, startMs: 0, endMs: 500), utterance: 1)
        gone.add(FaceExpressionEvent(tag: "concerned", intensity: 0.6, startMs: 1000, endMs: 1500), utterance: 1)
        let f = (0...75).map { i in gone.step(at: Double(i) / 30, audioMs: Double(i) / 30 * 1000, openness: 0.2, available: [.neutral, .smile, .warm]) }
        #expect((f[20].weights[.smile] ?? 0) > 0.8)
        #expect(f.last!.weights.isEmpty, "no still for concerned: the smile ends")
    }

    @Test func cancelRelaxesSmoothly() {
        var s = ExpressionStills()
        s.add(FaceExpressionEvent(tag: "surprised", intensity: 0.85, startMs: 0, endMs: 5000), utterance: 1)
        _ = run(&s, seconds: 1)
        s.cancel()
        let a = s.step(at: 1.0 + 1.0 / 30, audioMs: nil, openness: 0, available: all).weights[.surprised] ?? 0
        #expect(a > 0.8, "no snap")
        let b = (1...30).map { s.step(at: 1.0 + Double($0) / 30 + 1.0 / 30, audioMs: nil, openness: 0, available: all) }.last!.weights[.surprised] ?? 0
        #expect(b == 0)
    }

    /// The still's own mouth (the smile itself) joins only after the reply's audio ended and the lips were quiet 0.4 s.
    @Test func mouthJoinsOnlyAfterTheReply() {
        var s = ExpressionStills()
        s.add(FaceExpressionEvent(tag: "smile", intensity: 0.7, startMs: 0, endMs: 1500), utterance: 1)
        let f = run(&s, seconds: 3, audioUntil: 1.5, open: 0)   // quiet lips mid-reply still do not count
        #expect(f.filter { $0.t < 1.5 }.allSatisfy { $0.rest == 0 })
        #expect(f.filter { $0.t < 1.85 }.allSatisfy { $0.rest == 0 })
        #expect(f.first { $0.t >= 2.4 }!.rest > 0.9)
    }

    // MARK: renderer

    /// An event that is not active draws nothing: the frames are the plain still face (the still-face gates hold).
    @Test func inactiveEventsLeaveEveryPixel() {
        let size = CGSize(width: 180, height: 320)
        let a = FaceRenderer(faceSet: dogSet, outputSize: size, seed: 5, reduceMotion: true)
        let b = FaceRenderer(faceSet: dogSet, outputSize: size, seed: 5, reduceMotion: true)
        b.addExpression(FaceExpressionEvent(tag: "smile", intensity: 1, startMs: 60_000, endMs: 61_000), utteranceId: 1)
        let tl = LipTimeline()
        for t in stride(from: 0.0, to: 2.0, by: 0.2) {
            let ctx = LipContext(audioMs: t * 1000, timeline: tl)
            #expect(px(a.render(at: t, lip: .rest, lipContext: ctx)) == px(b.render(at: t, lip: .rest, lipContext: ctx)), "t=\(t)")
        }
        #expect(b.expressionStillWeights.isEmpty)
    }

    /// During an active event the eyes/brows band shows the expression still; outside the face nothing changes.
    @Test func anActiveEventShowsTheStillInTheEyes() throws {
        let size = CGSize(width: 180, height: 320)
        let a = FaceRenderer(faceSet: dogSet, outputSize: size, seed: 5, reduceMotion: true)
        let b = FaceRenderer(faceSet: dogSet, outputSize: size, seed: 5, reduceMotion: true)
        b.addExpression(FaceExpressionEvent(tag: "surprised", intensity: 0.85, startMs: 0, endMs: 3000), utteranceId: 1)
        let tl = LipTimeline()
        var x: [UInt8] = [], y: [UInt8] = []
        for t in stride(from: 0.0, through: 1.0, by: 1.0 / 30) {
            let ctx = LipContext(audioMs: t * 1000, timeline: tl)
            x = px(a.render(at: t, lip: .rest, lipContext: ctx)); y = px(b.render(at: t, lip: .rest, lipContext: ctx))
        }
        #expect((b.expressionStillWeights[.surprised] ?? 0) > 0.9)
        // eyes: face box 25–59 % of the height, eyes in its upper half
        let eyes = bandDiff(x, y, w: 180, y0: Int(0.30 * 320), y1: Int(0.42 * 320))
        let top = bandDiff(x, y, w: 180, y0: 0, y1: Int(0.12 * 320))
        #expect(eyes > 2, "eye band \(eyes)")
        #expect(top < 0.5, "background above the head \(top)")
    }
}
