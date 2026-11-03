import CoreGraphics

/// V03 face scan (Chunsik pentagon r02, ./_qa-scripts/genita-splash/mesh; dyno Figma V03 526:15314):
/// a whole-face net — a 12-point oval rim from the hairline to the chin and 22 points inside — joined by one fixed
/// set of triangles, so a person, an animal and a character all read the same. The points follow r02's rules from
/// four detector outputs: the SAM 3.1 face outline, the two SAM eye boxes, the SAM mouth box and the nose tip
/// (PREP_API.md). Which points and which triangles is one value (`FaceNetLayout`), so a design revision swaps it.
/// Geometry only: nothing here identifies anyone.
public struct FacePoints: Codable, Equatable, Sendable {
    public var leftEye: [[Double]]
    public var rightEye: [[Double]]
    public var leftBrow: [[Double]]
    public var rightBrow: [[Double]]
    public var nose: [[Double]]
    public var lips: [[Double]]
}

/// The SAM head box as fractions of the image (the server's `headBox`; pixel fields are ignored).
public struct ImageHeadBox: Codable, Equatable, Sendable {
    public var nx1: Double?
    public var ny1: Double?
    public var nx2: Double?
    public var ny2: Double?
}

/// r02's inputs, as fractions of the image: the face oval and the eye / nose / mouth anchors.
public struct FaceAnchors: Equatable, Sendable {
    /// centre and radii of the face oval (hairline → chin, no hair)
    public var cx, cy, rx, ry: CGFloat
    /// left eye as seen in the image: [outer, inner] ends at the box's middle height; right eye: [inner, outer]
    public var eyeL: [CGPoint], eyeR: [CGPoint]
    public var nose: CGPoint
    /// mouth box: left / right ends at its middle height, top and bottom
    public var mouthL: CGPoint, mouthR: CGPoint, mouthT: CGFloat, mouthB: CGFloat
}

/// A design revision of the net: point names, the rules that place them, and the fixed triangles.
public struct FaceNetLayout: Sendable {
    public var names: [String]
    public var place: @Sendable (FaceAnchors) -> [CGPoint]
    public var tris: [[Int]]

    /// r02 (11/4 03:0x): 12 rim points every 30° from the hairline centre, 22 inside; TRIS = the r02 page's Delaunay
    /// on its human layout, pinned (54 triangles).
    public static let r02 = FaceNetLayout(
        names: ["rim 0 hairline", "rim 1", "rim 2 temple right", "rim 3 cheekbone right", "rim 4", "rim 5 jaw right", "rim 6 chin",
                "rim 7 jaw left", "rim 8", "rim 9 cheekbone left", "rim 10 temple left", "rim 11",
                "forehead", "forehead left", "forehead right", "brow left outer", "brow left inner", "brow right inner", "brow right outer",
                "eye left outer", "eye left inner", "eye right inner", "eye right outer", "nose bridge", "nose tip", "nostril left",
                "nostril right", "mouth left", "upper lip", "mouth right", "lower lip", "cheek left", "cheek right", "chin"],
        place: { a in
            var p: [CGPoint] = (0..<12).map { i in
                let d = Double(i) * 30 * Double.pi / 180
                return CGPoint(x: a.cx + a.rx * sin(d), y: a.cy - a.ry * cos(d))
            }
            let eyeY = (a.eyeL[0].y + a.eyeL[1].y + a.eyeR[0].y + a.eyeR[1].y) / 4
            let fh = 2 * a.ry, eyeW = a.eyeL[1].x - a.eyeL[0].x
            let browY = eyeY - 0.14 * fh
            let top = a.cy - a.ry
            let fy = top + 0.45 * (browY - top)
            let inner = a.eyeR[0].x - a.eyeL[1].x
            let mouthX = (a.mouthL.x + a.mouthR.x) / 2
            p += [
                CGPoint(x: a.cx, y: fy), CGPoint(x: a.cx - 0.5 * a.rx, y: fy + 0.01), CGPoint(x: a.cx + 0.5 * a.rx, y: fy + 0.01),
                CGPoint(x: a.eyeL[0].x - 0.15 * eyeW, y: browY), CGPoint(x: a.eyeL[1].x, y: browY + 0.004),
                CGPoint(x: a.eyeR[0].x, y: browY + 0.004), CGPoint(x: a.eyeR[1].x + 0.15 * eyeW, y: browY),
                a.eyeL[0], a.eyeL[1], a.eyeR[0], a.eyeR[1],
                CGPoint(x: (a.eyeL[1].x + a.eyeR[0].x) / 2, y: eyeY + 0.03 * fh), a.nose,
                CGPoint(x: a.nose.x - 0.4 * inner, y: a.nose.y - 0.012), CGPoint(x: a.nose.x + 0.4 * inner, y: a.nose.y - 0.012),
                a.mouthL, CGPoint(x: mouthX, y: a.mouthT), a.mouthR, CGPoint(x: mouthX, y: a.mouthB),
                CGPoint(x: (a.cx - a.rx + a.eyeL[0].x) / 2, y: a.nose.y), CGPoint(x: (a.cx + a.rx + a.eyeR[1].x) / 2, y: a.nose.y),
                CGPoint(x: (mouthX + a.cx) / 2, y: (a.mouthB + a.cy + a.ry) / 2),
            ]
            return p
        },
        tris: [[0,1,12], [0,11,12], [11,12,13], [1,12,14], [10,11,15], [11,13,15], [12,13,16], [13,15,16], [12,14,17], [12,16,17], [1,2,18], [1,14,18], [14,17,18], [9,10,19], [10,15,19], [15,16,19], [16,19,20], [2,3,22], [2,18,22], [17,18,22], [17,21,22], [16,17,23], [17,21,23], [16,20,23], [19,20,25], [20,23,25], [23,24,25], [21,22,26], [21,23,26], [23,24,26], [7,8,27], [24,26,28], [24,25,28], [25,27,28], [4,5,29], [26,28,29], [7,27,30], [27,28,30], [28,29,30], [8,9,31], [9,19,31], [19,25,31], [25,27,31], [8,27,31], [3,4,32], [3,22,32], [22,26,32], [4,29,32], [26,29,32], [6,7,33], [7,30,33], [5,6,33], [5,29,33], [29,30,33]])
}

