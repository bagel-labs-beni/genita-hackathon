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
        #expect(rowDiff(mouthY - 10, mouthY + 20) > 1)    // mouth + jaw changed
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

/// v2 mouth quality: one mouth at a time, and no shading band where the patch meets the skin.
struct MouthQualityTests {
    private let size = CGSize(width: 180, height: 320)

    @Test func midCrossfadeShowsOneMouthNotTwo() {
        #expect(animalSet.patches[.A] != nil && animalSet.patches[.O] != nil)
        let r = FaceRenderer(faceSet: animalSet, outputSize: size, reduceMotion: true)
        r.useRig = false   // the key-patch path
        let mixed = bytes(r.render(at: 1, lip: LipFrame(weights: [.A: 0.55, .O: 0.45], openness: 0.9)))
        let pureA = bytes(r.render(at: 1, lip: LipFrame(weights: [.A: 1], openness: 0.9)))
        #expect(meanDiff(mixed, pureA) < 0.001)
    }

    @Test func anOpenVowelWithoutSoundIsTheRestMouth() {
        let r = FaceRenderer(faceSet: animalSet, outputSize: size, reduceMotion: true)
        r.useRig = false   // the key-patch path
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

    @Test func speechOnsetsNodTheHead() {
        let size = CGSize(width: 540, height: 960)
        let quiet = FaceRenderer(faceSet: animalSet, outputSize: size, seed: 3)
        let talk = FaceRenderer(faceSet: animalSet, outputSize: size, seed: 3)
        let mouth = FaceRenderer.ciRect(animalSet.mouthBox, height: animalSet.pixelSize.height)
        let p0 = CGPoint(x: mouth.midX, y: mouth.midY)
        var maxDiff: CGFloat = 0
        for i in 0..<100 {
            let t = Double(i) / 25
            let open = (i % 12) < 4 ? 0.9 : 0.05      // a syllable every ~0.5 s
            let q = quiet.motionTransforms(at: t, open: 0).head, s = talk.motionTransforms(at: t, open: open).head
            maxDiff = max(maxDiff, abs(p0.applying(q).y - p0.applying(s).y) * size.width / animalSet.pixelSize.width)
        }
        print(String(format: "nod: max %.2f px", maxDiff))
        #expect(maxDiff > 1)
        #expect(maxDiff < 4)
    }

    // MARK: lower-face rig (v4)

    @Test func rigParamsBlendContinuouslyAcrossShapes() {
        let ee = MouthRigParams(lip: LipFrame(weights: [.EI: 1], openness: 0.5))
        let oo = MouthRigParams(lip: LipFrame(weights: [.O: 1], openness: 0.5))
        let mid = MouthRigParams(lip: LipFrame(weights: [.EI: 0.5, .O: 0.5], openness: 0.5))
        #expect(mid.spread < ee.spread && mid.spread > oo.spread)
        #expect(MouthRigParams(lip: LipFrame(weights: [.MBP: 1], openness: 0.8)).jaw == 0)
        #expect(MouthRigParams(lip: LipFrame(weights: [.MBP: 1], openness: 0.8)).press == 1)
    }

    @Test func rigAtRestLeavesThePhotoAsIs() {
        let size = CGSize(width: 180, height: 320)
        let rig = FaceRenderer(faceSet: animalSet, outputSize: size, reduceMotion: true)
        let plain = FaceRenderer(faceSet: animalSet, outputSize: size, reduceMotion: true)
        plain.useRig = false
        #expect(rig.rig != nil)
        let d = meanDiff(bytes(rig.render(at: 1, lip: .rest)), bytes(plain.render(at: 1, lip: .rest)))
        print(String(format: "rig at rest vs photo: %.3f", d))
        #expect(d < 0.6)
    }

    /// The jaw opens smoothly frame by frame (no swap spikes) and drags the chin down.
    @Test func rigOpensSmoothlyAndMovesTheChin() {
        let size = CGSize(width: 180, height: 320)
        let r = FaceRenderer(faceSet: animalSet, outputSize: size, reduceMotion: true)
        let w = Int(size.width)
        let face = animalSet.faceBox, k = size.height / animalSet.pixelSize.height
        let y0 = Int(animalSet.mouthBox.minY * k) - 4, y1 = min(Int(size.height), Int((face.maxY + face.height * 0.15) * k))
        var frames: [[UInt8]] = []
        for i in 0..<20 {
            let lip = LipFrame(weights: [.A: 0.5, .EI: 0.5 - Float(i) * 0.02, .O: Float(i) * 0.02], openness: Float(i) / 19)
            frames.append(bytes(r.render(at: 1 + Double(i) / 25, lip: lip)))
        }
        func delta(_ a: [UInt8], _ b: [UInt8]) -> Double {
            var s = 0.0, n = 0.0
            for y in y0..<y1 { for x in 0..<w { for c in 0..<3 { let i = (y * w + x) * 4 + c; s += abs(Double(a[i]) - Double(b[i])); n += 1 } } }
            return s / n
        }
        let deltas = (1..<frames.count).map { delta(frames[$0 - 1], frames[$0]) }
        let sorted = deltas.sorted(), median = sorted[sorted.count / 2]
        print(String(format: "rig continuity: median %.3f max %.3f", median, sorted.last!))
        #expect(sorted.last! < max(4 * median, 0.5))
        // chin rows change between closed and open
        let chinY = Int(face.maxY * k)
        var chin = 0.0, n = 0.0
        for y in max(0, chinY - 6)..<min(Int(size.height), chinY + 6) { for x in 0..<w { for c in 0..<3 { let i = (y * w + x) * 4 + c; chin += abs(Double(frames[0][i]) - Double(frames[19][i])); n += 1 } } }
        print(String(format: "chin change closed→open: %.2f", chin / n))
        #expect(chin / n > 1)
    }
}

