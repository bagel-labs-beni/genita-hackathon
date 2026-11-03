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

    @Test func buildsTheR02WholeFaceNetFromSAMPoints() throws {
        let c = try check("," + String(companionGeometry.dropFirst().dropLast()))
        let mesh = try #require(FaceMesh.make(outline: c.faceOutline, points: c.facePoints, headBox: c.headBox))
        // r02: 12 rim + 22 inside, the pinned 54 triangles
        #expect(mesh.points.count == 34 && FaceNetLayout.r02.names.count == 34)
        #expect(mesh.triangles.count == 54)
        #expect(mesh.edges.count == 87)
        // eye ends sit on SAM's eye box: "eye left outer" = the box's left end, at its middle height
        let i = FaceNetLayout.r02.names.firstIndex(of: "eye left outer")!
        #expect(abs(mesh.points[i].x - 0.3613) < 0.001 && abs(mesh.points[i].y - 0.384) < 0.001)
        // whole face, no hair: nothing above the SAM face outline's top or below its chin
        let ys = c.faceOutline!.map { $0[1] }
        #expect(mesh.points.allSatisfy { $0.y >= ys.min()! - 0.001 && $0.y <= ys.max()! + 0.001 })
    }

    @Test func aMaskThatReachesIntoTheHairIsCutAtTheHairline() throws {
        // an outline from y 0.05 (hair) to 0.65 (chin), eyes at 0.38: hairline = (0.38 − 0.34 × 0.65) / 0.66
        let outline = (0..<32).map { k -> [Double] in
            let a = Double(k) / 32 * 2 * .pi
            return [0.5 + 0.25 * cos(a), 0.35 + 0.3 * sin(a)]
        }
        let eye = { (x: Double) in [[x - 0.04, 0.38], [x, 0.375], [x + 0.04, 0.38], [x, 0.385]] }
        let fp = FacePoints(leftEye: eye(0.4), rightEye: eye(0.6), leftBrow: [], rightBrow: [], nose: [],
                            lips: [[0.44, 0.52], [0.5, 0.5], [0.56, 0.52], [0.5, 0.54]])
        let mesh = try #require(FaceMesh.make(outline: outline, points: fp, headBox: nil))
        #expect(abs(mesh.points[0].y - (0.38 - 0.34 * 0.65) / 0.66) < 0.002, "rim 0 at the hairline, not the hair")
        // no nose from SAM: 60 % of the way from the eye line to the mouth line
        let tip = mesh.points[FaceNetLayout.r02.names.firstIndex(of: "nose tip")!]
        #expect(abs(tip.y - (0.38 + 0.6 * (0.52 - 0.38))) < 0.002)
    }

    @Test func aSmallFaceOnTheCardGetsTheSparseNet() throws {
        let c = try check("," + String(companionGeometry.dropFirst().dropLast()))
        let full = try #require(FaceMesh.make(outline: c.faceOutline, points: c.facePoints, headBox: c.headBox))
        let small = try #require(FaceMesh.make(outline: c.faceOutline, points: c.facePoints, headBox: c.headBox, layout: .r02Small))
        #expect(small.points.count == 17 && small.triangles.count == 20)
        // the review photo on the 342 × 240 V03 card: a big face, the full net
        let image = CGSize(width: 941, height: 1672)
        #expect(FaceMesh.fitted(full: full, small: small, image: image, in: CGSize(width: 342, height: 240)) == full)
        // the same photo on a card a quarter the size: the face is under 90 pt, the sparse net
        #expect(FaceMesh.fitted(full: full, small: small, image: image, in: CGSize(width: 86, height: 60)) == small)
    }

    @Test func aLayoutIsOneSwappableValue() throws {
        let square = FaceNetLayout(names: ["a", "b", "c", "d"],
                                   place: { a in [CGPoint(x: a.cx - a.rx, y: a.cy - a.ry), CGPoint(x: a.cx + a.rx, y: a.cy - a.ry),
                                                  CGPoint(x: a.cx + a.rx, y: a.cy + a.ry), CGPoint(x: a.cx - a.rx, y: a.cy + a.ry)] },
                                   tris: [[0, 1, 2], [0, 2, 3], [2, 1, 0]])
        let mesh = try #require(FaceMesh.make(outline: nil, points: nil, headBox: ImageHeadBox(nx1: 0.2, ny1: 0.1, nx2: 0.8, ny2: 0.6), layout: square))
        #expect(mesh.triangles == [[0, 1, 2], [0, 2, 3]], "a repeated triangle is filled once")
        #expect(mesh.edges.count == 5)
    }

    @Test func evenRimSpacesPointsByArcLengthFromTheTopClockwise() {
        // a 2:1 rectangle given counter-clockwise, starting bottom-left
        let rect = [CGPoint(x: 0, y: 1), CGPoint(x: 2, y: 1), CGPoint(x: 2, y: 0), CGPoint(x: 0, y: 0)]
        let rim = FaceMesh.evenRim(rect, count: 6)
        #expect(rim.count == 6)
        #expect(rim[0].y == 0, "starts at the top (the first top-most point: the top-right corner here)")
        #expect(rim[0].x == 2 && abs(rim[1].x - 2) < 1e-9 && abs(rim[1].y - 1) < 1e-9, "then down the right side: clockwise on screen")
        // equal steps: perimeter 6, step 1
        for i in 0..<6 { let a = rim[i], b = rim[(i + 1) % 6]; #expect(abs(abs(b.x - a.x) + abs(b.y - a.y) - 1) < 1e-9) }
    }

    @Test func fallsBackToAnOvalInTheHeadBoxWithoutAnOutline() throws {
        let box = ImageHeadBox(nx1: 0.2, ny1: 0.1, nx2: 0.8, ny2: 0.6)
        let mesh = try #require(FaceMesh.make(outline: nil, points: nil, headBox: box))
        #expect(mesh.points.count == 34)
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
        #expect(mesh.points.allSatisfy { (0...1).contains($0.x) && (0...1).contains($0.y) })
        #expect(mesh.points.allSatisfy { $0.x >= 0.29 && $0.x <= 0.71 }, "the stray points are not part of the rim")
    }

    @Test func mapsImageFractionsLikeScaledToFill() {
        // a 941 × 1672 photo in a 342 × 240 frame: width fills, the middle band shows
        let view = CGSize(width: 342, height: 240), image = CGSize(width: 941, height: 1672)
        let centre = FaceMesh.aspectFill(CGPoint(x: 0.5, y: 0.5), image: image, in: view)
        #expect(abs(centre.x - 171) < 0.01 && abs(centre.y - 120) < 0.01)
        let left = FaceMesh.aspectFill(CGPoint(x: 0, y: 0.5), image: image, in: view)
        #expect(abs(left.x) < 0.01)
        let top = FaceMesh.aspectFill(CGPoint(x: 0.5, y: 0), image: image, in: view)
        #expect(abs(top.y - (-183.84)) < 0.01, "the top of a tall photo is cropped above the frame")
    }
}