extension FaceNetLayout {
    /// For a face too small on the card for r02's 34 points (lead 11/4: under 90 pt tall, or two points closer than
    /// 6 pt): the same 12-point rim, the two eye centres, the nose tip and the mouth corners — 17 points, 20 triangles
    /// (Delaunay on r02's human layout, pinned).
    public static let r02Small = FaceNetLayout(
        names: Array(r02.names.prefix(12)) + ["eye left", "eye right", "nose tip", "mouth left", "mouth right"],
        place: { a in
            let full = r02.place(a)
            let mid = { (i: Int, j: Int) in CGPoint(x: (full[i].x + full[j].x) / 2, y: (full[i].y + full[j].y) / 2) }
            return Array(full.prefix(12)) + [mid(19, 20), mid(21, 22), full[24], full[27], full[29]]
        },
        tris: [[9,10,12],[0,11,12],[10,11,12],[2,3,13],[0,1,13],[0,12,13],[1,2,13],[12,13,14],[6,7,15],[7,8,15],[8,9,15],[9,12,15],
               [12,14,15],[4,5,16],[3,4,16],[3,13,16],[13,14,16],[5,6,16],[6,15,16],[14,15,16]])
}

public struct FaceMesh: Equatable, Sendable {
    public struct Edge: Hashable, Sendable {
        public let a: Int
        public let b: Int
        init(_ i: Int, _ j: Int) { a = min(i, j); b = max(i, j) }
    }
    /// the placed points, fractions of the image (0 = left / top), in layout order
    public var points: [CGPoint]
    /// triangles to fill (no repeats)
    public var triangles: [[Int]]
    /// every triangle side once
    public var edges: [Edge]

    /// nil when there is neither a SAM face outline (≥ 8 points) nor a usable head box.
    public static func make(outline raw: [[Double]]?, points: FacePoints?, headBox: ImageHeadBox?,
                            layout: FaceNetLayout = .r02) -> FaceMesh? {
        guard let anchors = anchors(outline: raw, points: points, headBox: headBox) else { return nil }
        let all = layout.place(anchors).map { CGPoint(x: min(1, max(0, $0.x)), y: min(1, max(0, $0.y))) }
        var seen = Set<[Int]>()
        let tris = layout.tris.filter { $0.count == 3 && $0.allSatisfy { $0 < all.count } && seen.insert($0.sorted()).inserted }
        var edgeSeen = Set<Edge>(), edges: [Edge] = []
        for t in tris { for (i, j) in [(t[0], t[1]), (t[1], t[2]), (t[0], t[2])] where edgeSeen.insert(Edge(i, j)).inserted { edges.append(Edge(i, j)) } }
        return FaceMesh(points: all, triangles: tris, edges: edges)
    }

