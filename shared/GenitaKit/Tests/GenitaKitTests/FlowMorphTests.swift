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
    static func faceSet(keys: [String] = ["MBP", "MID", "AH", "AH2", "A"], breakKey: String? = nil) throws -> FaceSet {
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
            files["\(k).png"] = png(sw, sh) { x, y in (8..<24).contains(x) && (11..<17).contains(y) ? (k == "MBP" ? (150, 70, 70) : (30, 10, 10)) : skin }
            files["\(k).nk"] = f16(Synth.flowSize[0] * Synth.flowSize[1] * 2, dx: 0, dy: k == "MBP" ? 0 : 1)
            files["\(k).kn"] = k == breakKey ? Data([1, 2, 3]) : f16(Synth.flowSize[0] * Synth.flowSize[1] * 2, dx: 0, dy: k == "MBP" ? 0 : -1)
            fm[k] = .init(key: "\(k).png", nk: "\(k).nk", kn: "\(k).kn")
        }
        let flow = FaceFlowManifest(version: 1, roi: roi, size: size, flowSize: flowSize, keys: keys, files: fm, mask: "mask.png", lockY: 0.55, kind: "human", map: nil)
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
        let mid = m.amounts(LipFrame(weights: [.A: 1], openness: 0.5))
        #expect((mid["AH"] ?? 0) > 0 && (mid["AH2"] ?? 0) > 0 && mid["A"] == nil)
        let loud = m.amounts(LipFrame(weights: [.A: 1], openness: 1))
        #expect(loud["A"] == nil && (loud["AH2"] ?? 0) > 0.9)
        #expect(!set.flow!.map.ladder.steps.contains { $0.key == "A" })
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
}
