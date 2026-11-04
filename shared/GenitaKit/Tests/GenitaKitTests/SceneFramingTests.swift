import CoreGraphics
import Foundation
import Testing
@testable import GenitaKit

/// Face plan item 1: S09 draws the call scene in the face set's crop before the set lands; the rest frame (poster) and
/// the live face that follow must sit on the same pixels.
struct SceneFramingTests {
    private static let flowDir = Bundle.module.url(forResource: "face-flow-animal", withExtension: nil, subdirectory: "Fixtures")!
    private static let flowSet: FaceSet = try! FaceSet(directory: flowDir)

    private static func rgba(_ i: CGImage) -> [UInt8] {
        var b = [UInt8](repeating: 0, count: i.width * i.height * 4)
        let ctx = CGContext(data: &b, width: i.width, height: i.height, bitsPerComponent: 8, bytesPerRow: i.width * 4,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(i, in: CGRect(x: 0, y: 0, width: i.width, height: i.height))
        return b
    }

    /// Share of pixels whose largest channel differs by more than `over` (0–255), and the mean difference.
    static func overlap(_ a: CGImage, _ b: CGImage, over: Int = 25) -> (share: Double, mean: Double) {
        let x = rgba(a), y = rgba(b), n = a.width * a.height
        var bad = 0, sum = 0.0
        for p in 0..<n {
            var m = 0
            for c in 0..<3 { let d = abs(Int(x[p * 4 + c]) - Int(y[p * 4 + c])); m = max(m, d); sum += Double(d) }
            if m > over { bad += 1 }
        }
        return (Double(bad) / Double(n), sum / Double(n * 3))
    }

    @Test func everyMotionRunStartsStillThenEasesIn() {
        var m = AliveMotion(seed: 9)
        m.cameraGain = 1
        let face = CGRect(x: 100, y: 300, width: 300, height: 360), extent = CGRect(x: 0, y: 0, width: 540, height: 960)
        func still(_ t: (head: CGAffineTransform, body: CGAffineTransform, camera: CGAffineTransform)) -> Bool {
            t.head.isIdentity && t.body.isIdentity && t.camera.isIdentity
        }
        func move(_ t: (head: CGAffineTransform, body: CGAffineTransform, camera: CGAffineTransform)) -> CGFloat {
            let p = CGPoint(x: face.midX, y: face.midY), q = p.applying(t.head.concatenating(t.camera))
            return hypot(q.x - p.x, q.y - p.y)
        }
        #expect(still(m.transforms(at: 0, open: 0, face: face, extent: extent, outputWidth: 540)))
        // the first live tick 40 ms later: well under a pixel
        #expect(move(m.transforms(at: 0.04, open: 0, face: face, extent: extent, outputWidth: 540)) < 0.05)
        var settled: CGFloat = 0
        for i in 2...60 { settled = max(settled, move(m.transforms(at: Double(i) / 25, open: 0, face: face, extent: extent, outputWidth: 540))) }
        #expect(settled > 0.3)   // the motion is back after the ease-in
        // the display link paused (poster while connecting, live face later): the next run starts still again
        #expect(still(m.transforms(at: 2.4 + AliveMotion.restartGap + 0.1, open: 0, face: face, extent: extent, outputWidth: 540)))
        // the live face started 0.7 s after the poster's frame (FaceDriver.start → restartRun): still again (Codex P2)
        for i in 1...30 { _ = m.transforms(at: 4.6 + Double(i) / 25, open: 0, face: face, extent: extent, outputWidth: 540) }
        m.restartRun()
        #expect(still(m.transforms(at: 6.0, open: 0, face: face, extent: extent, outputWidth: 540)))
        #expect(move(m.transforms(at: 6.04, open: 0, face: face, extent: extent, outputWidth: 540)) < 0.05)
    }

    @Test func sceneFramingIsTheRenderersFraming() {
        let f = SceneFraming(Self.flowSet), r = FaceRenderer.framing(Self.flowSet)
        #expect(abs(f.zoom - Double(r.zoom)) < 1e-9)
        #expect(abs(f.cx * Double(Self.flowSet.pixelSize.width) - Double(r.center.x)) < 1e-6)
        #expect(abs(f.cy * Double(Self.flowSet.pixelSize.height) - Double(r.center.y)) < 1e-6)
        #expect(SceneFraming(zoom: 9, cx: -1, cy: 2).sanitized == SceneFraming(zoom: 2, cx: 0, cy: 1))
        #expect(SceneFraming(zoom: .nan, cx: 0.5, cy: 0.5).sanitized == nil)
    }

    /// The gate on the repo fixture (an animal: zoomed framing): the framed scene and the rest frame overlap.
    @Test(arguments: [false, true]) func framedSceneLandsOnTheRestFrame(reduceMotion: Bool) throws {
        let set = Self.flowSet
        let out = CGSize(width: 540, height: (540 * set.pixelSize.height / set.pixelSize.width).rounded())
        let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: Self.flowDir.appendingPathComponent("manifest.json"))) as! [String: Any]
        let scene = try Data(contentsOf: Self.flowDir.appendingPathComponent((manifest["images"] as! [String: String])["neutral"]!))
        let poster = try #require(FaceRenderer(faceSet: set, outputSize: out, seed: 77, reduceMotion: reduceMotion).render(at: 0, lip: .rest))
        let framed = try #require(FaceRenderer.framedScene(data: scene, outputSize: out, framing: SceneFraming(set), reduceMotion: reduceMotion))
        let plain = try #require(FaceRenderer.framedScene(data: scene, outputSize: out, framing: SceneFraming(zoom: 1, cx: 0.5, cy: 0.5), reduceMotion: true))
        let o = Self.overlap(framed, poster), before = Self.overlap(plain, poster)
        print(String(format: "SCENE_FRAMING rm=%@ framed: %.3f%% px >25, mean %.3f | plain fill: %.3f%%, mean %.3f",
                     "\(reduceMotion)", o.share * 100, o.mean, before.share * 100, before.mean))
        #expect(o.share < 0.02)
        #expect(o.mean < 2.0)
        #expect(before.share > o.share)
    }

    /// Codex P2: a flow file that didn't download drops the flow, never the crop (the server's `framing` assumes it).
    @Test func aDroppedFlowKeepsTheCrop() throws {
        var m = try JSONDecoder().decode(FaceManifest.self, from: Data(contentsOf: Self.flowDir.appendingPathComponent("manifest.json")))
        let with = SceneFraming(Self.flowSet)
        m.dropFlow()
        #expect(m.flow == nil)
        let set = try FaceSet(manifest: m) { ref in
            try Data(contentsOf: Self.flowDir.appendingPathComponent(URL(string: ref)?.lastPathComponent ?? ref))
        }
        #expect(set.flow == nil)
        #expect(with.zoom > 1.001)   // an animal: zoomed
        #expect(SceneFraming(set) == with)
    }

    @Test func prepDecodesTheFraming() throws {
        let p = try JSONDecoder().decode(PrepProgress.self, from: Data(#"{"status":"running","framing":{"zoom":1.2,"cx":0.5,"cy":0.37}}"#.utf8))
        #expect(p.framing == SceneFraming(zoom: 1.2, cx: 0.5, cy: 0.37))
        #expect(try JSONDecoder().decode(PrepProgress.self, from: Data(#"{"status":"running","framing":null}"#.utf8)).framing == nil)
        #expect(try JSONDecoder().decode(PrepProgress.self, from: Data(#"{"status":"running","framing":{"zoom":"x"}}"#.utf8)).framing == nil)
        #expect(try JSONDecoder().decode(PrepProgress.self, from: Data(#"{"status":"running"}"#.utf8)).framing == nil)
    }
}
