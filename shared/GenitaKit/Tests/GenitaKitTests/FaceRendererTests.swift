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

    @Test func alignerTimingsReachTheMouth() throws {
        let driver = FaceDriver(faceSet: animalSet, outputSize: CGSize(width: 90, height: 160), seed: 1)
        func audio(_ id: Int) throws -> ServerEvent.Audio {
            guard case let .audio(a) = try event(#"{"type":"audio","utteranceId":\#(id),"seq":1,"sentence":0,"offsetMs":0,"durationMs":600,"sampleRate":24000,"model":"m","words":[]}"#) else { throw CocoaError(.coderReadCorrupt) }
            return a
        }
        driver.handle(audio: try audio(4), pcm: lipTestPCM(amplitude: 0.4, ms: 600))
        driver.handle(timing: 4, words: [LipWordTiming(text: "ma", startMs: 0, endMs: 600)],
                      phonemes: [LipPhonemeTiming(phoneme: "M", startMs: 0, endMs: 300), LipPhonemeTiming(phoneme: "AA", startMs: 300, endMs: 600)])
        #expect((driver.timeline.sample(atMs: 150).weights[.MBP] ?? 0) > 0.9)
        driver.handle(timing: 3, words: [], phonemes: [LipPhonemeTiming(phoneme: "OW", startMs: 0, endMs: 600)])   // late, older
        #expect((driver.timeline.sample(atMs: 150).weights[.MBP] ?? 0) > 0.9)
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

/// v2 mouth quality: one mouth at a time, and no shading band where the patch meets the skin.
struct MouthQualityTests {
    private let size = CGSize(width: 180, height: 320)

    @Test func midCrossfadeShowsOneMouthNotTwo() {
        #expect(animalSet.patches[.A] != nil && animalSet.patches[.O] != nil)
        let r = FaceRenderer(faceSet: animalSet, outputSize: size, reduceMotion: true)
        let mixed = bytes(r.render(at: 1, lip: LipFrame(weights: [.A: 0.55, .O: 0.45], openness: 0.9)))
        let pureA = bytes(r.render(at: 1, lip: LipFrame(weights: [.A: 1], openness: 0.9)))
        #expect(meanDiff(mixed, pureA) < 0.001)
    }

    @Test func anOpenVowelWithoutSoundIsTheRestMouth() {
        let r = FaceRenderer(faceSet: animalSet, outputSize: size, reduceMotion: true)
        let quiet = bytes(r.render(at: 1, lip: LipFrame(weights: [.A: 1], openness: 0.01)))
        let rest = bytes(r.render(at: 1, lip: LipFrame(weights: [.rest: 1], openness: 0.01)))
        #expect(meanDiff(quiet, rest) < 0.001)
    }

    /// A Muse edit that also darkened the skin just above the lip (seen on the human set as a grey
    /// band) must not carry that shading onto the base face.
    @Test func localShadingAboveTheLipIsCorrected() throws {
        let w = 200, h = 200
        func image(_ paint: (Int, Int) -> (UInt8, UInt8, UInt8)) -> PixelBuffer {
            var d = [UInt8](repeating: 255, count: w * h * 4)
            for y in 0..<h { for x in 0..<w { let p = paint(x, y); let i = (y * w + x) * 4; d[i] = p.0; d[i + 1] = p.1; d[i + 2] = p.2 } }
            return PixelBuffer(PixelBuffer.makeImage(d, width: w, height: h), width: w, height: h)
        }
        let skin: (UInt8, UInt8, UInt8) = (200, 160, 140)
        let base = image { x, y in (80..<120).contains(x) && (120..<135).contains(y) ? (180, 90, 90) : skin }
        let band = { (x: Int, y: Int) in (70..<130).contains(x) && (100..<118).contains(y) }
        let vis = image { x, y in
            if (85..<115).contains(x) && (118..<140).contains(y) { return (60, 30, 30) }
            if band(x, y) { return (170, 130, 110) }
            return skin
        }
        let mouth = CGRect(x: 80, y: 120, width: 40, height: 15), own = CGRect(x: 85, y: 118, width: 30, height: 22)
        let patch = try #require(FaceSet.makePatch(base: base, baseGray: base.analysis(), viseme: vis, ownMouth: own, mouth: mouth, cover: mouth, face: CGRect(x: 40, y: 40, width: 120, height: 140)))
        let p = PixelBuffer(patch.image, width: patch.image.width, height: patch.image.height)
        let ox = Int(patch.rect.minX), oy = Int(patch.rect.minY)
        func composited(_ x: Int, _ y: Int, _ c: Int) -> Double {
            let px = x - ox, py = y - oy
            guard p.contains(px, py) else { return Double(base.at(x, y, c)) }
            let a = Double(p.at(px, py, 3)) / 255
            return Double(p.at(px, py, c)) + Double(base.at(x, y, c)) * (1 - a)
        }
        var s = 0.0, n = 0.0
        for y in 100..<118 { for x in 70..<130 { for c in 0..<3 { s += abs(composited(x, y, c) - Double(base.at(x, y, c))); n += 1 } } }
        let bandDiff = s / n
        print(String(format: "band diff after patch: %.2f / 255", bandDiff))
        #expect(bandDiff < 4.5)   // global colour match alone: 7.55 (hard-edged band; real shading is smoother)
        // the new mouth itself stays dark (the correction is shading, not content)
        var m = 0.0, mn = 0.0
        for y in 124..<136 { for x in 92..<108 { m += composited(x, y, 0); mn += 1 } }
        #expect(m / mn < 100)
    }

    /// Teeth in an edit whose skin came out warmer than the base stay white (no hue shift).
    @Test func contentKeepsItsHue() throws {
        let w = 200, h = 200
        func image(_ paint: (Int, Int) -> (UInt8, UInt8, UInt8)) -> PixelBuffer {
            var d = [UInt8](repeating: 255, count: w * h * 4)
            for y in 0..<h { for x in 0..<w { let p = paint(x, y); let i = (y * w + x) * 4; d[i] = p.0; d[i + 1] = p.1; d[i + 2] = p.2 } }
            return PixelBuffer(PixelBuffer.makeImage(d, width: w, height: h), width: w, height: h)
        }
        let base = image { x, y in (80..<120).contains(x) && (120..<135).contains(y) ? (180, 90, 90) : (200, 160, 140) }
        let vis = image { x, y in (88..<112).contains(x) && (122..<132).contains(y) ? (235, 235, 235) : (225, 160, 140) }
        let mouth = CGRect(x: 80, y: 120, width: 40, height: 15)
        let patch = try #require(FaceSet.makePatch(base: base, baseGray: base.analysis(), viseme: vis, ownMouth: mouth, mouth: mouth, cover: mouth, face: CGRect(x: 40, y: 40, width: 120, height: 140)))
        let p = PixelBuffer(patch.image, width: patch.image.width, height: patch.image.height)
        let px = 100 - Int(patch.rect.minX), py = 127 - Int(patch.rect.minY)
        let a = Double(p.at(px, py, 3)) / 255
        let r = Double(p.at(px, py, 0)) / a, g = Double(p.at(px, py, 1)) / a, b = Double(p.at(px, py, 2)) / a
        print(String(format: "tooth after patch: %.0f %.0f %.0f", r, g, b))
        #expect(abs(r - g) < 3 && abs(g - b) < 3)
    }

    // MARK: alive base (⑦)

    private func faceCI(_ set: FaceSet) -> CGRect { FaceRenderer.ciRect(set.faceBox, height: set.pixelSize.height) }

    @Test func theMouthSitsInsideTheSolidPartOfTheHeadLayer() {
        let face = faceCI(animalSet)
        let mouth = FaceRenderer.ciRect(animalSet.mouthBox, height: animalSet.pixelSize.height)
        let e = FaceRenderer.headEllipse(face: face)
        for p in [CGPoint(x: mouth.midX, y: mouth.midY), CGPoint(x: mouth.minX, y: mouth.minY), CGPoint(x: mouth.maxX, y: mouth.minY)] {
            let nx = (p.x - e.center.x) / e.rx, ny = (p.y - e.center.y) / e.ry
            #expect((nx * nx + ny * ny).squareRoot() < FaceRenderer.headMaskInner)
        }
    }

    @Test func aliveMotionIsSmallSmoothAndSeeded() {
        let out: CGFloat = 540
        let r = FaceRenderer(faceSet: animalSet, outputSize: CGSize(width: out, height: 960), seed: 7)
        let k = out / animalSet.pixelSize.width * AliveMotion.overscan   // still px → output px
        let mouth = FaceRenderer.ciRect(animalSet.mouthBox, height: animalSet.pixelSize.height)
        let p0 = CGPoint(x: mouth.midX, y: mouth.midY)
        var prev: CGPoint?
        var maxStep: CGFloat = 0, maxOff: CGFloat = 0, maxRoll = 0.0
        var moved = false
        for i in 0..<1500 {   // 60 s at 25 fps, silent
            let m = r.motionTransforms(at: Double(i) / 25, open: 0)
            let p = p0.applying(m.head.concatenating(m.camera))
            let off = hypot(p.x - p0.x, p.y - p0.y) * k
            maxOff = max(maxOff, off)
            if off > 1 { moved = true }
            if let q = prev { maxStep = max(maxStep, hypot(p.x - q.x, p.y - q.y) * k) }
            prev = p
            maxRoll = max(maxRoll, abs(atan2(Double(m.head.b), Double(m.head.a))) * 180 / .pi)
        }
        print(String(format: "alive: mouth max offset %.2f px, max step %.3f px/frame, head roll max %.2f°", maxOff, maxStep, maxRoll))
        #expect(moved)
        #expect(maxOff < 9)
        #expect(maxStep < 0.6)
        #expect(maxRoll < 2.0)
        let a = FaceRenderer(faceSet: animalSet, outputSize: CGSize(width: out, height: 960), seed: 7).motionTransforms(at: 4.2, open: 0)
        let b = FaceRenderer(faceSet: animalSet, outputSize: CGSize(width: out, height: 960), seed: 8).motionTransforms(at: 4.2, open: 0)
        #expect(a.head != b.head)
    }

    /// 11/3 pm (Chelsea: "the background is locked but the person bobs up and down"): by default the
    /// person layer never moves vertically — no speech nod, no vertical drift, no breathing.
    @Test func thePersonNeverBobsVerticallyByDefault() {
        let size = CGSize(width: 540, height: 960)
        let talk = FaceRenderer(faceSet: animalSet, outputSize: size, seed: 3)
        let face = faceCI(animalSet)
        let eyes = CGPoint(x: face.midX, y: face.maxY - face.height * 0.3)   // on the roll axis: any vertical move is a bob
        let k = size.width / animalSet.pixelSize.width
        var lo = CGFloat.infinity, hi = -CGFloat.infinity
        for i in 0..<250 {
            let t = Double(i) / 25
            let open = (i % 12) < 4 ? 0.9 : 0.05      // a syllable every ~0.5 s
            let m = talk.motionTransforms(at: t, open: open)
            let y = eyes.applying(m.head.concatenating(m.camera)).y * k
            lo = min(lo, y); hi = max(hi, y)
        }
        print(String(format: "vertical: eyes p2p %.2f px", hi - lo))
        // 11/4: the rigid speech sway may move the whole head up to ±1.5 px (was ~16 px on T9 with nod + drift + breathing)
        #expect(hi - lo <= 3.2)
    }

    /// 11/4 ("the face is frozen"): the head moves as one rigid piece with the speech, within ±1.5 px, ±0.6°, ±0.4 %;
    /// map alive.sway 0 brings back the still head.
    @Test func theRigidSpeechSwayStaysWithinItsCaps() {
        let face = faceCI(animalSet), extent = CGRect(origin: .zero, size: CGSize(width: animalSet.pixelSize.width, height: animalSet.pixelSize.height))
        let out: CGFloat = 540, k = out / animalSet.pixelSize.width
        var on = AliveMotion(seed: 4), off = AliveMotion(seed: 4)
        for m in [0, 1] { (m == 0 ? { on.headGain = 0; on.rollGain = 0; on.nodGain = 0 } : { off.headGain = 0; off.rollGain = 0; off.nodGain = 0; off.swayGain = 0 })() }
        let p0 = CGPoint(x: face.midX, y: face.midY)
        var maxD: CGFloat = 0, maxDeg = 0.0, maxScale = 0.0, moved = false, offMax: CGFloat = 0
        for i in 0..<500 {
            let t = Double(i) / 25
            let open = (i / 100) % 2 == 0 ? ((i % 12) < 4 ? 0.9 : 0.1) : 0.0   // 4 s talk, 4 s quiet
            let a = on.transforms(at: t, open: open, face: face, extent: extent, outputWidth: out).head
            let b = off.transforms(at: t, open: open, face: face, extent: extent, outputWidth: out).head
            let pa = p0.applying(a), pb = p0.applying(b)
            maxD = max(maxD, max(abs(pa.x - p0.x), abs(pa.y - p0.y)) * k)
            offMax = max(offMax, hypot(pb.x - p0.x, pb.y - p0.y) * k)
            maxDeg = max(maxDeg, abs(atan2(Double(a.b), Double(a.a))) * 180 / .pi)
            maxScale = max(maxScale, abs((Double(a.a * a.a + a.b * a.b)).squareRoot() - 1))
            if hypot(pa.x - p0.x, pa.y - p0.y) * k > 0.3 { moved = true }
        }
        print(String(format: "sway: max %.2f px, %.2f deg, scale %.4f; off %.3f px", maxD, maxDeg, maxScale, offMax))
        #expect(moved)
        #expect(maxD <= 3.2)          // ±1.5 px translation plus the roll/scale about the neck at the face centre
        #expect(maxDeg <= AliveMotion.swayMaxDeg + 1e-6)
        #expect(maxScale <= AliveMotion.swayMaxScale + 1e-6)
        #expect(offMax < 0.05)
    }

    @Test func speechOnsetsNodTheHeadWhenTheVerticalLockIsOff() {
        var quiet = AliveMotion(seed: 3), talk = AliveMotion(seed: 3)
        quiet.lockVertical = false; talk.lockVertical = false
        let face = faceCI(animalSet), extent = CGRect(origin: .zero, size: CGSize(width: animalSet.pixelSize.width, height: animalSet.pixelSize.height))
        let p0 = CGPoint(x: face.midX, y: face.midY)
        var maxDiff: CGFloat = 0
        for i in 0..<100 {
            let t = Double(i) / 25
            let open = (i % 12) < 4 ? 0.9 : 0.05
            let q = quiet.transforms(at: t, open: 0, face: face, extent: extent, outputWidth: 540).head
            let s = talk.transforms(at: t, open: open, face: face, extent: extent, outputWidth: 540).head
            maxDiff = max(maxDiff, abs(p0.applying(q).y - p0.applying(s).y) * 540 / animalSet.pixelSize.width)
        }
        #expect(maxDiff > 1)
        #expect(maxDiff < 4)
    }
}

