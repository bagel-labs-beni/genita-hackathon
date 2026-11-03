import CoreGraphics
import Foundation
import Testing
@testable import GenitaKit

/// Live SAM 3.1 answer for the app's review photo (Resources/companion.png, 941 × 1672), 11/4 02:24 KST.
private let companionGeometry = #"{"faceOutline":[[0.5018,0.2643],[0.542,0.3343],[0.5806,0.3409],[0.6161,0.3516],[0.659,0.3595],[0.7078,0.3705],[0.7326,0.3941],[0.7655,0.4184],[0.7707,0.4479],[0.7546,0.4762],[0.7542,0.5068],[0.7289,0.5333],[0.695,0.5566],[0.6609,0.582],[0.6122,0.598],[0.5588,0.6093],[0.5018,0.6124],[0.4448,0.6093],[0.3945,0.5938],[0.3516,0.5745],[0.3147,0.5533],[0.2946,0.5259],[0.2715,0.5016],[0.2573,0.4753],[0.2526,0.4479],[0.2573,0.4205],[0.2725,0.3944],[0.2999,0.3719],[0.3301,0.3512],[0.3639,0.3317],[0.377,0.2783],[0.4382,0.2678]],"facePoints":{"leftEye":[[0.3613,0.384],[0.3884,0.3756],[0.4245,0.3756],[0.4516,0.384],[0.4245,0.3923],[0.3884,0.3923]],"rightEye":[[0.5845,0.3897],[0.61,0.3804],[0.644,0.3804],[0.6695,0.3897],[0.644,0.3989],[0.61,0.3989]],"leftBrow":[[0.3523,0.358],[0.3884,0.3485],[0.4245,0.3485],[0.4607,0.3566]],"rightBrow":[[0.576,0.3638],[0.61,0.3549],[0.644,0.3549],[0.678,0.3625]],"nose":[[0.5167,0.3868],[0.5167,0.467],[0.4595,0.4559],[0.574,0.4559],[0.5167,0.4759]],"lips":[[0.4219,0.5224],[0.4546,0.5055],[0.4874,0.4982],[0.5037,0.504],[0.5201,0.4982],[0.5528,0.5055],[0.5855,0.5224],[0.5446,0.5467],[0.5037,0.5491],[0.4628,0.5467]]},"headBox":{"nx1":0.16153028692879914,"ny1":0.12858851674641147,"nx2":0.8799149840595112,"ny2":0.6130382775119617}}"#

private func check(_ extra: String) throws -> ImageCheck {
    let json = #"{"imageId":"i","passed":true,"type":"human","checks":{"oneFaceFrontFacing":true,"sharpAndLit":true,"noText":true},"reasons":[]"# + extra + "}"
    return try JSONDecoder().decode(ImageCheck.self, from: Data(json.utf8))
}

struct FaceMeshTests {
    @Test func decodesTheV03FieldsFromTheCheckAnswer() throws {
        let geo = String(companionGeometry.dropFirst().dropLast())
        let c = try check("," + geo)
        #expect(c.faceOutline?.count == 32)
        #expect(c.facePoints?.leftEye.count == 6)
        #expect(c.facePoints?.lips.count == 10)
        #expect(c.headBox?.nx1 != nil)
        // an older server answer (no V03 fields, headBox null) still decodes
        let old = try check(#","headBox":null,"ms":2100"#)
        #expect(old.faceOutline == nil && old.facePoints == nil && old.headBox == nil)
    }

    @Test func buildsTheFigmaLowPolyNet() throws {
        // dyno Figma V03 526:15314: 12–20 points (crown, temples, brows, eyes, nose, cheeks, mouth, chin)
        let c = try check("," + String(companionGeometry.dropFirst().dropLast()))
        let mesh = try #require(FaceMesh.make(outline: c.faceOutline, points: c.facePoints, headBox: c.headBox))
        #expect((12...20).contains(mesh.points.count), "points \(mesh.points.count)")
        #expect((20...60).contains(mesh.edges.count), "edges \(mesh.edges.count)")
        #expect(mesh.hull.count >= 6)
        // the eye centres are vertices (the live SAM eye boxes for this photo)
        let le = CGPoint(x: 0.4065, y: 0.384), re = CGPoint(x: 0.627, y: 0.3897)
        #expect(mesh.points.contains { hypot($0.x - le.x, $0.y - le.y) < 0.01 })
        #expect(mesh.points.contains { hypot($0.x - re.x, $0.y - re.y) < 0.01 })
        // every edge joins two different points, no duplicates
        #expect(Set(mesh.edges).count == mesh.edges.count && mesh.edges.allSatisfy { $0.a != $0.b })
    }

    @Test func fallsBackToANetInTheHeadBoxWithoutAnOutline() throws {
        let box = ImageHeadBox(nx1: 0.2, ny1: 0.1, nx2: 0.8, ny2: 0.6)
        let mesh = try #require(FaceMesh.make(outline: nil, points: nil, headBox: box))
        #expect((12...20).contains(mesh.points.count))
        for p in mesh.points { #expect(p.x > 0.2 && p.x < 0.8 && p.y > 0.1 && p.y < 0.6) }
        #expect(FaceMesh.make(outline: nil, points: nil, headBox: nil) == nil)
        #expect(FaceMesh.make(outline: [[0.5, 0.5]], points: nil, headBox: ImageHeadBox(nx1: nil, ny1: nil, nx2: nil, ny2: nil)) == nil)
    }

    @Test func dropsOutOfRangePoints() throws {
        let outline = (0..<32).map { i -> [Double] in
            let a = Double(i) / 32 * 2 * .pi
            return [0.5 + 0.2 * cos(a), 0.4 + 0.25 * sin(a)]
        } + [[1.7, 0.5], [-0.2, 0.1]]
        let mesh = try #require(FaceMesh.make(outline: outline, points: nil, headBox: nil))
        #expect(mesh.points.count >= 12)
        #expect(mesh.points.allSatisfy { (0...1).contains($0.x) && (0...1).contains($0.y) })
    }

    @Test func mapsImageFractionsLikeScaledToFill() {
        // a 941 × 1672 photo in a 342 × 240 frame: width fills, the middle band shows
        let view = CGSize(width: 342, height: 240), image = CGSize(width: 941, height: 1672)
        let centre = FaceMesh.aspectFill(CGPoint(x: 0.5, y: 0.5), image: image, in: view)
        #expect(abs(centre.x - 171) < 0.01 && abs(centre.y - 120) < 0.01)
        let left = FaceMesh.aspectFill(CGPoint(x: 0, y: 0.5), image: image, in: view)
        #expect(abs(left.x) < 0.01)
        let top = FaceMesh.aspectFill(CGPoint(x: 0.5, y: 0), image: image, in: view)
        #expect(top.y < -200, "the top of a tall photo is cropped above the frame")
    }

    @Test func delaunayCoversASquareWithTwoTriangles() {
        let t = delaunay([CGPoint(x: 0, y: 0), CGPoint(x: 1, y: 0), CGPoint(x: 1, y: 1), CGPoint(x: 0, y: 1)])
        #expect(t.count == 2)
    }
}
