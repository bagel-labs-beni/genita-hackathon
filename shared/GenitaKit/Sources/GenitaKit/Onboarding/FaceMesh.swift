import CoreGraphics

/// V03 face scan (dyno Figma V03 526:15314, Chelsea 11/4 02:31): a low-poly net of 12–20 points over the uploaded
/// photo — crown, temples, brows, eyes, nose, cheeks, mouth, chin — drawn as the scan line comes down.
/// Points come from the check answer (SAM 3.1 face outline + eye/mouth boxes, PREP_API.md); without them the net is
/// laid into the SAM head box. Geometry only: nothing here identifies anyone.
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

public struct FaceMesh: Equatable, Sendable {
    public struct Edge: Hashable, Sendable {
        public let a: Int
        public let b: Int
        init(_ i: Int, _ j: Int) { a = min(i, j); b = max(i, j) }
    }
    /// the net's vertices, fractions of the image (0 = left / top); 12…20
    public var points: [CGPoint]
    /// Delaunay edges between them
    public var edges: [Edge]
    /// the light fill: convex hull of the points
    public var hull: [CGPoint]

    /// nil when there is neither an outline (≥ 8 points) nor a usable head box.
    public static func make(outline raw: [[Double]]?, points: FacePoints?, headBox: ImageHeadBox?) -> FaceMesh? {
        let pts = { (list: [[Double]]?) -> [CGPoint] in
            (list ?? []).compactMap { $0.count == 2 && (0...1).contains($0[0]) && (0...1).contains($0[1]) ? CGPoint(x: $0[0], y: $0[1]) : nil }
        }
        // the contour: SAM's outline (hull, so a hair notch doesn't bite in), else an oval in the head box
        var contour = convexHull(pts(raw))
        if contour.count < 8 {
            guard let b = headBox, let x1 = b.nx1, let y1 = b.ny1, let x2 = b.nx2, let y2 = b.ny2, x2 - x1 > 0.02, y2 - y1 > 0.02 else { return nil }
            let c = CGPoint(x: (x1 + x2) / 2, y: y1 + (y2 - y1) * 0.52)
            let rx = (x2 - x1) * 0.38, ry = (y2 - y1) * 0.44
            contour = (0..<16).map { i in
                let a = -Double.pi / 2 + 2 * Double.pi * Double(i) / 16
                return CGPoint(x: c.x + rx * cos(a), y: c.y + ry * sin(a))
            }
        }
        // 8 rim points, evenly round the contour from its top (crown, temples, cheeks, jaw, chin)
        let top = contour.indices.min { contour[$0].y < contour[$1].y }!
        let rim = (0..<8).map { contour[(top + $0 * contour.count / 8) % contour.count] }
        let minX = contour.map(\.x).min()!, maxX = contour.map(\.x).max()!
        let minY = contour.map(\.y).min()!, maxY = contour.map(\.y).max()!
        let w = maxX - minX, h = maxY - minY

        var inner: [CGPoint] = []
        let centre = { (g: [CGPoint]) -> CGPoint? in
            g.isEmpty ? nil : CGPoint(x: g.map(\.x).reduce(0, +) / CGFloat(g.count), y: g.map(\.y).reduce(0, +) / CGFloat(g.count))
        }
        if let f = points, let le = centre(pts(f.leftEye)), let re = centre(pts(f.rightEye)) {
            // brows: both ends; eyes: centres; nose: tip; mouth: corners + the lower lip
            for brow in [pts(f.leftBrow), pts(f.rightBrow)] where brow.count >= 2 { inner += [brow.first!, brow.last!] }
            inner += [le, re]
            let nose = pts(f.nose)
            if nose.count >= 2 { inner.append(nose[1]) }
            let lips = pts(f.lips)
            if lips.count >= 3 {
                // the two corners and the lowest point of the lower lip
                inner += [lips.min { $0.x < $1.x }!, lips.max { $0.x < $1.x }!, lips.max { $0.y < $1.y }!]
            }
        } else {
            // no features: eyes at 40 %, nose at 60 %, mouth at 76 % of the face, like a front-facing portrait
            inner = [CGPoint(x: minX + w * 0.32, y: minY + h * 0.4), CGPoint(x: minX + w * 0.68, y: minY + h * 0.4),
                     CGPoint(x: minX + w * 0.5, y: minY + h * 0.6),
                     CGPoint(x: minX + w * 0.38, y: minY + h * 0.76), CGPoint(x: minX + w * 0.62, y: minY + h * 0.76)]
        }
        // keep the net small and clean: drop inner points that crowd the rim or each other
        let gap = min(w, h) * 0.06
        var all = rim
        for p in inner where all.allSatisfy({ hypot($0.x - p.x, $0.y - p.y) > gap }) { all.append(p) }
        let tris = delaunay(all)
        var edges = Set<Edge>()
        for (i, j, k) in tris { edges.insert(Edge(i, j)); edges.insert(Edge(j, k)); edges.insert(Edge(k, i)) }
        return FaceMesh(points: all, edges: edges.sorted { ($0.a, $0.b) < ($1.a, $1.b) }, hull: convexHull(all))
    }

