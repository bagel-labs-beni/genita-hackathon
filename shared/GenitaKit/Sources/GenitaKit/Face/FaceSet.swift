// L4 face · A companion's face set (prep step `face`): expression stills + viseme stills with
// normalised face/mouth boxes. Loading turns the viseme stills into small mouth patches that sit
// on the neutral still: each patch is cut around its own mouth box, aligned to the neutral by a
// translation search over the skin around the mouth, colour-matched there, and given a feathered
// elliptical edge. A patch whose surroundings still differ after alignment is dropped and the
// shape falls back to its nearest neighbour.

import CoreGraphics
import CoreImage
import Foundation
import ImageIO

/// `face` manifest from GET /v1/companion/prep (PREP_API.md). Boxes are x1,y1,x2,y2 in 0…1 of
/// the image, y down. Image values are file names or URLs.
public struct FaceManifest: Codable, Equatable, Sendable {
    public struct Boxes: Codable, Equatable, Sendable {
        public var face: [Double]?
        public var mouth: [Double]?
    }
    public struct Rejected: Codable, Equatable, Sendable {
        public var key: String
        public var reason: String?
    }
    public var version: Int?
    public var size: [Int]?
    public var faceBox: [Double]
    public var mouthBox: [Double]
    public var images: [String: String]
    public var visemes: [String: String]
    public var boxes: [String: Boxes]?
    public var rejected: [Rejected]?
    /// Option B flow morph data (absent → the key-patch engine).
    public var flow: FaceFlowManifest?

    public init(version: Int?, size: [Int]?, faceBox: [Double], mouthBox: [Double], images: [String: String], visemes: [String: String],
                boxes: [String: Boxes]?, rejected: [Rejected]?, flow: FaceFlowManifest? = nil) {
        self.version = version; self.size = size; self.faceBox = faceBox; self.mouthBox = mouthBox
        self.images = images; self.visemes = visemes; self.boxes = boxes; self.rejected = rejected; self.flow = flow
    }

    enum CodingKeys: String, CodingKey { case version, size, faceBox, mouthBox, images, visemes, boxes, rejected, flow }

    /// A `flow` block this build can't read is dropped (key patches still work), never the whole face.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decodeIfPresent(Int.self, forKey: .version)
        size = try c.decodeIfPresent([Int].self, forKey: .size)
        faceBox = try c.decode([Double].self, forKey: .faceBox)
        mouthBox = try c.decode([Double].self, forKey: .mouthBox)
        images = try c.decode([String: String].self, forKey: .images)
        visemes = try c.decodeIfPresent([String: String].self, forKey: .visemes) ?? [:]
        boxes = try c.decodeIfPresent([String: Boxes].self, forKey: .boxes)
        rejected = try c.decodeIfPresent([Rejected].self, forKey: .rejected)
        flow = try? c.decodeIfPresent(FaceFlowManifest.self, forKey: .flow)
    }
}

public enum FaceExpression: String, CaseIterable, Sendable {
    case neutral, blink, smile, warm

    /// The speaking emotion's base face.
    public init(emotion: String?) {
        switch emotion?.lowercased() ?? "" {
        case "laugh", "laughing", "happy", "joy", "joyful", "excited", "amused", "playful", "cheerful": self = .smile
        case "warm", "affection", "affectionate", "tender", "caring", "loving", "gentle": self = .warm
        default: self = .neutral
        }
    }
}

public enum FaceSetError: Error, Equatable {
    case missingNeutral
    case undecodable(String)
}

/// One viseme's mouth, ready to draw over the neutral still.
public struct FaceMouthPatch: @unchecked Sendable {
    /// Colour-matched pixels, premultiplied, alpha = feathered ellipse.
    public let image: CGImage
    /// Where it goes, in neutral-image pixels (y down).
    public let rect: CGRect
    /// Alignment found (viseme pixels − neutral pixels), full-resolution px.
    public let shift: (dx: Int, dy: Int)
    /// Mean absolute difference (0…1) of the surroundings after alignment and colour match.
    public let surroundDiff: Double
}

