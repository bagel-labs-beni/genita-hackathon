import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers
@testable import GenitaKit

/// A tiny synthetic face set with option-B flow data, built in memory.
private enum Synth {
    static let w = 64, h = 96
    static let roi = [0.25, 0.5, 0.75, 0.8]       // 32 × 29 px
    static let size = [32, 29], flowSize = [16, 15]

    static func png(_ w: Int, _ h: Int, _ paint: (Int, Int) -> (UInt8, UInt8, UInt8)) -> Data {
        var d = [UInt8](repeating: 255, count: w * h * 4)
        for y in 0..<h { for x in 0..<w { let p = paint(x, y); let i = (y * w + x) * 4; d[i] = p.0; d[i + 1] = p.1; d[i + 2] = p.2 } }
        let img = PixelBuffer.makeImage(d, width: w, height: h)
        let out = NSMutableData()
        let dest = CGImageDestinationCreateWithData(out, UTType.png.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(dest, img, nil)
        CGImageDestinationFinalize(dest)
        return out as Data
    }

    static func f16(_ count: Int, dx: Float, dy: Float) -> Data {
        // 1.0 = 0x3C00 etc. are exact; build halves for small integers.
        func half(_ v: Float) -> UInt16 {
            if v == 0 { return 0 }
            let bits = v.bitPattern
            let sign = UInt16((bits >> 16) & 0x8000)
            let exp = Int((bits >> 23) & 0xFF) - 127 + 15
            let man = UInt16((bits >> 13) & 0x3FF)
            return sign | UInt16(exp) << 10 | man
        }
        var d = Data()
        for i in 0..<count { let v = half(i % 2 == 0 ? dx : dy); d.append(UInt8(v & 0xFF)); d.append(UInt8(v >> 8)) }
        return d
    }

    /// Files by name; `breakKey` leaves one flow file out (load error → no flow).
    static func faceSet(keys: [String] = ["MBP", "MID", "AH", "AH2", "A"], breakKey: String? = nil, rig: Bool = false) throws -> FaceSet {
        var files: [String: Data] = [:]
        let skin: (UInt8, UInt8, UInt8) = (200, 160, 140)
        let isMouth = { (x: Int, y: Int) in (26..<38).contains(x) && (60..<63).contains(y) }
        files["neutral.png"] = png(w, h) { x, y in isMouth(x, y) ? (150, 70, 70) : (y < 30 ? (60, 40, 30) : skin) }
        let sw = size[0], sh = size[1]
        // ROI starts at (16, 48); the mask is 0 in the top 8 rows (lock) and inside an ellipse below.
        files["mask.png"] = png(sw, sh) { x, y in
            guard y >= 8 else { return (0, 0, 0) }
            let nx = (Double(x) - 15.5) / 15, ny = (Double(y) - 18) / 10
            return nx * nx + ny * ny < 1 ? (255, 255, 255) : (0, 0, 0)
        }
        var fm: [String: FaceFlowManifest.Files] = [:]
        for k in keys {
            let inside = { (x: Int, y: Int) in (10..<22).contains(x) && (12..<16).contains(y) }
            files["\(k).png"] = png(sw, sh) { x, y in
                if rig, k != "MBP", inside(x, y) { return (235, 235, 235) }     // rig: teeth inside the mouth
                return (8..<24).contains(x) && (11..<17).contains(y) ? (k == "MBP" ? (150, 70, 70) : (30, 10, 10)) : skin
            }
            files["\(k).nk"] = f16(Synth.flowSize[0] * Synth.flowSize[1] * 2, dx: 0, dy: k == "MBP" ? 0 : 1)
            files["\(k).kn"] = k == breakKey ? Data([1, 2, 3]) : f16(Synth.flowSize[0] * Synth.flowSize[1] * 2, dx: 0, dy: k == "MBP" ? 0 : -1)
            fm[k] = .init(key: "\(k).png", nk: "\(k).nk", kn: "\(k).kn")
            if rig, k != "MBP" {
                files["\(k).lip"] = png(sw, sh) { x, y in (8..<24).contains(x) && ((10..<12).contains(y) || (16..<18).contains(y)) ? (255, 255, 255) : (0, 0, 0) }
                files["\(k).int"] = png(sw, sh) { x, y in inside(x, y) ? (255, 255, 255) : (0, 0, 0) }
                fm[k]?.lip = "\(k).lip"; fm[k]?.interior = "\(k).int"
            }
        }
        var rigMap = FlowMap.standard
        rigMap.rig = FlowMap.Rig(); rigMap.rig?.lipTone = 0; rigMap.rig?.lipFlowPx = 0
        let flow = FaceFlowManifest(version: 1, roi: roi, size: size, flowSize: flowSize, keys: keys, files: fm, mask: "mask.png", neutralRoi: nil, lockY: 0.55, kind: "human", map: rig ? rigMap : nil)
        let manifest = FaceManifest(version: 1, size: [w, h], faceBox: [0.1, 0.25, 0.9, 0.85], mouthBox: [0.4, 0.62, 0.6, 0.66],
                                    images: ["neutral": "neutral.png"], visemes: [:], boxes: nil, rejected: nil, flow: flow)
        return try FaceSet(manifest: manifest) { ref in
            guard let d = files[ref] else { throw CocoaError(.fileNoSuchFile) }
            return d
        }
    }
}

private func pixels(_ image: CGImage?) -> [UInt8] {
    guard let image, let data = image.dataProvider?.data else { return [] }
    return [UInt8](data as Data)
}

struct FlowMorphTests {
    @Test func halfFloatsDecode() {
        #expect(FaceFlowData.halfToFloat(0x3C00) == 1)
        #expect(FaceFlowData.halfToFloat(0xC000) == -2)
        #expect(abs(FaceFlowData.halfToFloat(0x3555) - 0.33325) < 1e-4)
        #expect(FaceFlowData.halfToFloat(0x0000) == 0)
    }

