import CoreGraphics
import Foundation
import Testing
@testable import GenitaKit

// Face set load cost (face-load plan item 4): a face with flow data skips the viseme patches the
// flow renderer never draws, and the CPU work that remains runs per image in parallel.

private let animalDir = Bundle.module.url(forResource: "face-animal", withExtension: nil, subdirectory: "Fixtures")!
private let flowDir = Bundle.module.url(forResource: "face-flow-animal", withExtension: nil, subdirectory: "Fixtures")!

/// The shape prep serves today: expression stills + viseme stills + a flow block. The dog's real flow
/// export shares the face-animal neutral (same 512×910 still and boxes). Still and viseme refs carry an
/// `a:` prefix so they never collide with the flow export's own `neutral.jpg` (its mouth crop).
private func flowFaceManifest() throws -> FaceManifest {
    var m = try JSONDecoder().decode(FaceManifest.self, from: Data(contentsOf: animalDir.appendingPathComponent("manifest.json")))
    m.images = m.images.mapValues { "a:" + $0 }
    m.visemes = m.visemes.mapValues { "a:" + $0 }
    let flow = try JSONDecoder().decode(FaceManifest.self, from: Data(contentsOf: flowDir.appendingPathComponent("manifest.json"))).flow
    m.flow = try #require(flow)
    return m
}

private func fixtureData(_ ref: String) throws -> Data {
    ref.hasPrefix("a:")
        ? try Data(contentsOf: animalDir.appendingPathComponent(String(ref.dropFirst(2))))
        : try Data(contentsOf: flowDir.appendingPathComponent(ref))
}

private final class Refs: @unchecked Sendable {
    private let lock = NSLock()
    private var refs: [String] = []
    func add(_ r: String) { lock.lock(); refs.append(r); lock.unlock() }
    var all: [String] { lock.lock(); defer { lock.unlock() }; return refs }
}

struct FaceSetLoadTests {
    @Test func aFlowFaceSkipsTheVisemePatches() throws {
        let m = try flowFaceManifest()
        let seen = Refs()
        let set = try FaceSet(manifest: m) { ref in seen.add(ref); return try fixtureData(ref) }
        #expect(set.flow != nil)
        #expect(set.patches.isEmpty, "the flow renderer never draws key patches")
        #expect(Set(set.expressions.keys) == Set(FaceExpression.allCases))
        // viseme stills aren't even read
        let visemeRefs = Set(m.visemes.values)
        #expect(seen.all.allSatisfy { !visemeRefs.contains($0) }, "\(seen.all)")
        #expect(set.notes.contains { $0.hasPrefix("visemes: skipped") }, "\(set.notes)")
        // expression alignment is the same work as on the flow-less face with the same stills
        let plain = try FaceSet(directory: animalDir)
        for e in FaceExpression.allCases {
            #expect(set.expressionShift[e]?.dx == plain.expressionShift[e]?.dx && set.expressionShift[e]?.dy == plain.expressionShift[e]?.dy, "\(e)")
        }
        // and it renders through the flow morph
        let r = FaceRenderer(faceSet: set, outputSize: CGSize(width: 90, height: 160), seed: 1)
        #expect(r.render(at: 0.5, lip: LipFrame(weights: [.A: 1], openness: 0.9)) != nil)
    }

    @Test func aFlowBlockThatFailsToLoadKeepsTheKeyPatches() throws {
        let m = try flowFaceManifest()
        let broken = try #require(m.flow?.files.values.first?.nk)
        let set = try FaceSet(manifest: m) { ref in
            if ref == broken { return Data([1, 2, 3]) }
            return try fixtureData(ref)
        }
        #expect(set.flow == nil)
        #expect(set.patches.count >= 8, "\(set.notes)")
        #expect(set.notes.contains { $0.hasPrefix("flow:") })
    }

    /// Prints build times and a digest of everything a load produces (stills, shifts, patches, notes):
    /// the digest must not change for a flow-less face when only speed work lands.
    /// `GENITAKIT_PERF=1 ./test.sh [-c release -Xswiftc -enable-testing] --filter FaceSetLoadTests`
    @Test(.enabled(if: ProcessInfo.processInfo.environment["GENITAKIT_PERF"] == "1"))
    func buildTime() throws {
        let m = try flowFaceManifest()
        func time(_ build: () throws -> FaceSet) rethrows -> (ms: [Double], set: FaceSet) {
            var ms: [Double] = [], last: FaceSet?
            for _ in 0..<5 {
                let t0 = DispatchTime.now().uptimeNanoseconds
                last = try build()
                ms.append(Double(DispatchTime.now().uptimeNanoseconds - t0) / 1e6)
            }
            return (ms.sorted(), last!)
        }
        let plain = try time { try FaceSet(directory: animalDir) }
        let flow = try time { try FaceSet(manifest: m, load: fixtureData) }
        for (name, r) in [("face-animal (no flow)", plain), ("face-animal + flow", flow)] {
            print(String(format: "FACESET_MS %@: median %.0f ms, min %.0f, max %.0f (n=5, %d cores); digest %016llx",
                         name, r.ms[2], r.ms[0], r.ms[4], ProcessInfo.processInfo.activeProcessorCount, digest(r.set)))
        }
    }
}

private func digest(_ s: FaceSet) -> UInt64 {
    var h: UInt64 = 0xcbf2_9ce4_8422_2325
    func mix<S: Sequence>(_ bytes: S) where S.Element == UInt8 { for b in bytes { h = (h ^ UInt64(b)) &* 0x100_0000_01b3 } }
    func mix(_ i: Int) { withUnsafeBytes(of: Int64(i)) { mix($0) } }
    func mix(_ d: Double) { withUnsafeBytes(of: d.bitPattern) { mix($0) } }
    func mix(_ img: CGImage) { if let d = img.dataProvider?.data { mix(d as Data) } }
    for e in FaceExpression.allCases {
        guard let img = s.expressions[e] else { continue }
        mix(Array(e.rawValue.utf8)); mix(img)
        mix(s.expressionShift[e]?.dx ?? 99); mix(s.expressionShift[e]?.dy ?? 99)
    }
    for v in LipViseme.allCases {
        mix(Array(v.rawValue.utf8))
        if let p = s.patches[v] {
            mix(p.image); mix(Double(p.rect.minX)); mix(Double(p.rect.minY)); mix(Double(p.rect.width)); mix(Double(p.rect.height))
            mix(p.shift.dx); mix(p.shift.dy); mix(p.surroundDiff)
        }
        mix(Array((s.resolved[v].flatMap { $0?.rawValue } ?? "-").utf8))
    }
    mix(Array(s.notes.joined(separator: "|").utf8))
    return h
}