public final class FaceSet: @unchecked Sendable {
    public let pixelSize: CGSize
    /// Neutral face and mouth boxes in pixels (y down).
    public let faceBox: CGRect
    public let mouthBox: CGRect
    /// Decoded stills by expression (missing ones are absent; use `image(for:)`).
    public let expressions: [FaceExpression: CGImage]
    /// Alignment of each expression still to the neutral one (pixels, y down).
    public let expressionShift: [FaceExpression: (dx: Int, dy: Int)]
    public let patches: [LipViseme: FaceMouthPatch]
    /// Flow-morph data when prep produced it (option B).
    public let flow: FaceFlowData?
    /// Person (subject) mask from prep (`images.person`, SAM 3.1): head / body motion stays inside it so
    /// the background never moves. Absent → a fixed head-and-shoulders ellipse lock (no on-device ML:
    /// runtime AI is Meta-only).
    public let personMask: CGImage?
    /// What each shape draws after fallbacks (nil = the expression's own mouth).
    public let resolved: [LipViseme: LipViseme?]
    /// Load decisions worth logging (rejections, fallbacks, shifts).
    public let notes: [String]

    /// Nearest shapes, in order, when a viseme image is missing or rejected.
    public static let fallbacks: [LipViseme: [LipViseme]] = [
        .MBP: [.MBP],
        .FV: [.FV, .MBP],
        .TH: [.TH, .L, .CDG, .EI],
        .L: [.L, .TH, .CDG, .EI],
        .WQ: [.WQ, .U, .O],
        .O: [.O, .U, .WQ, .A],
        .EI: [.EI, .CDG, .A],
        .A: [.A, .O, .EI],
        .U: [.U, .WQ, .O],
        .CDG: [.CDG, .EI, .TH, .L],
        .rest: [],
    ]

    /// Shape → drawn patch key, given the shapes that have a patch.
    public static func resolve(available: Set<LipViseme>) -> [LipViseme: LipViseme?] {
        var out: [LipViseme: LipViseme?] = [:]
        for v in LipViseme.allCases {
            out[v] = .some((fallbacks[v] ?? []).first { available.contains($0) })
        }
        return out
    }

    /// Patches whose surroundings still differ by more than this after alignment are dropped.
    public static let maxSurroundDiff = 0.09

    public func image(for e: FaceExpression) -> CGImage {
        expressions[e] ?? expressions[.neutral]!
    }

    public var hasBlink: Bool { expressions[.blink] != nil }

    // MARK: loading

    /// Loads `manifest.json` and its images from a directory.
    public convenience init(directory: URL) throws {
        let manifest = try JSONDecoder().decode(FaceManifest.self, from: Data(contentsOf: directory.appendingPathComponent("manifest.json")))
        try self.init(manifest: manifest) { ref in
            // Only file names inside the directory (a URL's last component), never paths out of it.
            let name = URL(string: ref)?.lastPathComponent ?? (ref as NSString).lastPathComponent
            guard !name.isEmpty, name != "..", name != "." else { throw FaceSetError.undecodable(ref) }
            return try Data(contentsOf: directory.appendingPathComponent(name))
        }
    }