    @Test func aFaceSetWithFlowsUsesTheMorphAndABrokenOneFallsBack() throws {
        #expect(try Synth.faceSet().flow != nil)
        let broken = try Synth.faceSet(breakKey: "AH")
        #expect(broken.flow == nil)
        #expect(broken.notes.contains { $0.hasPrefix("flow:") })
    }

    /// Nose lock: outside the mask (everything above the lock line) is the neutral still's own
    /// pixels on every frame, however open the mouth is.
    @Test func everythingAboveTheLockStaysNeutral() throws {
        let set = try Synth.faceSet()
        let size = CGSize(width: 64, height: 96)
        let r = FaceRenderer(faceSet: set, outputSize: size, reduceMotion: true)
        let rest = pixels(r.render(at: 1, lip: .rest))
        var maxDiff = 0
        for (i, open) in [Float(0.2), 0.6, 1].enumerated() {
            let p = pixels(r.render(at: 2 + Double(i) / 25, lip: LipFrame(weights: [.A: 1], openness: open)))
            for y in 0..<(48 + 8) { for x in 0..<64 { for c in 0..<3 { let k = (y * 64 + x) * 4 + c; maxDiff = max(maxDiff, abs(Int(p[k]) - Int(rest[k]))) } } }
        }
        #expect(maxDiff <= 1)
        // …while the mouth inside the mask did change
        let open = pixels(r.render(at: 3, lip: LipFrame(weights: [.A: 1], openness: 0.9)))
        let k = (63 * 64 + 32) * 4
        #expect(abs(Int(open[k]) - Int(rest[k])) > 20)
    }

    @Test func ladderFollowsLoudnessAndPeopleStopBeforeTheYawnKey() throws {
        let set = try Synth.faceSet()
        let m = FlowMorph(data: set.flow!, neutralStill: set.expressions[.neutral]!, scale: 1)
        let mid = m.amounts(LipFrame(weights: [.A: 1], openness: 0.3))
        #expect((mid["AH"] ?? 0) > 0 && (mid["AH2"] ?? 0) > 0 && mid["A"] == nil)
        let loud = m.amounts(LipFrame(weights: [.A: 1], openness: 1))
        #expect(loud["A"] == nil && (loud["AH2"] ?? 0) > 0.9)
        #expect(!set.flow!.map.ladder.steps.contains { $0.key == "A" })
        // Codex P2 check: a barely open A interpolates within the first segment only.
        let tiny = m.amounts(LipFrame(weights: [.A: 1], openness: 0.001))
        #expect((tiny["MID"] ?? 0) > 20 * (tiny["AH"] ?? 0))
    }

