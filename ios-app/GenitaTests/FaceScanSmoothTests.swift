import XCTest
import SwiftUI
@testable import Genita

/// TF 331 (Chelsea: the V03 net "flickers a lot"). A second answer for the same face (the polish flow's check, a
/// re-fit) used to wipe every reveal time, so all 25 points sprang in again at once and the lines and faces re-drew.
/// Now the net glides to the new places over 0.18 s, points ease in without overshoot, and the sweep never runs back.
/// The filmstrips (before = old snap + spring, after = smooth) are exported as preview-v03-mesh-smooth-*.
@MainActor final class FaceScanSmoothTests: XCTestCase {
    private func box(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) throws -> ImageHeadBox {
        try JSONDecoder().decode(ImageHeadBox.self, from: JSONSerialization.data(withJSONObject: ["nx1": x1, "ny1": y1, "nx2": x2, "ny2": y2]))
    }
    private let t0 = Date(timeIntervalSinceReferenceDate: 0)
    /// the second answer lands here (s); the first sweep runs 0 → 0.4 s
    private let switchAt = 0.6

    /// a detector answer for a face in this head box (eyes, nose, lips at human places), so the full net is drawn
    private func points(in b: ImageHeadBox) throws -> FacePoints {
        let cx = (b.nx1! + b.nx2!) / 2, cy = b.ny1! + (b.ny2! - b.ny1!) * 0.6, rx = (b.nx2! - b.nx1!) * 0.36, ry = (b.ny2! - b.ny1!) * 0.38
        let at = { (dx: Double, fy: Double) in [cx + rx * dx, cy - ry + 2 * ry * fy] }
        let json: [String: [[Double]]] = ["leftEye": [at(-0.61, 0.355), at(-0.23, 0.355)], "rightEye": [at(0.25, 0.355), at(0.61, 0.355)],
                                          "leftBrow": [], "rightBrow": [], "nose": [at(0, 0.5), at(0, 0.57)],
                                          "lips": [at(-0.33, 0.74), at(0, 0.69), at(0.29, 0.74), at(0, 0.81)]]
        return try JSONDecoder().decode(FacePoints.self, from: JSONSerialization.data(withJSONObject: json))
    }
    /// the first answer, and a second one for the same face a little lower-right (the polish check, a re-fit)
    private func meshes() throws -> (FaceMesh, FaceMesh) {
        let boxA = try box(0.30, 0.14, 0.70, 0.60), boxB = try box(0.34, 0.17, 0.74, 0.63)
        let a = try XCTUnwrap(FaceMesh.make(outline: nil, points: try points(in: boxA), headBox: boxA))
        let b = try XCTUnwrap(FaceMesh.make(outline: nil, points: try points(in: boxB), headBox: boxB))
        XCTAssertGreaterThan(a.triangles.count, 4)
        return (a, b)
    }

    func testSameNetGlidesInsteadOfRepopping() throws {
        let (a, b) = try meshes()
        XCTAssertEqual(a.triangles, b.triangles); XCTAssertNotEqual(a.points, b.points)
        let clock = RevealClock()
        clock.update(to: a, at: t0, glide: FaceScanOverlay.glide)
        for i in a.points.indices { clock.mark(i, at: t0) }
        let at = t0.addingTimeInterval(switchAt)
        clock.update(to: b, at: at, glide: FaceScanOverlay.glide)
        XCTAssertEqual(clock.time(0), t0, "reveal times survive the second answer: no re-pop")
        XCTAssertEqual(clock.points(at: at), a.points, "starts where it was")
        // every 60 Hz frame moves a point a small part of the way, and it lands on time
        var last = a.points, biggest: CGFloat = 0
        for f in 1...12 {
            let p = clock.points(at: at.addingTimeInterval(Double(f) / 60))
            biggest = max(biggest, zip(last, p).map { hypot($0.x - $1.x, $0.y - $1.y) }.max() ?? 0)
            last = p
        }
        let total = zip(a.points, b.points).map { hypot($0.x - $1.x, $0.y - $1.y) }.max() ?? 0
        XCTAssertLessThan(biggest, total * 0.5, "no frame jumps most of the way")
        XCTAssertEqual(clock.points(at: at.addingTimeInterval(FaceScanOverlay.glide + 0.01)), b.points)
        XCTAssertNil(clock.leaving(at: at), "same net: nothing to crossfade")
    }