    /// eye line − this × face height = the hairline, when SAM's face mask reaches into the hair
    static let hairlineCut: CGFloat = 0.34

    /// r02's inputs from the check answer. The oval: SAM's face outline (centre = its centroid, radii = its extent);
    /// if the mask reached into the hair, its top is cut to eye line − 0.34 × face height. No outline: an oval in the
    /// lower SAM head box. No eye / mouth boxes: the r02 human layout's proportions inside the oval.
    static func anchors(outline raw: [[Double]]?, points: FacePoints?, headBox: ImageHeadBox?) -> FaceAnchors? {
        let pts = { (list: [[Double]]?) -> [CGPoint] in
            (list ?? []).compactMap { $0.count == 2 && (0...1).contains($0[0]) && (0...1).contains($0[1]) ? CGPoint(x: $0[0], y: $0[1]) : nil }
        }
        let le = pts(points?.leftEye), re = pts(points?.rightEye), lips = pts(points?.lips), nose = pts(points?.nose)
        let mid = { (g: [CGPoint]) -> CGFloat in g.map(\.y).reduce(0, +) / CGFloat(g.count) }
        let hasFeatures = le.count >= 2 && re.count >= 2 && lips.count >= 3

        var cx: CGFloat, cy: CGFloat, rx: CGFloat, ry: CGFloat
        let outline = convexHull(pts(raw))
        if outline.count >= 8 {
            var top = outline.map(\.y).min()!
            let bottom = outline.map(\.y).max()!, minX = outline.map(\.x).min()!, maxX = outline.map(\.x).max()!
            if hasFeatures {
                // hairline = eye line − 0.34 × face height (face height = bottom − hairline); r02 said 0.30, the lead
                // raised it 11/4 03:0x so the net covers more forehead (no hair came back on the four live photos)
                let eyeY = (mid(le) + mid(re)) / 2
                top = max(top, (eyeY - hairlineCut * bottom) / (1 - hairlineCut))
            }
            // centre x = the outline's area centroid (≈ the mask's)
            var a2: CGFloat = 0, sx: CGFloat = 0
            for i in 0..<outline.count {
                let p = outline[i], q = outline[(i + 1) % outline.count], c = p.x * q.y - q.x * p.y
                a2 += c; sx += (p.x + q.x) * c
            }
            cx = abs(a2) > 1e-9 ? sx / (3 * a2) : (minX + maxX) / 2
            cy = (top + bottom) / 2; ry = (bottom - top) / 2; rx = (maxX - minX) / 2
        } else {
            guard let b = headBox, let x1 = b.nx1, let y1 = b.ny1, let x2 = b.nx2, let y2 = b.ny2, x2 - x1 > 0.02, y2 - y1 > 0.02 else { return nil }
            cx = (x1 + x2) / 2; cy = y1 + (y2 - y1) * 0.6; rx = (x2 - x1) * 0.36; ry = (y2 - y1) * 0.38
        }
        guard rx > 0.005, ry > 0.005 else { return nil }
        let top = cy - ry, fh = 2 * ry
        let at = { (dx: CGFloat, fy: CGFloat) in CGPoint(x: cx + rx * dx, y: top + fh * fy) }

        if hasFeatures {
            let ly = mid(le), ry2 = mid(re)
            let eyeL = [CGPoint(x: le.map(\.x).min()!, y: ly), CGPoint(x: le.map(\.x).max()!, y: ly)]
            let eyeR = [CGPoint(x: re.map(\.x).min()!, y: ry2), CGPoint(x: re.map(\.x).max()!, y: ry2)]
            let my = mid(lips)
            let mouthL = CGPoint(x: lips.map(\.x).min()!, y: my), mouthR = CGPoint(x: lips.map(\.x).max()!, y: my)
            let eyeY = (ly + ry2) / 2
            // nose tip from SAM's nose (server point 1), else 60 % of the way from the eye line to the mouth line
            let tip = nose.count >= 2 ? nose[1] : CGPoint(x: (eyeL[1].x + eyeR[0].x) / 2, y: eyeY + 0.6 * (my - eyeY))
            return FaceAnchors(cx: cx, cy: cy, rx: rx, ry: ry, eyeL: eyeL, eyeR: eyeR, nose: tip,
                               mouthL: mouthL, mouthR: mouthR, mouthT: lips.map(\.y).min()!, mouthB: lips.map(\.y).max()!)
        }
        // r02 human layout, relative to its oval: eyes at 35.5 % of the face height, nose 57 %, mouth 74 %
        return FaceAnchors(cx: cx, cy: cy, rx: rx, ry: ry,
                           eyeL: [at(-0.61, 0.355), at(-0.23, 0.355)], eyeR: [at(0.25, 0.355), at(0.61, 0.355)],
                           nose: at(0, 0.57), mouthL: at(-0.33, 0.74), mouthR: at(0.29, 0.74),
                           mouthT: top + fh * 0.69, mouthB: top + fh * 0.81)
    }