    /// `load` returns the bytes of an image reference from the manifest (file name or URL).
    public init(manifest: FaceManifest, load: (String) throws -> Data) throws {
        guard let neutralRef = manifest.images["neutral"] else { throw FaceSetError.missingNeutral }
        let neutral = try Self.decode(try load(neutralRef), name: "neutral")
        let w = neutral.width, h = neutral.height
        pixelSize = CGSize(width: w, height: h)
        func rect(_ b: [Double]?) -> CGRect? {
            guard let b, b.count == 4, b.allSatisfy(\.isFinite) else { return nil }
            let c = b.map { min(1, max(0, $0)) }
            guard c[2] - c[0] > 0.002, c[3] - c[1] > 0.002 else { return nil }
            return CGRect(x: c[0] * Double(w), y: c[1] * Double(h), width: (c[2] - c[0]) * Double(w), height: (c[3] - c[1]) * Double(h))
        }
        faceBox = rect(manifest.faceBox) ?? CGRect(x: 0, y: 0, width: w, height: h)
        mouthBox = rect(manifest.mouthBox) ?? CGRect(x: Double(w) * 0.4, y: Double(h) * 0.55, width: Double(w) * 0.2, height: Double(h) * 0.03)

        var notes: [String] = []
        let base = PixelBuffer(neutral, width: w, height: h)
        let baseGray = base.analysis()
        var expressions: [FaceExpression: CGImage] = [.neutral: base.makeImage()]
        var exprShift: [FaceExpression: (dx: Int, dy: Int)] = [.neutral: (0, 0)]
        for e in FaceExpression.allCases where e != .neutral {
            guard let ref = manifest.images[e.rawValue] else { notes.append("\(e.rawValue): missing → neutral"); continue }
            do {
                let pix = PixelBuffer(try Self.decode(try load(ref), name: e.rawValue), width: w, height: h)
                let s = Self.align(baseGray, pix.analysis(), around: faceBox, excluding: nil, imageWidth: w)
                expressions[e] = pix.makeImage()
                exprShift[e] = (s.dx, s.dy)
                if s.dx != 0 || s.dy != 0 { notes.append("\(e.rawValue): shift \(s.dx),\(s.dy) px") }
            } catch {
                notes.append("\(e.rawValue): \(error) → neutral")
            }
        }
        self.expressions = expressions
        self.expressionShift = exprShift

        // Patches also cover the smile/warm mouths (aligned) so no expression mouth shows round them.
        var cover = mouthBox
        for e in [FaceExpression.smile, .warm] where expressions[e] != nil {
            guard let m = rect(manifest.boxes?[e.rawValue]?.mouth), let s = exprShift[e] else { continue }
            cover = cover.union(m.offsetBy(dx: CGFloat(-s.dx), dy: CGFloat(-s.dy)))
        }
        var patches: [LipViseme: FaceMouthPatch] = [:]
        for v in LipViseme.shapes {
            guard let ref = manifest.visemes[v.rawValue] else { notes.append("\(v.rawValue): missing"); continue }
            do {
                let pix = PixelBuffer(try Self.decode(try load(ref), name: v.rawValue), width: w, height: h)
                let own = rect(manifest.boxes?[v.rawValue]?.mouth) ?? mouthBox
                guard let patch = Self.makePatch(base: base, baseGray: baseGray, viseme: pix, ownMouth: own, mouth: mouthBox, cover: cover, face: faceBox) else {
                    notes.append("\(v.rawValue): mouth box outside the image"); continue
                }
                if patch.surroundDiff > Self.maxSurroundDiff {
                    notes.append(String(format: "%@: rejected, surroundings differ %.3f after alignment", v.rawValue, patch.surroundDiff))
                    continue
                }
                patches[v] = patch
            } catch {
                notes.append("\(v.rawValue): \(error)")
            }
        }
        self.patches = patches
        var flowData: FaceFlowData?
        if let fm = manifest.flow {
            do { flowData = try FaceFlowData(manifest: fm, stillSize: pixelSize, load: load) } catch { notes.append("flow: \(error) → key patches") }
        }
        self.flow = flowData
        var person: CGImage?   // prep only
        if let ref = manifest.images["person"] {
            do { person = try Self.decode(try load(ref), name: "person") } catch { notes.append("person: \(error) → ellipse layers") }
        }
        personMask = person
        let resolved = Self.resolve(available: Set(patches.keys))
        for v in LipViseme.shapes where resolved[v]! != v {
            notes.append("\(v.rawValue) → \(resolved[v]!.map(\.rawValue) ?? "rest")")
        }
        self.resolved = resolved
        self.notes = notes
    }

