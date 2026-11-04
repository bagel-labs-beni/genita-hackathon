import CoreImage
import XCTest
@testable import Genita

/// D63 · S3 masks on a hand-held camera: `CameraMotion` v2 (blur → 32 × 18, best small shift, hysteresis, 2 hits in
/// a row). Hand shake, a small tilt and exposure drift keep the masks; a real move hides them until it lines up again.
@MainActor final class CameraMotionTests: XCTestCase {
    /// A smooth textured scene (sum of waves), larger than the view so it can be cropped at an offset like a moving phone.
    private static func scene(_ x: Int, _ y: Int, bright: Float = 0) -> Float {
        let fx = Float(x), fy = Float(y)
        let v = 0.5 + 0.18 * sin(fx * 0.31) + 0.14 * cos(fy * 0.43) + 0.1 * sin((fx + fy) * 0.17) + 0.06 * cos(fx * 0.9 - fy * 0.2)
        return min(1, max(0, v + bright))
    }
    /// The 32 × 18 view of the scene, offset by (dx, dy) thumbnail pixels.
    private func view(dx: Int = 0, dy: Int = 0, bright: Float = 0) -> CameraMotion.Thumb {
        var luma: [Float] = []
        for y in 0..<CameraMotion.height { for x in 0..<CameraMotion.width { luma.append(Self.scene(x + dx + 20, y + dy + 20, bright: bright)) } }
        return .init(luma: luma)
    }

    func testStillShakeAndExposureKeepTheMasks() {
        let base = view()
        XCTAssertFalse(CameraMotion.match(base, base).moved)
        XCTAssertTrue(CameraMotion.match(base, base).settled)
        // exposure +0.06: mean-normalised, so it lines up (#631's plain difference hid here on the counter scene)
        XCTAssertTrue(CameraMotion.match(base, view(bright: 0.06)).settled)
        // a 1-column / 1-row hand shake
        let shake = CameraMotion.match(base, view(dx: 1, dy: 1))
        XCTAssertFalse(shake.moved, "\(shake)")
        // 2 columns (6 % of the width) is still shake
        XCTAssertFalse(CameraMotion.match(base, view(dx: -2)).moved)
    }

    func testARealMoveIsSeen() {
        let base = view()
        let pan = CameraMotion.match(base, view(dx: 3))
        XCTAssertEqual(abs(pan.dx), 3); XCTAssertTrue(pan.moved, "3 of 32 columns = 9.4 % → moved")
        XCTAssertTrue(CameraMotion.match(base, view(dy: 2)).moved, "2 of 18 rows = 11 % vertical → moved")
        // farther than the search reaches: nothing lines up, the residual says it moved
        XCTAssertTrue(CameraMotion.match(base, view(dx: 12, dy: 7)).moved)
    }

    func testTwoHitsInARowHideAndTwoSettledShowAgain() {
        let still = CameraMotion.Match(dx: 0, dy: 0, residual: 0.02)
        let moved = CameraMotion.Match(dx: 3, dy: 0, residual: 0.03)
        let between = CameraMotion.Match(dx: 0, dy: 0, residual: 0.08) // neither moved nor settled
        var d = CameraMotion.Detector()
        XCTAssertFalse(d.feed(moved), "one hit (a jolt) keeps the masks")
        XCTAssertFalse(d.feed(still))
        XCTAssertFalse(d.feed(moved))
        XCTAssertFalse(d.feed(between), "an in-between sample breaks the run")
        XCTAssertFalse(d.feed(moved))
        XCTAssertTrue(d.feed(moved), "two hits in a row hide")
        XCTAssertTrue(d.feed(still), "one settled sample keeps them hidden")
        XCTAssertTrue(d.feed(between))
        XCTAssertTrue(d.feed(still))
        XCTAssertFalse(d.feed(still), "two settled in a row bring them back")
    }

    func testBlurredThumbnailOfARealImage() throws {
        // a CIImage scene cropped at an offset, as the sim did on the s3 frames: 1–3 % shake keeps, 8 % and 12 % pans hide
        let w0 = 1200, h0 = 700
        var px = [UInt8](repeating: 255, count: w0 * h0 * 4)
        for y in 0..<h0 { for x in 0..<w0 { let v = UInt8(Self.scene(x / 30, y / 30) * 255); for c in 0..<3 { px[(y * w0 + x) * 4 + c] = v } } }
        let full = CIImage(bitmapData: Data(px), bytesPerRow: w0 * 4, size: CGSize(width: w0, height: h0), format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB))
        func crop(_ fx: CGFloat, _ fy: CGFloat) -> CIImage { full.cropped(to: CGRect(x: 120 + fx * 1200, y: 70 + fy * 700, width: 960, height: 540)) }
        let ctx = CIContext(options: [.cacheIntermediates: false])
        let base = try XCTUnwrap(CameraMotion.thumb(crop(0, 0), context: ctx))
        XCTAssertEqual(base.luma.count, 32 * 18)
        XCTAssertFalse(CameraMotion.match(base, try XCTUnwrap(CameraMotion.thumb(crop(0.01, 0.01), context: ctx))).moved)
        XCTAssertFalse(CameraMotion.match(base, try XCTUnwrap(CameraMotion.thumb(crop(0.03, 0.02), context: ctx))).moved)
        XCTAssertTrue(CameraMotion.match(base, try XCTUnwrap(CameraMotion.thumb(crop(0.08, 0), context: ctx))).moved)
        XCTAssertTrue(CameraMotion.match(base, try XCTUnwrap(CameraMotion.thumb(crop(0.12, 0), context: ctx))).moved)
    }

    func testANewLookOrClearLinesTheMasksUpAgain() {
        let boxes = CameraBoxes()
        let batch = ServerEvent.ObserveBoxes(findId: "f1", frame: 0, w: 480, h: 854, items: [.init(label: "Tomato", box: NormBox(x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4))])
        boxes.apply(batch)
        boxes.setMisaligned(true)
        XCTAssertTrue(boxes.misaligned)
        XCTAssertTrue(boxes.visible, "moving hides the masks by opacity only; the hold keeps them")
        boxes.apply(batch)
        XCTAssertFalse(boxes.misaligned, "a new look is on the frame just taken")
        boxes.setMisaligned(true)
        boxes.clear()
        XCTAssertFalse(boxes.misaligned)
    }
}
