import XCTest
@testable import Genita

/// The live orb keeps Dyno's numbers (bagel-labs-beni/genita 25afbe03 src/orb/entry.js + orb-motion.mjs).
final class SoulOrbTests: XCTestCase {
    private func lcg(_ seed: UInt32) -> () -> Double {
        var state = seed
        return { state = state &* 1_664_525 &+ 1_013_904_223; return Double(state) / 4_294_967_296 }
    }

    /// Fixture from running Dyno's createMotion with the same LCG (seed 42), update(1.3) × 40, every 8th key.
    func testMotionMatchesDynoJS() {
        var motion = SoulOrbMotion(random: lcg(42))
        var keys: [SoulOrbMotion.Key] = []
        for i in 0..<40 { let k = motion.update(1.3); if i % 8 == 0 { keys.append(k) } }
        let js: [(Double, Double, Double)] = [
            (1.199151, -0.632080, -1.797307), (1.064576, 0.188922, -1.385468), (0.872184, 0.391581, 1.273812),
            (1.080051, -0.366526, 0.416161), (1.105815, -0.548052, -1.693029),
        ]
        for (k, e) in zip(keys, js) {
            XCTAssertEqual(k.scale.x, e.0, accuracy: 1e-6); XCTAssertEqual(k.shape.y, e.1, accuracy: 1e-6); XCTAssertEqual(k.offset.z, e.2, accuracy: 1e-6)
        }
        XCTAssertEqual(motion.sequence, [2, 0, 3, 1, 4, 6, 7, 5])
    }

    func testShuffleBagVisitsAllEightWithoutRepeats() {
        var motion = SoulOrbMotion(random: lcg(7))
        for _ in 0..<400 { _ = motion.update(1); XCTAssert((6...10).contains(motion.duration)) }
        let seq = motion.sequence
        XCTAssertGreaterThan(seq.count, 40)
        for i in 1..<seq.count { XCTAssertNotEqual(seq[i], seq[i - 1]) }
        for start in stride(from: 0, to: seq.count - 7, by: 8) { XCTAssertEqual(Set(seq[start..<start + 8]), Set(0..<8)) }
        XCTAssertEqual(SoulOrbMotion.smootherstep(0), 0); XCTAssertEqual(SoulOrbMotion.smootherstep(1), 1)
        XCTAssertEqual(SoulOrbMotion.smootherstep(0.5), 0.5, accuracy: 1e-12)
    }

    func testSeedsAndColoursMatchDyno() {
        let s = SoulOrbLook.seeds(count: 2)
        XCTAssertEqual(s[0].x, 0.7945743587333709, accuracy: 1e-7); XCTAssertEqual(s[0].w, 0.5521386829204857, accuracy: 1e-7)
        XCTAssertEqual(s[1].w, 0.7565307184122503, accuracy: 1e-7)
        XCTAssertEqual(SoulOrbLook.count, 9_900)
        let tint = SoulOrbLook.linear(SoulOrbLook.tintHex)
        XCTAssertEqual(tint.y, 0.5089, accuracy: 1e-3); XCTAssertEqual(tint.z, 1, accuracy: 1e-6)
        XCTAssertEqual(MemoryLayout<SoulOrbUniforms>.stride, 160)
    }

    func testReactionRisesAndSettles() {
        var clock = SoulOrbClock(motion: SoulOrbMotion(random: lcg(1)))
        for _ in 0..<60 { clock.step(1.0 / 60) }
        XCTAssertEqual(clock.activity, 0); XCTAssertEqual(clock.idleClock, 1.5, accuracy: 1e-9)
        clock.respond()
        for _ in 0..<60 { clock.step(1.0 / 60) }
        XCTAssertGreaterThan(clock.activity, 0.7)
        for _ in 0..<240 { clock.step(1.0 / 60) }
        XCTAssertFalse(clock.responding); XCTAssertLessThan(clock.activity, 0.05)
        clock.step(10); XCTAssertEqual(clock.idleClock, 6 * 1.5 + 0.05 * 1.5, accuracy: 1e-9) // dt capped at 50 ms
    }

    /// PRD D94: Reduce Motion = breathing only (1.00 ↔ 1.04, 3 s); the shape and the clocks hold, no reaction.
    func testReduceMotionBreathesOnly() {
        var clock = SoulOrbClock(motion: SoulOrbMotion(random: lcg(1)))
        clock.reduceMotion = true
        let shape = clock.key
        clock.respond()
        for _ in 0..<90 { clock.step(1.0 / 60) }
        XCTAssertFalse(clock.responding); XCTAssertEqual(clock.activity, 0)
        XCTAssertEqual(clock.idleClock, 0); XCTAssertEqual(clock.time, 0); XCTAssertEqual(clock.key, shape)
        XCTAssertEqual(clock.scale, 1.04, accuracy: 1e-9)
        for _ in 0..<90 { clock.step(1.0 / 60) }
        XCTAssertEqual(clock.scale, 1, accuracy: 1e-9)
        clock.reduceMotion = false
        XCTAssertEqual(clock.scale, 1)
    }

    /// CI crash (FidelitySnapshotTests, signal trap): draw(in:) converted an infinite drawable size to Int.
    func testDrawSkipsSizesMetalCannotAllocate() {
        XCTAssertNil(SoulOrbRenderer.targetSize(CGSize(width: CGFloat.infinity, height: 481)))
        XCTAssertNil(SoulOrbRenderer.targetSize(CGSize(width: 519, height: CGFloat.nan)))
        XCTAssertNil(SoulOrbRenderer.targetSize(CGSize(width: 0, height: 481)))
        XCTAssertNil(SoulOrbRenderer.targetSize(CGSize(width: 20_000, height: 481)))
        XCTAssertEqual(SoulOrbRenderer.targetSize(CGSize(width: 519.5, height: 481))?.0, 519)
    }
}