    static func decode(_ data: Data, name: String) throws -> CGImage {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil),
              let img = CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
        else { throw FaceSetError.undecodable(name) }
        return img
    }

    // MARK: patch building

    static func makePatch(base: PixelBuffer, baseGray: AnalysisImage, viseme: PixelBuffer, ownMouth: CGRect, mouth: CGRect, cover: CGRect, face: CGRect) -> FaceMouthPatch? {
        let union = ownMouth.union(mouth)
        // Align on the skin above and beside the mouth; below it the jaw moves on purpose.
        let shift = align(baseGray, viseme.analysis(), around: surround(of: union, face: face), excluding: union.insetBy(dx: -union.width * 0.15, dy: -union.height * 0.3), imageWidth: base.width)
        // Colour match over the same surroundings.
        let ring = surround(of: union, face: face)
        let hole = union.insetBy(dx: -union.width * 0.15, dy: -union.height * 0.3)
        var sb = [Double](repeating: 0, count: 6), sv = [Double](repeating: 0, count: 6)
        var n = 0.0
        base.forEach(in: ring, excluding: hole) { x, y in
            let vx = x + shift.dx, vy = y + shift.dy
            guard viseme.contains(vx, vy) else { return }
            for c in 0..<3 {
                let b = Double(base.at(x, y, c)), v = Double(viseme.at(vx, vy, c))
                sb[c] += b; sb[c + 3] += b * b; sv[c] += v; sv[c + 3] += v * v
            }
            n += 1
        }
        var gain = [1.0, 1.0, 1.0], bias = [0.0, 0.0, 0.0]
        if n > 16 {
            for c in 0..<3 {
                let mb = sb[c] / n, mv = sv[c] / n
                let db = max(1, (sb[c + 3] / n - mb * mb).squareRoot()), dv = max(1, (sv[c + 3] / n - mv * mv).squareRoot())
                gain[c] = min(1.25, max(0.8, db / dv))
                bias[c] = mb - gain[c] * mv
            }
        }
        // Surroundings difference after alignment + colour match.
        var diff = 0.0, dn = 0.0
        base.forEach(in: ring, excluding: hole) { x, y in
            let vx = x + shift.dx, vy = y + shift.dy
            guard viseme.contains(vx, vy) else { return }
            for c in 0..<3 {
                let v = Double(viseme.at(vx, vy, c)) * gain[c] + bias[c]
                diff += abs(v - Double(base.at(x, y, c)))
            }
            dn += 3
        }
        let surroundDiff = dn > 0 ? diff / dn / 255 : 1

        // Patch rect: the union mouth with margin, clipped to the image, integral.
        let covered = union.union(cover)
        let r = covered.insetBy(dx: -covered.width * 0.35, dy: -covered.height * 0.8)
            .intersection(CGRect(x: 0, y: 0, width: base.width, height: base.height)).integral
        guard !r.isNull, r.width >= 4, r.height >= 4 else { return nil }
        let pw = Int(r.width), ph = Int(r.height), ox = Int(r.minX), oy = Int(r.minY)
        let shade = localShading(base: base, viseme: viseme, shift: (shift.dx, shift.dy), gain: gain, bias: bias,
                                 rect: r, mouth: union)
        var out = [UInt8](repeating: 0, count: pw * ph * 4)
        let cx = Double(pw) / 2, cy = Double(ph) / 2
        for y in 0..<ph {
            for x in 0..<pw {
                let nx = (Double(x) + 0.5 - cx) / cx, ny = (Double(y) + 0.5 - cy) / cy
                let rr = (nx * nx + ny * ny).squareRoot()
                let a = 1 - smoothstep(0.55, 1.0, rr)
                guard a > 0 else { continue }
                let vx = ox + x + shift.dx, vy = oy + y + shift.dy
                let i = (y * pw + x) * 4
                let j = y * pw + x
                var src = [0.0, 0.0, 0.0], v = [0.0, 0.0, 0.0]
                for c in 0..<3 {
                    src[c] = viseme.contains(vx, vy) ? Double(viseme.at(vx, vy, c)) : Double(base.at(ox + x, oy + y, c))
                    v[c] = src[c] * gain[c] + bias[c] + Double(shade.shade[c][j])
                }
                if shade.content[j] {
                    // Lips, teeth, tongue: brightness change only. A skin hue correction would tint
                    // the teeth (seen as mint-green teeth on the human set).
                    let dl = (0..<3).reduce(0.0) { $0 + v[$1] - src[$1] } / 3
                    for c in 0..<3 { v[c] = src[c] + dl }
                }
                for c in 0..<3 { out[i + c] = UInt8((min(255, max(0, v[c])) * a).rounded()) }
                out[i + 3] = UInt8((255 * a).rounded())
            }
        }
        let image = PixelBuffer.makeImage(out, width: pw, height: ph)
        return FaceMouthPatch(image: image, rect: r, shift: (shift.dx, shift.dy), surroundDiff: surroundDiff)
    }

    /// Largest per-channel difference (0…255) still read as shading rather than new content
    /// (lips, teeth, a moved chin line) when estimating the local colour correction.
    static let shadingMaxDiff = 40.0

    /// Smooth per-pixel colour correction for a patch (per channel, patch pixels, row 0 = top):
    /// the edit's local shading change (a darker upper lip, a lighter cheek) measured on the skin
    /// around the mouth and filled in across the mouth by normalised convolution, so the patch
    /// carries the base's lighting all the way to its feathered edge. Pixels that differ by more
    /// than `shadingMaxDiff` are content, not shading, and are left out of the estimate; they come
    /// back flagged in `content`.
    static func localShading(base: PixelBuffer, viseme: PixelBuffer, shift: (Int, Int), gain: [Double], bias: [Double],
                             rect r: CGRect, mouth: CGRect) -> (shade: [[Float]], content: [Bool]) {
        let pw = Int(r.width), ph = Int(r.height), ox = Int(r.minX), oy = Int(r.minY)
        let hole = mouth.insetBy(dx: -mouth.width * 0.08, dy: -mouth.height * 0.15)
        var num = [[Float]](repeating: [Float](repeating: 0, count: pw * ph), count: 3)
        var den = [Float](repeating: 0, count: pw * ph)
        for y in 0..<ph {
            for x in 0..<pw {
                let bx = ox + x, by = oy + y, vx = bx + shift.0, vy = by + shift.1
                guard viseme.contains(vx, vy), !hole.contains(CGPoint(x: Double(bx) + 0.5, y: Double(by) + 0.5)) else { continue }
                var d = [0.0, 0.0, 0.0]
                var big = false
                for c in 0..<3 {
                    d[c] = Double(base.at(bx, by, c)) - (Double(viseme.at(vx, vy, c)) * gain[c] + bias[c])
                    if abs(d[c]) > shadingMaxDiff { big = true }
                }
                guard !big else { continue }
                let i = y * pw + x
                for c in 0..<3 { num[c][i] = Float(d[c]) }
                den[i] = 1
            }
        }
        let radius = max(3, Int((mouth.height * 0.5).rounded()))
        let measured = den   // before the blur: 1 = skin used for the estimate
        boxBlur(&den, width: pw, height: ph, radius: radius, passes: 2)
        for c in 0..<3 { boxBlur(&num[c], width: pw, height: ph, radius: radius, passes: 2) }
        var out = [[Float]](repeating: [Float](repeating: 0, count: pw * ph), count: 3)
        for i in 0..<(pw * ph) where den[i] > 1e-3 {
            for c in 0..<3 { out[c][i] = num[c][i] / den[i] }
        }
        return (out, measured.map { $0 == 0 })
    }

    /// In-place separable box blur (edges clamped), repeated `passes` times (≈ Gaussian at 3).
    static func boxBlur(_ v: inout [Float], width w: Int, height h: Int, radius: Int, passes: Int) {
        guard w > 0, h > 0, radius > 0 else { return }
        var tmp = [Float](repeating: 0, count: max(w, h))
        for _ in 0..<passes {
            for y in 0..<h {
                var acc: Float = 0
                for k in -radius...radius { acc += v[y * w + min(w - 1, max(0, k))] }
                for x in 0..<w {
                    tmp[x] = acc / Float(2 * radius + 1)
                    acc += v[y * w + min(w - 1, x + radius + 1)] - v[y * w + max(0, x - radius)]
                }
                for x in 0..<w { v[y * w + x] = tmp[x] }
            }
            for x in 0..<w {
                var acc: Float = 0
                for k in -radius...radius { acc += v[min(h - 1, max(0, k)) * w + x] }
                for y in 0..<h {
                    tmp[y] = acc / Float(2 * radius + 1)
                    acc += v[min(h - 1, y + radius + 1) * w + x] - v[max(0, y - radius) * w + x]
                }
                for y in 0..<h { v[y * w + x] = tmp[y] }
            }
        }
    }

    /// Skin around a mouth: beside it and up towards the nose, not below.
    static func surround(of m: CGRect, face: CGRect) -> CGRect {
        let up = max(m.height * 1.5, face.height * 0.08)
        return CGRect(x: m.minX - m.width * 0.8, y: m.minY - up, width: m.width * 2.6, height: up + m.height)
    }

    /// Integer translation (full-res px) of `moving` that best matches `base` over `region`
    /// minus `excluding`: coarse SAD search on the analysis images (±3% of the width), then ±1
    /// analysis pixel refined at full resolution steps.
    static func align(_ base: AnalysisImage, _ moving: AnalysisImage, around region: CGRect, excluding hole: CGRect?, imageWidth: Int) -> (dx: Int, dy: Int, sad: Double) {
        let s = base.scale
        let maxShift = max(1, Int((Double(imageWidth) * 0.03 * s).rounded()))
        let r = CGRect(x: region.minX * s, y: region.minY * s, width: region.width * s, height: region.height * s).integral
        let hr = hole.map { CGRect(x: $0.minX * s, y: $0.minY * s, width: $0.width * s, height: $0.height * s) }
        var points: [(Int, Int)] = []
        for y in Int(r.minY)..<Int(r.maxY) where y >= 0 && y < base.height {
            for x in Int(r.minX)..<Int(r.maxX) where x >= 0 && x < base.width {
                if let hr, hr.contains(CGPoint(x: Double(x) + 0.5, y: Double(y) + 0.5)) { continue }
                points.append((x, y))
            }
        }
        guard points.count > 8 else { return (0, 0, 0) }
        func sad(_ dx: Double, _ dy: Double) -> Double {
            var acc = 0.0, n = 0.0
            for (x, y) in points {
                let m = moving.sample(Double(x) + dx, Double(y) + dy)
                guard let m else { continue }
                acc += abs(Double(base.values[y * base.width + x]) - m); n += 1
            }
            return n > 0 ? acc / n : .infinity
        }
        var best = (0.0, 0.0), bestSad = sad(0, 0)
        for dy in -maxShift...maxShift {
            for dx in -maxShift...maxShift {
                let v = sad(Double(dx), Double(dy))
                if v < bestSad - 1e-9 { bestSad = v; best = (Double(dx), Double(dy)) }
            }
        }
        // Refine on a sub-pixel grid of the analysis image (= full-res pixel steps).
        let k = Int((1 / s).rounded(.up))
        var fine = best
        if k > 1 {
            for j in -k...k {
                for i in -k...k {
                    let dx = best.0 + Double(i) / Double(k), dy = best.1 + Double(j) / Double(k)
                    let v = sad(dx, dy)
                    if v < bestSad - 1e-9 { bestSad = v; fine = (dx, dy) }
                }
            }
        }
        return (Int((fine.0 / s).rounded()), Int((fine.1 / s).rounded()), bestSad)
    }
}

