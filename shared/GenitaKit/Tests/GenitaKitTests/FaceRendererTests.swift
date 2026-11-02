import CoreGraphics
import Foundation
import Testing
@testable import GenitaKit

private let fixture = Bundle.module.url(forResource: "face-animal", withExtension: nil, subdirectory: "Fixtures")!

/// Loaded once: the analysis is the slow part.
private let animalSet: FaceSet = try! FaceSet(directory: fixture)

private func bytes(_ image: CGImage?) -> [UInt8] {
    guard let image, let data = image.dataProvider?.data else { return [] }
    return [UInt8](data as Data)
}

private func meanDiff(_ a: [UInt8], _ b: [UInt8]) -> Double {
    guard a.count == b.count, !a.isEmpty else { return .infinity }
    var s = 0.0
    for i in 0..<a.count { s += abs(Double(a[i]) - Double(b[i])) }
    return s / Double(a.count)
}

private let openA = LipFrame(weights: [.A: 1], openness: 0.9)

struct FaceSetTests {
    @Test func fallbackTableFindsTheNearestShapeOrRest() {
        let r = FaceSet.resolve(available: [.A, .MBP])
        #expect(r[.O]! == .A)
        #expect(r[.EI]! == .A)
        #expect(r[.FV]! == .MBP)
        #expect(r[.TH]! == nil)
        #expect(r[.WQ]! == nil)
        #expect(r[.rest]! == nil)
        let full = FaceSet.resolve(available: Set(LipViseme.shapes))
        for v in LipViseme.shapes { #expect(full[v]! == v) }
        #expect(FaceSet.resolve(available: [.L, .U])[.TH]! == .L)
        #expect(FaceSet.resolve(available: [.L, .U])[.WQ]! == .U)
    }

    @Test func emotionsPickTheBaseFace() {
        #expect(FaceExpression(emotion: "laugh") == .smile)
        #expect(FaceExpression(emotion: "Happy") == .smile)
        #expect(FaceExpression(emotion: "joy") == .smile)
        #expect(FaceExpression(emotion: "affection") == .warm)
        #expect(FaceExpression(emotion: "tender") == .warm)
        #expect(FaceExpression(emotion: "sad") == .neutral)
        #expect(FaceExpression(emotion: nil) == .neutral)
    }

    @Test func loadsTheFixtureWithPatchesAlignedAroundTheirOwnMouth() throws {
        let set = animalSet
        print("face-animal notes:", set.notes)
        #expect(set.pixelSize == CGSize(width: 512, height: 910))
        #expect(Set(set.expressions.keys) == Set(FaceExpression.allCases))
        #expect(set.patches.count >= 8)
        for (v, p) in set.patches {
            #expect(abs(p.shift.dx) <= 16 && abs(p.shift.dy) <= 16, "\(v) shift \(p.shift)")
            #expect(p.surroundDiff <= FaceSet.maxSurroundDiff)
            #expect(set.mouthBox.intersects(p.rect))
        }
        // The dog's A opens far wider than its resting mouth: its patch follows its own box.
        if let a = set.patches[.A], let mbp = set.patches[.MBP] {
            #expect(a.rect.height > mbp.rect.height * 1.5)
        }
    }

    @Test func missingExpressionsFallBackToNeutral() throws {
        var manifest = try JSONDecoder().decode(FaceManifest.self, from: Data(contentsOf: fixture.appendingPathComponent("manifest.json")))
        manifest.images["smile"] = nil
        manifest.images["blink"] = nil
        manifest.visemes["WQ"] = nil
        let set = try FaceSet(manifest: manifest) { try Data(contentsOf: fixture.appendingPathComponent($0)) }
        #expect(set.expressions[.smile] == nil)
        #expect(set.image(for: .smile) === set.image(for: .neutral))
        #expect(set.hasBlink == false)
        #expect(set.resolved[.WQ]! == .U)
        let r = FaceRenderer(faceSet: set, outputSize: CGSize(width: 90, height: 160))
        r.setEmotion("happy", at: 0)
        #expect(r.expressionWeights(at: 1) == [.neutral: 1])
        #expect(r.blinkAmount(at: 3) == 0)
    }

    @Test func boxesOutsideTheImageDoNotCrash() throws {
        var manifest = try JSONDecoder().decode(FaceManifest.self, from: Data(contentsOf: fixture.appendingPathComponent("manifest.json")))
        manifest.mouthBox = [1.1, 0.55, 1.2, 0.6]
        manifest.boxes = ["A": .init(face: nil, mouth: [.nan, 0.5, 2, 0.6])]
        let set = try FaceSet(manifest: manifest) { try Data(contentsOf: fixture.appendingPathComponent($0)) }
        for p in set.patches.values {
            #expect(CGRect(origin: .zero, size: set.pixelSize).contains(p.rect))
        }
    }

    @Test func aManifestWithoutNeutralIsRejected() {
        let m = FaceManifest(version: 1, size: nil, faceBox: [0, 0, 1, 1], mouthBox: [0.4, 0.5, 0.6, 0.6], images: [:], visemes: [:], boxes: nil, rejected: nil)
        #expect(throws: FaceSetError.missingNeutral) { try FaceSet(manifest: m) { _ in Data() } }
    }
}

struct FaceRendererTests {
    let size = CGSize(width: 180, height: 320)