    @Test func amountsMoveAtMostASlewPerFrameButClosuresAreInstant() throws {
        let set = try Synth.faceSet()
        let m = FlowMorph(data: set.flow!, neutralStill: set.expressions[.neutral]!, scale: 1)
        let ah2 = set.flow!.keys.firstIndex(of: "AH2")!, mbp = set.flow!.keys.firstIndex(of: "MBP")!
        _ = m.step(.rest, at: 0)
        let first = m.step(LipFrame(weights: [.A: 1], openness: 1), at: 0.04)
        #expect(first[ah2] <= 0.25 + 1e-4)
        _ = m.step(.rest, at: 0.5)
        _ = m.step(.rest, at: 0.54)
        let closed = m.step(LipFrame(weights: [.MBP: 1], openness: 0.5), at: 0.58)
        #expect(closed[mbp] > 0.95)
    }

    @Test func aKeyAtFullAmountShowsThatKey() throws {
        let set = try Synth.faceSet(keys: ["MBP", "AH2"])
        let m = FlowMorph(data: set.flow!, neutralStill: set.expressions[.neutral]!, scale: 1)
        m.amountsOverride = [0, 1]
        let p = pixels(m.render(.rest, at: 1))
        let k = (14 * m.width + 16) * 4       // inside the key's dark mouth (shifted 1 px by its flow)
        #expect(p[k] < 60 && p[k + 3] == 255)
    }

    /// Through a non-closing consonant the jaw keeps most of the vowel; a closure still shuts.
    @Test func consonantsKeepTheVowelOpenButClosuresShut() throws {
        let set = try Synth.faceSet()
        let m = FlowMorph(data: set.flow!, neutralStill: set.expressions[.neutral]!, scale: 1)
        let keys = set.flow!.keys
        func open(_ a: [Float]) -> Float { ["MID", "AH", "AH2"].compactMap { keys.firstIndex(of: $0) }.map { a[$0] }.reduce(0, +) }
        var a: [Float] = []
        for i in 0..<6 { a = m.step(LipFrame(weights: [.A: 1], openness: 0.6), at: Double(i) / 25) }
        let vowel = open(a)
        a = m.step(LipFrame(weights: [.CDG: 1], openness: 0.6), at: 0.24)
        a = m.step(LipFrame(weights: [.CDG: 1], openness: 0.6), at: 0.28)
        #expect(open(a) > 0.45 * vowel)
        a = m.step(LipFrame(weights: [.MBP: 1], openness: 0.6), at: 0.32)
        #expect(a[keys.firstIndex(of: "MBP")!] > 0.95)
    }
}


struct FaceManifestFlowDecodingTests {
    @Test func anUnreadableFlowBlockKeepsTheFace() throws {
        let json = #"{"faceBox":[0.2,0.2,0.8,0.6],"mouthBox":[0.4,0.5,0.6,0.55],"images":{"neutral":"n"},"visemes":{},"flow":{"roi":"nope"}}"#
        let m = try JSONDecoder().decode(FaceManifest.self, from: Data(json.utf8))
        #expect(m.flow == nil && m.images["neutral"] == "n")
    }
}

struct FlowMorphResetTests {
    /// Codex P2: a key still shown by the snap hold after its amount dropped is painted, not black.
    @Test func aHeldKeyIsStillPainted() throws {
        let set = try Synth.faceSet(keys: ["MBP", "AH2", "MID"])
        let m = FlowMorph(data: set.flow!, neutralStill: set.expressions[.neutral]!, scale: 1)
        m.amountsOverride = [0, 1, 0]
        _ = m.render(.rest, at: 1)
        m.amountsOverride = [0, 0, 1]
        let p = [UInt8](m.render(.rest, at: 1.04).dataProvider!.data! as Data)
        let k = (20 * m.width + 4) * 4      // skin inside the mask, away from the mouth
        #expect(p[k + 3] > 200 && p[k] > 120)
    }

