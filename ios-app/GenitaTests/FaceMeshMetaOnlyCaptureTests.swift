import XCTest
import SwiftUI
@testable import Genita

/// D28 (scenario: points come from Meta only): 3× V03 captures for the dog and the hand-drawn QA photos when the check
/// answer has a head box but no eye / mouth boxes. "before" = what the net looked like when it filled in the r02 human
/// eye / nose / mouth places; "after" = the head oval only. Exported as preview-v03-meta-only-* (handoff-screens).
@MainActor final class FaceMeshMetaOnlyCaptureTests: XCTestCase {
    /// the r02 human proportions inside the head-box oval, as fake detector points: the old fallback's look
    private func humanPlaceholders(_ b: ImageHeadBox) throws -> FacePoints {
        let cx = (b.nx1! + b.nx2!) / 2, cy = b.ny1! + (b.ny2! - b.ny1!) * 0.6, rx = (b.nx2! - b.nx1!) * 0.36, ry = (b.ny2! - b.ny1!) * 0.38
        let at = { (dx: Double, fy: Double) in [cx + rx * dx, cy - ry + 2 * ry * fy] }
        let json: [String: [[Double]]] = ["leftEye": [at(-0.61, 0.355), at(-0.23, 0.355)], "rightEye": [at(0.25, 0.355), at(0.61, 0.355)],
                                          "leftBrow": [], "rightBrow": [], "nose": [at(0, 0.5), at(0, 0.57)],
                                          "lips": [at(-0.33, 0.74), at(0, 0.69), at(0.29, 0.74), at(0, 0.81)]]
        return try JSONDecoder().decode(FacePoints.self, from: JSONSerialization.data(withJSONObject: json))
    }
    private func boxOf(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) throws -> ImageHeadBox {
        try JSONDecoder().decode(ImageHeadBox.self, from: JSONSerialization.data(withJSONObject: ["nx1": x1, "ny1": y1, "nx2": x2, "ny2": y2]))
    }

    func testCaptures() throws {
        let card = CGSize(width: 342, height: 240)
        for (name, box) in [("dog", try boxOf(0.2, 0.12, 0.8, 0.62)), ("drawing", try boxOf(0.28, 0.2, 0.72, 0.55))] {
            let url = try XCTUnwrap(Bundle.main.url(forResource: "qa-sample-\(name)", withExtension: "jpg"), name)
            let photo = try XCTUnwrap(UIImage(contentsOfFile: url.path), name)
            let size = CGSize(width: photo.size.width * photo.scale, height: photo.size.height * photo.scale)
            let after = try XCTUnwrap(FaceMesh.make(outline: nil, points: nil, headBox: box))
            XCTAssertEqual(after.points.count, 12, "\(name): the oval only"); XCTAssertTrue(after.triangles.isEmpty)
            let before = try XCTUnwrap(FaceMesh.make(outline: nil, points: try humanPlaceholders(box), headBox: box))
            for (label, mesh) in [("before", before), ("after", after)] {
                let origin = FaceMesh.fillOrigin(image: size, in: card, focus: mesh.bounds, topMargin: 12)
                let view = ZStack(alignment: .topLeading) {
                    Image(uiImage: photo).resizable().frame(width: size.width * max(card.width / size.width, card.height / size.height),
                                                           height: size.height * max(card.width / size.width, card.height / size.height))
                        .offset(x: origin.x, y: origin.y)
                    FaceScanOverlay(progress: 1, reveal: 1, mesh: mesh, imageSize: size, origin: origin, reduceMotion: true, showLine: false)
                }.frame(width: card.width, height: card.height, alignment: .topLeading).clipped()
                let renderer = ImageRenderer(content: view); renderer.scale = 3
                let image = try XCTUnwrap(renderer.uiImage, "\(name) \(label)")
                let a = XCTAttachment(image: image); a.name = "preview-v03-meta-only-\(name)-\(label)"; a.lifetime = .keepAlways; add(a)
            }
        }
    }
}