    @Test func sameSeedSameCallsSamePixels() {
        let a = FaceRenderer(faceSet: animalSet, outputSize: size, seed: 7)
        let b = FaceRenderer(faceSet: animalSet, outputSize: size, seed: 7)
        a.setEmotion("happy", at: 0.4); b.setEmotion("happy", at: 0.4)
        for t in [0.5, 1.7, 3.3] {
            let x = bytes(a.render(at: t, lip: openA)), y = bytes(b.render(at: t, lip: openA))
            #expect(!x.isEmpty)
            #expect(x == y, "t=\(t)")
        }
    }

    @Test func blinksComeEveryTwoToSixSecondsAndDependOnTheSeed() {
        func onsets(_ seed: UInt64) -> [Double] {
            let r = FaceRenderer(faceSet: animalSet, outputSize: size, seed: seed)
            var out: [Double] = []
            var was = false
            for i in 0..<3000 {
                let t = Double(i) / 100
                let on = r.blinkAmount(at: t) > 0.5
                if on && !was { out.append(t) }
                was = on
            }
            return out
        }
        let o = onsets(3)
        #expect(o.count >= 4)
        for (x, y) in zip(o, o.dropFirst()) { #expect(y - x >= 1.95 && y - x <= 6.1, "gap \(y - x)") }
        #expect(onsets(3) == o)
        #expect(onsets(4) != o)
    }

    @Test func reduceMotionHoldsStillButTheMouthMoves() {
        let r = FaceRenderer(faceSet: animalSet, outputSize: size, seed: 1, reduceMotion: true)
        for i in 0..<600 { #expect(r.blinkAmount(at: Double(i) / 20) == 0) }
        let still1 = bytes(r.render(at: 1.3, lip: .rest)), still2 = bytes(r.render(at: 2.9, lip: .rest))
        #expect(still1 == still2)
        #expect(meanDiff(still1, bytes(r.render(at: 2.9, lip: openA))) > 0.05)

        let moving = FaceRenderer(faceSet: animalSet, outputSize: size, seed: 1)
        #expect(bytes(moving.render(at: 1.3, lip: .rest)) != bytes(moving.render(at: 2.9, lip: .rest)))
    }

    @Test func openVisemeChangesOnlyTheLowerFace() throws {
        let r = FaceRenderer(faceSet: animalSet, outputSize: size, reduceMotion: true)
        let rest = bytes(r.render(at: 1, lip: .rest)), open = bytes(r.render(at: 1, lip: openA))
        let w = Int(size.width), h = Int(size.height)
        func rowDiff(_ y0: Int, _ y1: Int) -> Double {
            var s = 0.0, n = 0.0
            for y in y0..<y1 { for x in 0..<w { for c in 0..<3 { let i = (y * w + x) * 4 + c; s += abs(Double(rest[i]) - Double(open[i])); n += 1 } } }
            return s / n
        }
        let mouthY = Int(animalSet.mouthBox.midY / animalSet.pixelSize.height * Double(h))
        #expect(rowDiff(0, h / 5) < 0.2)                  // top of the frame untouched
        #expect(rowDiff(mouthY - 10, mouthY + 20) > 2)    // mouth + jaw changed
    }

    @Test func expressionCrossfadesOverAQuarterSecond() {
        let r = FaceRenderer(faceSet: animalSet, outputSize: size)
        r.setEmotion("joy", at: 1)
        let mid = r.expressionWeights(at: 1.125)
        #expect((mid[.neutral] ?? 0) > 0.2 && (mid[.smile] ?? 0) > 0.2)
        #expect(r.expressionWeights(at: 1.3) == [.smile: 1])
        r.setEmotion("tender", at: 2)
        #expect(r.expressionWeights(at: 2.5) == [.warm: 1])
    }

    @Test func aNewExpressionMidFadeStartsFromTheCurrentMix() {
        let r = FaceRenderer(faceSet: animalSet, outputSize: size)
        r.setEmotion("happy", at: 1)
        let before = r.expressionWeights(at: 1.125)
        r.setEmotion("warm", at: 1.125)
        let after = r.expressionWeights(at: 1.125)
        #expect(abs((after[.neutral] ?? 0) - (before[.neutral] ?? 0)) < 1e-6)
        #expect(abs((after[.smile] ?? 0) - (before[.smile] ?? 0)) < 1e-6)
        #expect(abs(after.values.reduce(0, +) - 1) < 1e-6)
        #expect(r.expressionWeights(at: 1.4) == [.warm: 1])
    }

    @Test func throughputAt540x960() {
        let r = FaceRenderer(faceSet: animalSet, outputSize: CGSize(width: 540, height: 960), seed: 2)
        let tl = LipTimeline()
        tl.appendPCM(lipTestPCM(amplitude: 0.4, ms: 2000), offsetMs: 0)
        tl.appendText("a moment of the warm afternoon light")
        tl.finishAudio()
        _ = r.render(at: 0, lip: .rest) // warm-up
        let n = 50
        let start = Date()
        for i in 0..<n {
            let t = Double(i) / 25
            #expect(r.render(at: t, lip: tl.sample(atMs: t * 1000)) != nil)
        }
        let fps = Double(n) / Date().timeIntervalSince(start)
        print(String(format: "FaceRenderer 540x960: %.1f fps over %d frames", fps, n))
        #expect(fps > 2)
    }
}

@MainActor
struct FaceDriverTests {
    private func event(_ json: String) throws -> ServerEvent {
        try JSONDecoder().decode(ServerEvent.self, from: Data(json.utf8))
    }

    @Test func serverEventsMoveTheMouthAndCancelRestsIt() throws {
        let d = FaceDriver(faceSet: animalSet, outputSize: CGSize(width: 90, height: 160), reduceMotion: true, seed: 5)
        guard case let .replyDelta(delta) = try event(#"{"type":"reply.delta","utteranceId":9,"text":"wow ah"}"#),
              case let .audio(audio) = try event(#"{"type":"audio","utteranceId":9,"seq":1,"sentence":0,"offsetMs":0,"durationMs":600,"sampleRate":24000,"model":"m","words":[]}"#)
        else { Issue.record("decode"); return }
        d.handle(replyDelta: delta)
        d.handle(audio: audio, pcm: lipTestPCM(amplitude: 0.4, ms: 600))
        #expect(d.currentUtteranceId == 9)
        let rest = bytes(d.renderFrame(at: 1, playbackMs: nil))
        let talking = bytes(d.renderFrame(at: 1, playbackMs: 300))
        #expect(meanDiff(rest, talking) > 0.05)
        d.cancel(utteranceId: 8)               // another utterance: ignored
        #expect(d.currentUtteranceId == 9)
        d.cancel(utteranceId: 9)
        #expect(d.currentUtteranceId == nil)
        #expect(meanDiff(bytes(d.renderFrame(at: 1, playbackMs: 300)), rest) == 0)
    }

    @Test func lateEventsOfAnOldOrCancelledUtteranceAreIgnored() throws {
        let d = FaceDriver(faceSet: animalSet, outputSize: CGSize(width: 90, height: 160), reduceMotion: true, seed: 5)
        func audio(_ id: Int) throws -> ServerEvent.Audio {
            guard case let .audio(a) = try event(#"{"type":"audio","utteranceId":\#(id),"seq":1,"sentence":0,"offsetMs":0,"durationMs":600,"sampleRate":24000,"model":"m","words":[]}"#) else { throw CocoaError(.coderReadCorrupt) }
            return a
        }
        d.handle(audio: try audio(9), pcm: lipTestPCM(amplitude: 0.4, ms: 600))
        d.cancel(utteranceId: 9)
        d.handle(audio: try audio(9), pcm: lipTestPCM(amplitude: 0.4, ms: 600))   // late chunk of the cancelled reply
        #expect(d.currentUtteranceId == nil)
        #expect(d.timeline.receivedAudioEndMs == 0)
        d.handle(audio: try audio(10), pcm: lipTestPCM(amplitude: 0.4, ms: 600))
        d.handle(audio: try audio(9), pcm: lipTestPCM(amplitude: 0.4, ms: 900))   // older reply
        #expect(d.currentUtteranceId == 10)
        #expect(d.timeline.receivedAudioEndMs == 600)
    }
}