    func testAnotherNetCrossfadesAndSnapStillResets() throws {
        let (a, _) = try meshes()
        var small = a; small.triangles = Array(a.triangles.prefix(4)); small.edges = Array(a.edges.prefix(6))
        let clock = RevealClock()
        clock.update(to: a, at: t0, glide: FaceScanOverlay.glide)
        clock.mark(0, at: t0)
        clock.update(to: small, at: t0.addingTimeInterval(1), glide: FaceScanOverlay.glide)
        XCTAssertNil(clock.time(0), "a different net reveals again")
        let fading = try XCTUnwrap(clock.leaving(at: t0.addingTimeInterval(1.05)))
        XCTAssertGreaterThan(fading.alpha, 0); XCTAssertLessThan(fading.alpha, 1)
        XCTAssertNil(clock.leaving(at: t0.addingTimeInterval(1.3)), "gone after the glide")
        // Reduce Motion / the old look: snap, no crossfade
        let still = RevealClock()
        still.update(to: a, at: t0, glide: 0); still.mark(0, at: t0)
        still.update(to: small, at: t0.addingTimeInterval(1), glide: 0)
        XCTAssertNil(still.time(0)); XCTAssertNil(still.leaving(at: t0.addingTimeInterval(1.01)))
    }

    func testSweepNeverRunsBack() {
        let clock = RevealClock()
        XCTAssertEqual(clock.netY(100, monotonic: true), 100)
        XCTAssertEqual(clock.netY(60, monotonic: true), 100, "a dip in reveal / progress keeps what was shown")
        XCTAssertEqual(clock.netY(0, monotonic: false), 0, "the bar starting over (Try again) starts the sweep over")
    }

    /// 3× filmstrips over the second answer: 6 frames from the switch to 0.3 s after it, before vs after.
    func testFilmstrips() throws {
        let (a, b) = try meshes()
        let url = try XCTUnwrap(Bundle.main.url(forResource: "qa-sample-human", withExtension: "jpg"))
        let photo = try XCTUnwrap(UIImage(contentsOfFile: url.path))
        let size = CGSize(width: photo.size.width * photo.scale, height: photo.size.height * photo.scale)
        let card = CGSize(width: 342, height: 240)
        let origin = FaceMesh.fillOrigin(image: size, in: card, focus: a.bounds, topMargin: 12)
        let s = max(card.width / size.width, card.height / size.height)
        let keep: Set<Int> = [37, 39, 41, 43, 47, 54]   // 60 Hz frames: switch + 0.02 … + 0.3 s
        for (label, smooth) in [("before", false), ("after", true)] {
            let clock = RevealClock()
            var frames: [UIImage] = []
            for f in 0...54 {
                let t = Double(f) / 60
                let mesh = t < switchAt ? a : b
                let progress = min(1, 0.55 + 0.45 * t / 0.4)
                let view = ZStack(alignment: .topLeading) {
                    Image(uiImage: photo).resizable().frame(width: size.width * s, height: size.height * s).offset(x: origin.x, y: origin.y)
                    FaceScanOverlay(progress: progress, reveal: 1, mesh: mesh, imageSize: size, origin: origin, showLine: false,
                                    smooth: smooth, frame: (clock, t0.addingTimeInterval(t)))
                }.frame(width: card.width, height: card.height, alignment: .topLeading).clipped()
                let renderer = ImageRenderer(content: view); renderer.scale = keep.contains(f) ? 3 : 1
                let image = try XCTUnwrap(renderer.uiImage, "\(label) \(f)")
                if keep.contains(f) { frames.append(image) }
            }
            let strip = HStack(spacing: 8) {
                ForEach(Array(frames.enumerated()), id: \.offset) { i, img in
                    VStack(spacing: 4) {
                        Image(uiImage: img).resizable().frame(width: card.width, height: card.height)
                        Text(String(format: "+%.0f ms", (Double(keep.sorted()[i]) / 60 - switchAt) * 1000)).font(.system(size: 13, weight: .medium))
                    }
                }
            }.padding(8).background(Color.white)
            let renderer = ImageRenderer(content: strip); renderer.scale = 3
            let image = try XCTUnwrap(renderer.uiImage)
            let att = XCTAttachment(image: image); att.name = "preview-v03-mesh-smooth-\(label)"; att.lifetime = .keepAlways; add(att)
        }
    }
}