    /// Codex P2: cancel drops the smoothing tail at once.
    @Test func resetRestsTheMouthNow() throws {
        let set = try Synth.faceSet()
        let m = FlowMorph(data: set.flow!, neutralStill: set.expressions[.neutral]!, scale: 1)
        for i in 0..<5 { _ = m.step(LipFrame(weights: [.A: 1], openness: 0.8), at: Double(i) / 25) }
        m.reset()
        let a = m.step(.rest, at: 0.2)
        #expect(a.allSatisfy { $0 < 1e-6 })
    }
}

struct FlowMorphFixtureTests {
    /// A real prep export (animal, open-jaw profile): loads with flows and renders at speed.
    @Test func realExportLoadsAndRendersFast() throws {
        let dir = Bundle.module.url(forResource: "face-flow-animal", withExtension: nil, subdirectory: "Fixtures")!
        let set = try FaceSet(directory: dir)
        #expect(set.flow != nil)
        #expect(set.flow?.map.drive == "open")
        let r = FaceRenderer(faceSet: set, outputSize: CGSize(width: 540, height: 960), seed: 2)
        let tl = LipTimeline()
        tl.appendPCM(lipTestPCM(amplitude: 0.4, ms: 3000), offsetMs: 0)
        tl.appendText("a moment of the warm afternoon light")
        tl.finishAudio()
        _ = r.render(at: 0, lip: .rest)
        let n = 60
        let start = Date()
        for i in 0..<n {
            let t = Double(i) / 25
            #expect(r.render(at: t, lip: tl.sample(atMs: t * 1000 + r.lipLookaheadMs)) != nil)
        }
        let fps = Double(n) / Date().timeIntervalSince(start)
        print(String(format: "FLOW_FPS=%.1f (flow morph + alive base, 540x960, %d frames)", fps, n))
        #expect(fps > 1)
    }
}

struct FlowMotionTests {
    /// The geometry moves continuously (spring) while shapes switch; a closure still lands fast.
    @Test func geometryIsContinuousAndClosuresAreFast() throws {
        let set = try Synth.faceSet()
        let m = FlowMorph(data: set.flow!, neutralStill: set.expressions[.neutral]!, scale: 1)
        let old = FlowMorph(data: set.flow!, neutralStill: set.expressions[.neutral]!, scale: 1)
        let mo = try #require(m.motion)
        var new: [[Float]] = [], v1: [[Float]] = []
        for i in 0..<60 {
            let lip = LipFrame(weights: [i % 6 < 3 ? .A : .EI: 1], openness: i % 6 < 3 ? 0.8 : 0.4)
            new.append(m.stepMotion(lip, ahead: nil, at: Double(i) / 25, mo))
            v1.append(old.step(lip, at: Double(i) / 25))
        }
        // no held frames while speaking (the v1 snap path held the geometry between steps)
        func holds(_ s: [[Float]]) -> Int {
            (1..<s.count).filter { i in zip(s[i], s[i - 1]).allSatisfy { abs($0 - $1) < 1e-3 } }.count
        }
        print("motion: held frames \(holds(new)) (stepped v1 \(holds(v1)))")
        #expect(holds(new) <= 2)   // the spring may settle for a frame at a long target
        let mbp = set.flow!.keys.firstIndex(of: "MBP")!
        _ = m.stepMotion(LipFrame(weights: [.MBP: 1], openness: 0.5), ahead: nil, at: 2.04, mo)
        let closed = m.stepMotion(LipFrame(weights: [.MBP: 1], openness: 0.5), ahead: nil, at: 2.08, mo)
        #expect(closed[mbp] > 0.7)
    }
}

struct MotionV2Tests {
    /// v2 from aligner phonemes: an m/b/p shuts the mouth, a stressed vowel opens it, nothing is held still.
    @Test func phonemesDriveJawAndClosures() throws {
        let set = try Synth.faceSet()
        let order = set.flow!.keys
        var m = MotionV2(params: MotionV2Params(), faceNorm: 1)
        let ph = [LipPhonemeTiming(phoneme: "M", startMs: 0, endMs: 80), LipPhonemeTiming(phoneme: "AA1", startMs: 80, endMs: 400),
                  LipPhonemeTiming(phoneme: "B", startMs: 400, endMs: 480), LipPhonemeTiming(phoneme: "IY0", startMs: 480, endMs: 560)]
        var frames: [[Float]] = []
        var closedAt: [Bool] = []
        for i in 0..<16 {
            let ms = Double(i) * 40
            let step = m.step(ms: ms, phonemes: ph, openness: { $0 >= 80 && $0 < 400 ? 0.8 : 0.3 }, order: order, resolve: { order.contains($0) ? $0 : nil })
            let r = try #require(step)
            frames.append(r.amounts); closedAt.append(r.closed)
        }
        let mbp = order.firstIndex(of: "MBP")!
        #expect(closedAt[0] && frames[0][mbp] > 0.6)
        let openMid = frames[6].enumerated().filter { $0.offset != mbp }.map(\.element).reduce(0, +)
        #expect(openMid > 0.3)
        #expect(closedAt[10])
        var empty = MotionV2(params: MotionV2Params(), faceNorm: 1)
        #expect(empty.step(ms: 0, phonemes: [], openness: { _ in 0 }, order: order, resolve: { $0 }) == nil)
    }
}

struct FlowManifestRobustnessTests {
    @Test func aMapThisBuildCannotReadKeepsTheFlows() throws {
        let json = #"{"roi":[0.2,0.4,0.8,0.7],"size":[32,29],"flowSize":[16,15],"keys":["AH"],"files":{"AH":{"key":"a","nk":"b","kn":"c"}},"mask":"m","map":{"motion":{"riseMs":"fast"}}}"#
        let f = try JSONDecoder().decode(FaceFlowManifest.self, from: Data(json.utf8))
        #expect(f.map == nil && f.keys == ["AH"])
        let partial = #"{"riseMs": 90}"#
        let mo = try JSONDecoder().decode(FlowMap.Motion.self, from: Data(partial.utf8))
        #expect(mo.riseMs == 90 && mo.textureMin == FlowMap.Motion().textureMin)
    }
}

struct ExpressionLayerTests {
    @Test func expressionWeightsRampAroundTheClause() throws {
        let set = try Synth.faceSet()
        let m = FlowMorph(data: set.flow!, neutralStill: set.expressions[.neutral]!, scale: 1, face: set.faceBox, mouth: set.mouthBox, expressions: true)
        m.expressionEvents = [FaceExpressionEvent(tag: "smile", intensity: 0.8, startMs: 1000, endMs: 2000)]
        #expect((m.expressionWeights(atMs: 500)["smile"] ?? 0) == 0)
        #expect(abs((m.expressionWeights(atMs: 1500)["smile"] ?? 0) - 0.8) < 1e-9)
        #expect((m.expressionWeights(atMs: 2500)["smile"] ?? 0) == 0)
        #expect(m.cheekRig?.exprFields["smile"] != nil)
    }
}


struct LipRigTests {
    /// v41: the mouth inside comes from the top key as an opaque layer; below its threshold the
    /// cross-blended lips show the warped neutral inside the mouth.
    @Test func teethComeFromTheTopKeyOnlyWhenItIsOpenEnough() throws {
        let set = try Synth.faceSet(keys: ["MBP", "AH2"], rig: true)
        let m = FlowMorph(data: set.flow!, neutralStill: set.expressions[.neutral]!, scale: 1, mouth: set.mouthBox)    // no face box: the morph ROI is the output
        let k = (14 * m.width + 16) * 4
        m.amountsOverride = [0, 0.6]
        let open = pixels(m.render(.rest, at: 1))
        #expect(open[k] > 200 && open[k + 1] > 200)          // teeth layer
        m.reset()
        m.amountsOverride = [0, 0.05]
        let shut = pixels(m.render(.rest, at: 2))
        #expect(shut[k] < 200)                               // below teethMin: no teeth
    }