func smoothstep(_ a: Double, _ b: Double, _ x: Double) -> Double {
    let t = min(1, max(0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)
}

/// Grey image at ~256 px wide for alignment.
struct AnalysisImage {
    let width: Int, height: Int
    let scale: Double   // analysis px per full-res px
    let values: [Float]

    /// Bilinear sample; nil outside.
    func sample(_ x: Double, _ y: Double) -> Double? {
        guard x >= 0, y >= 0, x <= Double(width - 1), y <= Double(height - 1) else { return nil }
        let x0 = Int(x), y0 = Int(y), x1 = min(width - 1, x0 + 1), y1 = min(height - 1, y0 + 1)
        let fx = x - Double(x0), fy = y - Double(y0)
        let a = Double(values[y0 * width + x0]), b = Double(values[y0 * width + x1])
        let c = Double(values[y1 * width + x0]), d = Double(values[y1 * width + x1])
        return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
    }
}

/// RGBA8 (premultiplied, opaque inputs) pixels, row 0 = top.
struct PixelBuffer {
    let width: Int, height: Int
    var data: [UInt8]

    static let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    static let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue

    init(_ image: CGImage, width: Int, height: Int) {
        self.width = width; self.height = height
        var d = [UInt8](repeating: 0, count: width * height * 4)
        d.withUnsafeMutableBytes { raw in
            let ctx = CGContext(data: raw.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: Self.colorSpace, bitmapInfo: Self.bitmapInfo)!
            ctx.interpolationQuality = .high
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        }
        data = d
    }

    @inline(__always) func contains(_ x: Int, _ y: Int) -> Bool { x >= 0 && y >= 0 && x < width && y < height }
    @inline(__always) func at(_ x: Int, _ y: Int, _ c: Int) -> UInt8 { data[(y * width + x) * 4 + c] }

    func forEach(in rect: CGRect, excluding hole: CGRect, _ body: (Int, Int) -> Void) {
        let r = rect.intersection(CGRect(x: 0, y: 0, width: width, height: height)).integral
        guard !r.isNull, r.width > 0 else { return }
        for y in Int(r.minY)..<Int(r.maxY) {
            for x in Int(r.minX)..<Int(r.maxX) where !hole.contains(CGPoint(x: Double(x) + 0.5, y: Double(y) + 0.5)) {
                body(x, y)
            }
        }
    }

    func analysis(targetWidth: Int = 256) -> AnalysisImage {
        let s = min(1, Double(targetWidth) / Double(width))
        let aw = max(1, Int((Double(width) * s).rounded())), ah = max(1, Int((Double(height) * s).rounded()))
        let img = makeImage()
        var d = [UInt8](repeating: 0, count: aw * ah * 4)
        d.withUnsafeMutableBytes { raw in
            let ctx = CGContext(data: raw.baseAddress, width: aw, height: ah, bitsPerComponent: 8, bytesPerRow: aw * 4, space: Self.colorSpace, bitmapInfo: Self.bitmapInfo)!
            ctx.interpolationQuality = .high
            ctx.draw(img, in: CGRect(x: 0, y: 0, width: aw, height: ah))
        }
        var g = [Float](repeating: 0, count: aw * ah)
        for i in 0..<(aw * ah) {
            g[i] = 0.299 * Float(d[i * 4]) + 0.587 * Float(d[i * 4 + 1]) + 0.114 * Float(d[i * 4 + 2])
        }
        return AnalysisImage(width: aw, height: ah, scale: Double(aw) / Double(width), values: g)
    }

    func makeImage() -> CGImage { Self.makeImage(data, width: width, height: height) }

    static func makeImage(_ bytes: [UInt8], width: Int, height: Int) -> CGImage {
        var copy = bytes
        return copy.withUnsafeMutableBytes { raw in
            let ctx = CGContext(data: raw.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: colorSpace, bitmapInfo: bitmapInfo)!
            return ctx.makeImage()!
        }
    }
}
