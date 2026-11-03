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
    typealias W = [FaceExpression: (band: Double, face: Double)]
    /// 30 fps through `seconds`, audio clock = t (ms) while `audioUntil`, then none (the reply has played out).
    private func run(_ s: inout ExpressionStills, seconds: Double, audioUntil: Double = .infinity, from t0: Double = 0) -> [(t: Double, w: W)] {
        var out: [(Double, W)] = []
        for i in 0...Int(seconds * 30) {
            let t = t0 + Double(i) / 30
            let speaking = t < audioUntil
            out.append((t, s.step(at: t, audioMs: speaking ? (t - t0) * 1000 : nil, openness: speaking ? 0.2 : 0, available: all)))
        }
        return out
    }
    private func at(_ f: [(t: Double, w: W)], _ t: Double, _ k: FaceExpression) -> (band: Double, face: Double) {
        f.min(by: { abs($0.t - t) < abs($1.t - t) })!.w[k] ?? (0, 0)
    }

    @Test func noEventNoWeight() {
        var s = ExpressionStills()
        for f in run(&s, seconds: 5) { #expect(f.w.isEmpty) }
    }

    @Test func tagsPickTheirStillWithFallbacks() {
        #expect(FaceExpression.stills(forTag: "smile", intensity: 0.45).first == .warm)
        #expect(FaceExpression.stills(forTag: "smile", intensity: 0.65).first == .smile)
        #expect(FaceExpression.stills(forTag: "smileopen", intensity: 0.9).first == .smile)
        #expect(FaceExpression.stills(forTag: "laugh", intensity: 1) == [.smile, .warm])
        #expect(FaceExpression.stills(forTag: "surprised", intensity: 0.85) == [.surprised])
        #expect(FaceExpression.stills(forTag: "concerned", intensity: 0.6) == [.concerned])
        #expect(FaceExpression.stills(forTag: "neutral", intensity: 1).isEmpty)
        var s = ExpressionStills()
        s.add(FaceExpressionEvent(tag: "laugh", intensity: 1, startMs: 0, endMs: 1000), utterance: 1)
        _ = s.step(at: 0, audioMs: 0, openness: 0.2, available: [.neutral, .warm])
        #expect(s.step(at: 0.5, audioMs: 500, openness: 0.2, available: [.neutral, .warm]).keys.contains(.warm))
        var n = ExpressionStills()
        n.add(FaceExpressionEvent(tag: "surprised", intensity: 0.85, startMs: 0, endMs: 1000), utterance: 1)
        _ = n.step(at: 0, audioMs: 0, openness: 0.2, available: [.neutral, .smile, .warm])
        #expect(n.step(at: 0.5, audioMs: 500, openness: 0.2, available: [.neutral, .smile, .warm]).isEmpty)
    }

    /// v2 (Chelsea 23:5x "a sticker swapped in"): a swell — 0.7 s in, peak ≤ 0.8 s at the cap, 1.2 s down to the
    /// afterglow, gone within 1 s after the reply; caps keep the photo dominant; no frame jumps.
    @Test func aFeelingIsAShortSwellNotAHeldStill() {
        let p = ExpressionStills.Profile.a
        #expect(p.caps["surprised"] == 0.35 && p.caps["concerned"] == 0.3 && p.caps["smile"] == 0.5 && p.caps["laugh"] == 0.45)
        var s = ExpressionStills()
        s.add(FaceExpressionEvent(tag: "concerned", intensity: 0.6, startMs: 1000, endMs: 2500), utterance: 3)
        let f = run(&s, seconds: 8, audioUntil: 5.0)
        func w(_ t: Double) -> Double { at(f, t, .concerned).band }
        #expect(w(0.8) == 0)
        #expect(w(1.0) > 0 && w(1.0) < 0.1, "eases in over 0.7 s")
        #expect(abs(w(1.9) - 0.3) < 1e-6, "peak at the cap")
        #expect(abs(w(4.5) - 0.15) < 1e-6, "afterglow while the reply goes on")
        #expect(w(6.1) == 0, "gone within 1 s after the reply")
        #expect(f.allSatisfy { ($0.w[.concerned]?.face ?? 0) == 0 }, "no still mouth for a concern")
        var maxStep = 0.0
        for (a, b) in zip(f, f.dropFirst()) { maxStep = max(maxStep, abs((b.w[.concerned]?.band ?? 0) - (a.w[.concerned]?.band ?? 0))) }
        #expect(maxStep < 0.03, "max frame-to-frame change \(maxStep)")
    }

    /// A smile: eyes/cheeks only while talking; after the reply the smile itself (mouth near full) for 0.6 s, then gone.
    @Test func aSmileShowsItsMouthOnlyJustAfterTheReply() {
        var s = ExpressionStills()
        s.add(FaceExpressionEvent(tag: "smile", intensity: 0.7, startMs: 0, endMs: 1500), utterance: 1)
        let f = run(&s, seconds: 5, audioUntil: 2.0)
        #expect(f.filter { $0.t < 2.0 }.allSatisfy { ($0.w[.smile]?.face ?? 0) == 0 }, "never while talking")
        #expect(at(f, 2.5, .smile).face > 0.85, "the smile right after the reply")
        #expect(at(f, 2.5, .smile).band <= 0.5 + 1e-9, "eyes stay at the cap")
        #expect(f.last!.w.isEmpty, "gone")
        #expect(ExpressionStills.Profile.b.mouthPeak == 0, "B never shows the still's mouth")
    }

    /// Profile C: only strong feelings (≥ .8), 12 s apart.
    @Test func profileCKeepsOnlyStrongFeelingsApart() {
        var s = ExpressionStills()
        s.profile = .c
        _ = s.step(at: 0, audioMs: 0, openness: 0.2, available: all)
        s.add(FaceExpressionEvent(tag: "concerned", intensity: 0.6, startMs: 0, endMs: 1000), utterance: 1)
        s.add(FaceExpressionEvent(tag: "surprised", intensity: 0.85, startMs: 100, endMs: 1000), utterance: 1)
        s.add(FaceExpressionEvent(tag: "laugh", intensity: 1, startMs: 200, endMs: 1000), utterance: 1)   // < 12 s later
        let f = run(&s, seconds: 2)
        #expect(f.allSatisfy { $0.w[.concerned] == nil && $0.w[.smile] == nil })
        #expect(f.contains { ($0.w[.surprised]?.band ?? 0) > 0.3 })
    }

    @Test func aLaterClauseTakesOverAndANewReplyDropsTheOld() {
        var s = ExpressionStills()
        s.add(FaceExpressionEvent(tag: "concerned", intensity: 0.6, startMs: 0, endMs: 1000), utterance: 1)
        s.add(FaceExpressionEvent(tag: "smile", intensity: 0.7, startMs: 1500, endMs: 2500), utterance: 1)
        let f = run(&s, seconds: 3)
        #expect(abs(at(f, 2.3, .smile).band - 0.5) < 1e-6)
        #expect(at(f, 2.3, .concerned).band == 0, "faded out over 0.5 s")
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
        s.begin(utterance: 2)
        for i in 0...60 { let t = 5 + Double(i) / 30; #expect(s.step(at: t, audioMs: Double(i) / 30 * 1000, openness: 0.2, available: all).isEmpty, "t=\(t)") }

        var late = ExpressionStills()
        late.begin(utterance: 4)
        for i in 0...30 { _ = late.step(at: Double(i) / 30, audioMs: Double(i) / 30 * 1000, openness: 0.2, available: all) }
        late.add(FaceExpressionEvent(tag: "smile", intensity: 0.7, startMs: 200, endMs: 900), utterance: 4)   // after the audio
        var face = 0.0
        for i in 31...60 { face = max(face, late.step(at: Double(i) / 30, audioMs: nil, openness: 0, available: all)[.smile]?.face ?? 0) }
        #expect(face > 0.8, "the after-reply smile still shows")

        var gone = ExpressionStills()
        gone.add(FaceExpressionEvent(tag: "smile", intensity: 0.7, startMs: 0, endMs: 500), utterance: 1)
        gone.add(FaceExpressionEvent(tag: "concerned", intensity: 0.6, startMs: 1500, endMs: 2000), utterance: 1)
        let f = (0...90).map { i in gone.step(at: Double(i) / 30, audioMs: Double(i) / 30 * 1000, openness: 0.2, available: [.neutral, .smile, .warm]) }
        #expect((f[36][.smile]?.band ?? 0) > 0.45)
        #expect(f.last!.isEmpty, "no still for concerned: the smile ends")
    }

    @Test func cancelRelaxesSmoothly() {
        var s = ExpressionStills()
        s.add(FaceExpressionEvent(tag: "surprised", intensity: 0.85, startMs: 0, endMs: 5000), utterance: 1)
        _ = run(&s, seconds: 1.2)
        s.cancel()
        let a = s.step(at: 1.2 + 1.0 / 30, audioMs: nil, openness: 0, available: all)[.surprised]?.band ?? 0
        #expect(a > 0.3, "no snap")
        let b = (1...30).map { s.step(at: 1.2 + Double($0) / 30 + 1.0 / 30, audioMs: nil, openness: 0, available: all) }.last![.surprised]?.band ?? 0
        #expect(b == 0)
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

    /// During an active event the still shows (surprise: in the brows); outside the face nothing changes.
    @Test func anActiveEventShowsTheStillInTheEyes() throws {
        let size = CGSize(width: 180, height: 320)
        let a = FaceRenderer(faceSet: dogSet, outputSize: size, seed: 5, reduceMotion: true)
        let b = FaceRenderer(faceSet: dogSet, outputSize: size, seed: 5, reduceMotion: true)
        b.addExpression(FaceExpressionEvent(tag: "surprised", intensity: 0.85, startMs: 0, endMs: 3000), utteranceId: 1)
        let tl = LipTimeline()
        var x: [UInt8] = [], y: [UInt8] = []
        for t in stride(from: 0.0, through: 1.4, by: 1.0 / 30) {
            let ctx = LipContext(audioMs: t * 1000, timeline: tl)
            x = px(a.render(at: t, lip: .rest, lipContext: ctx)); y = px(b.render(at: t, lip: .rest, lipContext: ctx))
        }
        #expect((b.expressionStillWeights[.surprised] ?? 0) > 0.3)
        // surprise shows in the brows (face box 25–59 % of the height; brows just above the eyes)
        let brows = bandDiff(x, y, w: 180, y0: Int(0.26 * 320), y1: Int(0.36 * 320))
        let top = bandDiff(x, y, w: 180, y0: 0, y1: Int(0.12 * 320))
        #expect(brows > 0.5, "brow band \(brows)")
        #expect(top < 0.5, "background above the head \(top)")
    }
}