    /// Small faces read as a blob under r02: on a card smaller than 90 pt of face, or with two points closer than
    /// 6 pt, the sparse r02Small net is used instead (`full` and `small` from the same answer).
    public static func fitted(full: FaceMesh, small: FaceMesh?, image: CGSize, in view: CGSize,
                              minFaceHeight: CGFloat = 90, minGap: CGFloat = 6) -> FaceMesh {
        guard let small else { return full }
        let p = full.points.map { aspectFill($0, image: image, in: view) }
        let faceHeight = (p.map(\.y).max() ?? 0) - (p.map(\.y).min() ?? 0)
        var gap = CGFloat.infinity
        for i in 0..<p.count { for j in (i + 1)..<p.count { gap = min(gap, hypot(p[i].x - p[j].x, p[i].y - p[j].y)) } }
        return faceHeight < minFaceHeight || gap < minGap ? small : full
    }

    /// Image fraction → view point for an image shown `scaledToFill` (centered crop) in `view`.
    public static func aspectFill(_ p: CGPoint, image: CGSize, in view: CGSize) -> CGPoint {
        guard image.width > 0, image.height > 0 else { return CGPoint(x: p.x * view.width, y: p.y * view.height) }
        let s = max(view.width / image.width, view.height / image.height)
        let ox = (view.width - image.width * s) / 2, oy = (view.height - image.height * s) / 2
        return CGPoint(x: p.x * image.width * s + ox, y: p.y * image.height * s + oy)
    }

    /// `count` points evenly spaced (by arc length) round a closed contour, starting at its top point and going
    /// clockwise on screen — for a layout that wants rim points along SAM's real outline instead of the oval.
    public static func evenRim(_ contour: [CGPoint], count: Int) -> [CGPoint] {
        guard contour.count >= 3, count > 0 else { return [] }
        let start = contour.indices.min { contour[$0].y < contour[$1].y }!
        var loop = Array(contour[start...] + contour[..<start])
        let area = zip(loop, loop.dropFirst() + [loop[0]]).reduce(0) { $0 + ($1.0.x * $1.1.y - $1.1.x * $1.0.y) }
        if area < 0 { loop = [loop[0]] + loop.dropFirst().reversed() }
        let segs = zip(loop, loop.dropFirst() + [loop[0]]).map { hypot($1.x - $0.x, $1.y - $0.y) }
        let total = segs.reduce(0, +)
        guard total > 0 else { return Array(repeating: loop[0], count: count) }
        var out: [CGPoint] = [], i = 0, walked: CGFloat = 0
        for k in 0..<count {
            let target = total * CGFloat(k) / CGFloat(count)
            while i < segs.count - 1 && walked + segs[i] < target { walked += segs[i]; i += 1 }
            let a = loop[i], b = loop[(i + 1) % loop.count]
            let t = segs[i] > 0 ? (target - walked) / segs[i] : 0
            out.append(CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t))
        }
        return out
    }
}

/// Andrew's monotone chain; clockwise on screen (y down).
func convexHull(_ input: [CGPoint]) -> [CGPoint] {
    let p = input.sorted { ($0.x, $0.y) < ($1.x, $1.y) }
    guard p.count >= 3 else { return p }
    func cross(_ o: CGPoint, _ a: CGPoint, _ b: CGPoint) -> CGFloat { (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x) }
    var lower: [CGPoint] = [], upper: [CGPoint] = []
    for q in p { while lower.count >= 2 && cross(lower[lower.count - 2], lower[lower.count - 1], q) <= 0 { lower.removeLast() }; lower.append(q) }
    for q in p.reversed() { while upper.count >= 2 && cross(upper[upper.count - 2], upper[upper.count - 1], q) <= 0 { upper.removeLast() }; upper.append(q) }
    return Array(lower.dropLast() + upper.dropLast())
}