    /// Image fraction → view point for an image shown `scaledToFill` (centered crop) in `view`.
    public static func aspectFill(_ p: CGPoint, image: CGSize, in view: CGSize) -> CGPoint {
        guard image.width > 0, image.height > 0 else { return CGPoint(x: p.x * view.width, y: p.y * view.height) }
        let s = max(view.width / image.width, view.height / image.height)
        let ox = (view.width - image.width * s) / 2, oy = (view.height - image.height * s) / 2
        return CGPoint(x: p.x * image.width * s + ox, y: p.y * image.height * s + oy)
    }
}

// MARK: - geometry

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

/// Bowyer–Watson Delaunay triangulation; triangles as index triples into `p`.
func delaunay(_ p: [CGPoint]) -> [(Int, Int, Int)] {
    guard p.count >= 3 else { return [] }
    let minX = p.map(\.x).min()!, maxX = p.map(\.x).max()!, minY = p.map(\.y).min()!, maxY = p.map(\.y).max()!
    let d = max(maxX - minX, maxY - minY) * 20 + 1
    let mx = (minX + maxX) / 2, my = (minY + maxY) / 2
    let pts = p + [CGPoint(x: mx - d, y: my - d), CGPoint(x: mx, y: my + d), CGPoint(x: mx + d, y: my - d)]
    let n = p.count
    struct Tri { var a: Int, b: Int, c: Int; var cx: CGFloat, cy: CGFloat, r2: CGFloat }
    func tri(_ a: Int, _ b: Int, _ c: Int) -> Tri? {
        let A = pts[a], B = pts[b], C = pts[c]
        let dd = 2 * (A.x * (B.y - C.y) + B.x * (C.y - A.y) + C.x * (A.y - B.y))
        guard abs(dd) > 1e-12 else { return nil }
        let a2 = A.x * A.x + A.y * A.y, b2 = B.x * B.x + B.y * B.y, c2 = C.x * C.x + C.y * C.y
        let ux = (a2 * (B.y - C.y) + b2 * (C.y - A.y) + c2 * (A.y - B.y)) / dd
        let uy = (a2 * (C.x - B.x) + b2 * (A.x - C.x) + c2 * (B.x - A.x)) / dd
        return Tri(a: a, b: b, c: c, cx: ux, cy: uy, r2: (A.x - ux) * (A.x - ux) + (A.y - uy) * (A.y - uy))
    }
    var tris: [Tri] = [tri(n, n + 1, n + 2)!]
    for i in 0..<n {
        let q = pts[i]
        var bad: [Tri] = [], keep: [Tri] = []
        for t in tris {
            if (q.x - t.cx) * (q.x - t.cx) + (q.y - t.cy) * (q.y - t.cy) < t.r2 { bad.append(t) } else { keep.append(t) }
        }
        var count: [FaceMesh.Edge: Int] = [:]
        for t in bad { for e in [FaceMesh.Edge(t.a, t.b), FaceMesh.Edge(t.b, t.c), FaceMesh.Edge(t.c, t.a)] { count[e, default: 0] += 1 } }
        tris = keep
        for (e, c) in count where c == 1 { if let t = tri(e.a, e.b, i) { tris.append(t) } }
    }
    return tris.filter { $0.a < n && $0.b < n && $0.c < n }.map { ($0.a, $0.b, $0.c) }
}