    /// The chin rows follow a slow, scaled copy of the amounts: a sudden opening barely moves them.
    @Test func theChinFollowsSlowly() throws {
        let set = try Synth.faceSet(keys: ["MBP", "AH2"], rig: true)
        let m = FlowMorph(data: set.flow!, neutralStill: set.expressions[.neutral]!, scale: 1, face: set.faceBox, mouth: set.mouthBox)
        m.amountsOverride = [0, 0]
        _ = m.render(.rest, at: 1)
        m.amountsOverride = [0, 1]
        _ = m.render(.rest, at: 1.04)
        #expect(m.debugChinAmounts[1] < 0.2)
    }

    @Test func prepRigAndAliveNamesDecode() throws {
        let rig = try JSONDecoder().decode(FlowMap.Rig.self, from: Data(#"{"chinGain":0.5,"teethTop":{"hyst":0.1,"min":0.2,"alpha":[0.1,0.2],"cavity":[1,2,3]},"lipFlowPx":"x"}"#.utf8))
        #expect(rig.chinGain == 0.5 && rig.teethHyst == 0.1 && rig.teethMin == 0.2 && rig.teethAlpha == [0.1, 0.2] && rig.lipFlowPx == 1.2)
        let alive = try JSONDecoder().decode(FlowMap.Alive.self, from: Data(#"{"headX":3,"headRoll":1.5,"nodPx":5,"nodWidth":2,"browPx":2.5}"#.utf8))
        #expect(alive.headGain == 3 && alive.rollGain == 1.5 && abs(alive.nodGain - 2) < 1e-9 && alive.nodWidth == 2 && alive.cheekGain == 1)
        let v2 = try JSONDecoder().decode(MotionV2Params.self, from: Data(#"{"consonantDip":0.2,"springHz":"fast","closeToPhonemeEnd":true}"#.utf8))
        #expect(v2.consonantJaw == 0.2 && v2.springHz == MotionV2Params().springHz)
    }
}

struct FramingTests {
    /// Small non-human faces are zoomed up to 35 % of the frame height (≤ 1.35×); people never; map wins.
    @Test func smallAnimalFacesZoomPeopleDoNot() throws {
        let set = try Synth.faceSet()           // human, face box 60 % high
        #expect(FaceRenderer.framing(set).zoom == 1)
        let fr = try JSONDecoder().decode(FlowMap.Framing.self, from: Data(#"{"zoom":1.2,"cy":"x"}"#.utf8))
        #expect(fr.zoom == 1.2 && fr.cy == nil)
    }

    @Test func v44TeethToneAndExitDecode() throws {
        let rig = try JSONDecoder().decode(FlowMap.Rig.self, from: Data(#"{"teethTop":{"tone":{"cavityDark":0.4,"split":0.5},"exitBeforeClose":1},"blendFloor":[0.12,0.4]}"#.utf8))
        #expect(rig.teethTone?.cavityDark == 0.4 && rig.teethTone?.teethLift == 0.5 && rig.teethExitBeforeClose && rig.blendFloor == [0.12, 0.4])
    }
}

struct RigRobustnessTests {
    /// Codex P2: a rig / framing / alive block of the wrong shape keeps the rest of the map.
    @Test func aBadOptionalBlockKeepsTheMap() throws {
        var m = FlowMap.standard; m.drive = "open"
        var j = try JSONSerialization.jsonObject(with: JSONEncoder().encode(m)) as! [String: Any]
        j["rig"] = "bad"; j["framing"] = [Int](); j["alive"] = 3; j["motionV2"] = "x"
        let back = try JSONDecoder().decode(FlowMap.self, from: JSONSerialization.data(withJSONObject: j))
        #expect(back.drive == "open" && back.rig == FlowMap.Rig() && back.framing == FlowMap.Framing())
    }

    /// Codex P1: an out-of-range percentile does not crash the teeth tone.
    @Test func teethToneSurvivesABadPercentile() throws {
        var tone = FlowMap.Rig.TeethTone(); tone.thrPct = -10
        let w = 12, h = 12
        let p = [Float](repeating: 120, count: w * h * 3)
        let inn = (0..<(w * h)).map { i in (2..<10).contains(i % w) && (2..<10).contains(i / w) ? Float(1) : 0 }
        #expect(FlowMorph.toneTeeth(p, interior: inn, width: w, height: h, tone: tone).count == p.count)
    }
}
