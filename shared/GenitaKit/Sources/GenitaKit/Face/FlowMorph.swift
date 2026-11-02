// L4 face · Full-face key morph (option B, picked 11/3). Prep (server, faceflow.py) turns the Muse
// Image keys into lower-face composites on the neutral still plus dense classical optical flow both
// ways (neutral→key `nk`, key→neutral `kn`), masked so the nose and everything above it never move.
// At runtime the lip timeline picks how far toward each key the face goes; the frame is a
// bidirectional flow morph over the active keys (each key warped along its flow, then mixed with
// colour weights that favour the dominant key), finally `neutral·(1−m) + morph·m`. No ML at runtime.
// Rules mirror the prototype (genita-mouth-proto/proto.py): amounts ladder, attack/release
// smoothing, focus³, S-curve colour weights.

import CoreGraphics
import Foundation

/// `face.flow` in the prep manifest (PREP_API.md). Boxes normalised to the still, y down.
public struct FaceFlowManifest: Codable, Equatable, Sendable {
    public struct Files: Codable, Equatable, Sendable {
        public var key: String
        public var nk: String
        public var kn: String
    }
    public var version: Int?
    public var roi: [Double]
    public var size: [Int]
    public var flowSize: [Int]
    public var keys: [String]
    public var files: [String: Files]
    public var mask: String
    public var lockY: Double?
    /// Companion type the keys were made for (human | animal | character).
    public var kind: String?
    /// Viseme → key rules (prep writes them; absent → the prototype's defaults).
    public var map: FlowMap?
}

/// A [key, number] pair in the flow map (JSON `["AH", 0.35]`).
public struct FlowKeyValue: Codable, Equatable, Sendable {
    public var key: String
    public var value: Double
    public init(_ key: String, _ value: Double) { self.key = key; self.value = value }
    public init(from decoder: Decoder) throws {
        var c = try decoder.unkeyedContainer()
        key = try c.decode(String.self); value = try c.decode(Double.self)
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.unkeyedContainer(); try c.encode(key); try c.encode(value)
    }
}

public struct FlowMap: Codable, Equatable, Sendable {
    public struct Ladder: Codable, Equatable, Sendable { public var viseme: String; public var steps: [FlowKeyValue]; public var gain: [Double] }
    public struct Mix: Codable, Equatable, Sendable { public var keys: [FlowKeyValue]; public var gain: [Double] }
    public struct ConsonantJaw: Codable, Equatable, Sendable { public var key: String; public var from: Double; public var gain: Double }
    public struct Smoothing: Codable, Equatable, Sendable { public var fps: Double; public var attack: Double; public var release: Double }
    public var ladder: Ladder
    public var mix: [String: Mix]
    public var consonant: [String: Double]
    public var consonantJaw: ConsonantJaw
    public var fallback: [String: String]
    public var smoothing: Smoothing
    public var focus: Double
    public var colourEdge: Double
    /// Largest change of one key's amount per frame at `smoothing.fps` (no 1-frame pops).
    public var slew: Double? = nil
    /// Keys that close at once (attack 1, e.g. MBP) so a closure is never smoothed away.
    public var instantKeys: [String]? = nil
    /// Scales the vowel amounts (open more).
    public var gain: Double? = nil
    /// The lip timeline is sampled this far ahead (mouth leads the sound).
    public var lookaheadMs: Double? = nil
    /// A closure stays fully shut at least this many frames (e.g. {"MBP": 2}).
    public var holdFrames: [String: Int]? = nil
    public struct Dissolve: Codable, Equatable, Sendable { public var mode: String; public var ms: Double; public var minAmount: Double }
    /// Colour mixing: "snap" (one key's texture, `ms` switch, neutral below `minAmount`) or "smooth".
    public var dissolve: Dissolve? = nil
    public struct JawFloor: Codable, Equatable, Sendable { public var share: Double; public var windowMs: Double; public var vowels: [String]; public var closed: [String] }
    /// Co-articulation: frames led by a non-closing consonant keep `share` of the nearby vowel's amounts.
    public var jawFloor: JawFloor? = nil
    public struct Blink: Codable, Equatable, Sendable { public var mode: String; public var frames: Int }
    public var blink: Blink? = nil

    /// The v7 rules (prep faceflow.py BASE_MAP, 11/3) for a manifest without a map.
    public static let standard = FlowMap(
        ladder: .init(viseme: "A", steps: [.init("MID", 0), .init("AH", 0.2), .init("AH2", 0.45)], gain: [0.8, 0.4]),
        mix: ["O": .init(keys: [.init("OH", 0.6), .init("O", 0.4)], gain: [0.75, 0.5]), "EI": .init(keys: [.init("EH", 0.5), .init("EI", 0.5)], gain: [0.75, 0.5])],
        consonant: ["MBP": 1, "FV": 0.9, "TH": 0.85, "L": 0.9, "WQ": 0.8, "U": 0.9, "CDG": 0.9],
        consonantJaw: .init(key: "MID", from: 0.3, gain: 0.8),
        fallback: ["TH": "CDG", "L": "CDG", "U": "OH", "WQ": "O", "FV": "MBP", "CDG": "MID", "AH": "A", "AH2": "A", "MID": "CDG", "EH": "EI", "OH": "O", "O": "OH", "EI": "EH", "A": "AH2"],
        smoothing: .init(fps: 25, attack: 0.75, release: 0.5), focus: 6, colourEdge: 0.35, slew: 0.25, instantKeys: ["MBP"],
        gain: 1.3, lookaheadMs: 40, holdFrames: ["MBP": 2], dissolve: .init(mode: "snap", ms: 40, minAmount: 0.3),
        jawFloor: .init(share: 0.6, windowMs: 160, vowels: ["A", "O", "EI", "U"], closed: ["MBP", "FV", "rest"]),
        blink: .init(mode: "snap", frames: 3))
}

/// Decoded flow data of one face set (ROI pixels at `size`, y down).
public final class FaceFlowData: @unchecked Sendable {
    public let roi: CGRect
    public let size: (w: Int, h: Int)
    public let flowSize: (w: Int, h: Int)
    public let keys: [String]
    public let map: FlowMap
    let keyImages: [String: CGImage]
    let nk: [String: [Float]]
    let kn: [String: [Float]]
    let mask: CGImage

    init(manifest m: FaceFlowManifest, stillSize: CGSize, load: (String) throws -> Data) throws {
        guard m.roi.count == 4, m.size.count == 2, m.flowSize.count == 2, m.size.allSatisfy({ $0 > 4 }), m.flowSize.allSatisfy({ $0 > 2 }) else {
            throw FaceSetError.undecodable("flow")
        }
        let W = Double(stillSize.width), H = Double(stillSize.height)
        roi = CGRect(x: m.roi[0] * W, y: m.roi[1] * H, width: (m.roi[2] - m.roi[0]) * W, height: (m.roi[3] - m.roi[1]) * H)
        size = (m.size[0], m.size[1]); flowSize = (m.flowSize[0], m.flowSize[1])
        var rules = m.map ?? .standard
        // People: the full "A" key is yawn-sized (review 11/3: a 2-frame yawn pop on "Oh"); the
        // ladder stops at AH2 when that key exists.
        if m.kind == "human", m.keys.contains("AH2") { rules.ladder.steps.removeAll { $0.key == "A" } }
        map = rules
        mask = try FaceSet.decode(try load(m.mask), name: "flow.mask")
        var keys: [String] = [], imgs: [String: CGImage] = [:], nk: [String: [Float]] = [:], kn: [String: [Float]] = [:]
        let n = flowSize.w * flowSize.h * 2
        for k in m.keys {
            guard let f = m.files[k] else { continue }
            let a = Self.f16(try load(f.nk)), b = Self.f16(try load(f.kn))
            guard a.count == n, b.count == n else { throw FaceSetError.undecodable("flow \(k)") }
            imgs[k] = try FaceSet.decode(try load(f.key), name: "flow.\(k)")
            nk[k] = a; kn[k] = b; keys.append(k)
        }
        guard !keys.isEmpty else { throw FaceSetError.undecodable("flow: no keys") }
        self.keys = keys; keyImages = imgs; self.nk = nk; self.kn = kn
    }

    /// IEEE half → Float without Float16 (unavailable on x86_64 macOS).
    static func halfToFloat(_ h: UInt16) -> Float {
        let sign = UInt32(h & 0x8000) << 16
        let exp = Int((h >> 10) & 0x1F), man = UInt32(h & 0x3FF)
        if exp == 0 {
            if man == 0 { return Float(bitPattern: sign) }
            let v = Float(man) / 1024 * pow(2, -14)
            return sign != 0 ? -v : v
        }
        if exp == 31 { return Float(bitPattern: sign | 0x7F80_0000 | (man << 13)) }
        return Float(bitPattern: sign | UInt32(exp - 15 + 127) << 23 | (man << 13))
    }

    /// Little-endian IEEE half floats → Float.
    static func f16(_ d: Data) -> [Float] {
        var out = [Float](repeating: 0, count: d.count / 2)
        d.withUnsafeBytes { raw in
            for i in 0..<out.count {
                let bits = UInt16(raw[2 * i]) | UInt16(raw[2 * i + 1]) << 8
                out[i] = halfToFloat(bits)
            }
        }
        return out
    }
}

/// Runtime morph at a fixed working scale (working px per still px).
final class FlowMorph: @unchecked Sendable {
    let data: FaceFlowData
    let width: Int, height: Int
    /// Working px per `size` px (flow vectors are in `size` px), per axis.
    private let kx: Float, ky: Float
    private let neutral: [Float]          // RGB, working res
    private let keyPix: [String: [Float]]
    private let maskW: [Float]
    private let order: [String]
    private var smooth: [Float]
    private var lastT: Double?
    private var closeStart: Double?
    /// The latest vowel-led frame's amounts, for the jaw floor.
    private var lastVowel: (t: Double, amounts: [String: Float])?
    /// Snap mode: colour weights per key and the last dominant switch.
    private var snapW: [Float]
    private var snapT: Double?
    private var dominant: Int?
    private var dominantSince = -Double.infinity

    init(data: FaceFlowData, neutralStill: CGImage, scale: Double) {
        self.data = data
        let s = min(1, max(0.1, scale))
        width = max(8, Int((Double(data.roi.width) * s).rounded()))
        height = max(8, Int((Double(data.roi.height) * s).rounded()))
        kx = Float(width) / Float(data.size.w); ky = Float(height) / Float(data.size.h)
        neutral = Self.rgb(neutralStill, crop: data.roi, width: width, height: height)
        var kp: [String: [Float]] = [:]
        for (key, img) in data.keyImages {
            kp[key] = Self.rgb(img, crop: CGRect(x: 0, y: 0, width: img.width, height: img.height), width: width, height: height)
        }
        keyPix = kp
        let m = Self.rgb(data.mask, crop: CGRect(x: 0, y: 0, width: data.mask.width, height: data.mask.height), width: width, height: height)
        maskW = stride(from: 0, to: m.count, by: 3).map { m[$0] / 255 }
        order = data.keys
        smooth = [Float](repeating: 0, count: data.keys.count)
        snapW = smooth
    }

    // MARK: amounts

    /// Key the viseme name lands on after fallbacks (nil = none available).
    func resolve(_ key: String) -> String? {
        var k = key, seen = Set<String>()
        let avail = Set(order)
        while !avail.contains(k), !seen.contains(k) { seen.insert(k); k = data.map.fallback[k] ?? k }
        return avail.contains(k) ? k : nil
    }

    /// How far toward each key (before smoothing), from a lip frame (the prep `map` rules).
    func amounts(_ lip: LipFrame) -> [String: Float] {
        let m = data.map
        var amt: [String: Float] = [:]
        func add(_ key: String, _ v: Double) {
            guard v > 0, let k = resolve(key) else { return }
            amt[k, default: 0] += Float(v)
        }
        let op = Double(min(1, max(0, lip.openness)))
        for (v, w) in lip.weights where v != .rest && w > 0 {
            let wv = Double(w), name = v.rawValue
            if name == m.ladder.viseme {
                let g = min(1, (m.ladder.gain[0] + m.ladder.gain[1] * op) * (m.gain ?? 1.3))
                var steps = m.ladder.steps.filter { resolve($0.key) == $0.key }
                if steps.isEmpty, let last = m.ladder.steps.last { steps = [FlowKeyValue(last.key, 0)] }
                guard !steps.isEmpty else { continue }
                if op <= steps[0].value || steps.count == 1 { add(steps[0].key, wv * g); continue }
                var placed = false
                for i in 0..<(steps.count - 1) where op <= steps[i + 1].value {
                    let u = (op - steps[i].value) / (steps[i + 1].value - steps[i].value)
                    add(steps[i].key, wv * g * (1 - u)); add(steps[i + 1].key, wv * g * u); placed = true; break
                }
                if !placed { add(steps[steps.count - 1].key, wv * g) }
            } else if let mix = m.mix[name] {
                let g = min(1, (mix.gain[0] + mix.gain[1] * op) * (m.gain ?? 1.3))
                for kv in mix.keys { add(kv.key, wv * g * kv.value) }
            } else {
                add(name, wv * (m.consonant[name] ?? 0.9))
                let cj = m.consonantJaw
                if v != .MBP, op > cj.from { add(cj.key, wv * cj.gain * (op - cj.from)) }
            }
        }
        let s = amt.values.reduce(0, +)
        if s > 1 { for (k, v) in amt { amt[k] = v / s } }
        return amt
    }

    /// Smoothed, focused amounts per key in `order` (time-ordered calls; a jump resets).
    func step(_ lip: LipFrame, at t: Double) -> [Float] {
        var raw = amounts(lip)
        let m = data.map
        // 1) Jaw floor (co-articulation): a frame led by a consonant that does not close the lips
        //    keeps `share` of the latest vowel frame's amounts within `windowMs` (causal: the
        //    following vowel is not known yet), so syllables don't fall back to a shut mouth.
        let top = lip.weights.max { $0.value < $1.value }?.key.rawValue ?? "rest"
        if let jf = m.jawFloor ?? FlowMap.standard.jawFloor {
            if jf.vowels.contains(top) { lastVowel = (t, raw) }
            else if !jf.closed.contains(top), let v = lastVowel, (t - v.t) * 1000 <= jf.windowMs, t >= v.t {
                for (k, a) in v.amounts { raw[k] = max(raw[k] ?? 0, Float(jf.share) * a) }
                let s = raw.values.reduce(0, +)
                if s > 1 { for (k, a) in raw { raw[k] = a / s } }
            }
        }
        var x = order.map { raw[$0] ?? 0 }
        // 2) Closure hold: a closure shuts fully and lasts at least `holdFrames` from its start;
        //    a vowel taking over after that minimum wins (no tail added at the end).
        var closing = false
        let fps = m.smoothing.fps
        for (key, frames) in m.holdFrames ?? ["MBP": 2] {
            guard let jm = order.firstIndex(of: key), let v = LipViseme(rawValue: key) else { continue }
            if (lip.weights[v] ?? 0) >= 0.5 {
                if closeStart == nil { closeStart = t }
                closing = true
            } else if let s0 = closeStart, t < s0 + Double(frames) / fps - 1e-6 {
                closing = true
            } else { closeStart = nil }
            if closing { x = x.indices.map { $0 == jm ? 1 : 0 } }
        }
        let first = lastT == nil
        let dt = lastT.map { t - $0 } ?? 0
        lastT = t
        if !first && (dt <= 0 || dt > 0.5) { smooth = x } else {
            // First frame starts from neutral, like the prototype; rates are per frame at the prep's fps.
            let sm = data.map.smoothing
            let frames = first ? 1 : Float(dt * sm.fps)
            let slew = Float(data.map.slew ?? 0.25) * max(1, frames)
            let instant = Set(data.map.instantKeys ?? ["MBP"])
            for i in 0..<x.count {
                // Closures land on the frame and, once their hold is over, release on the frame too
                // (lips part at a plosive); a slewed release kept short vowels after m/b/p shut.
                if closing || instant.contains(order[i]) { smooth[i] = x[i]; continue }
                let a = Float(x[i] > smooth[i] ? sm.attack : sm.release)
                var d = (1 - pow(1 - a, frames)) * (x[i] - smooth[i])
                d = min(slew, max(-slew, d))
                smooth[i] += d
            }
        }
        var sm = smooth
        let tot = sm.reduce(0, +)
        if tot > 1 { sm = sm.map { $0 / tot } }
        let t2 = sm.reduce(0, +)
        if data.map.focus <= 1 { return sm }
        if t2 > 1e-4 {
            let focus = Float(data.map.focus)
            let pw = sm.map { pow($0, focus) }
            let ps = max(1e-9, pw.reduce(0, +))
            sm = pw.map { t2 * $0 / ps }
        } else { sm = sm.map { _ in 0 } }
        lastAmounts = Dictionary(uniqueKeysWithValues: zip(order, sm))
        return sm
    }

    /// Amounts used for the last rendered frame (tools, parity checks).
    private(set) var lastAmounts: [String: Float] = [:]

    // MARK: render

    /// The morphed ROI as premultiplied RGBA with alpha = mask (composite over the expression still).
    /// Parity checks: use these amounts (in `keys` order) instead of the lip timeline once.
    var amountsOverride: [Float]?

    func render(_ lip: LipFrame, at t: Double) -> CGImage {
        var am = step(lip, at: t)
        if let o = amountsOverride, o.count == am.count { am = o; amountsOverride = nil }
        let act = order.indices.filter { am[$0] > 1e-3 }
        let cw = colourWeights(am, at: t)
        let a0 = max(0, 1 - cw.reduce(0, +))
        let fw = data.flowSize.w, fh = data.flowSize.h, n2 = fw * fh * 2
        let sx = Float(fw) / Float(width), sy = Float(fh) / Float(height)
        // Warp fields on the coarse flow grid (linear in the flows, so this equals combining the
        // upsampled flows), already in working px: GN for the neutral, GK per drawn key.
        var gn = [Float](repeating: 0, count: n2)
        var gs: [[Float]] = []
        for idx in act {
            let a = am[idx], f = data.nk[order[idx]]!, bk = data.kn[order[idx]]!
            let cf = -a * (1 - a), cb = a * a
            var g = [Float](repeating: 0, count: n2)
            for q in stride(from: 0, to: n2, by: 2) {
                g[q] = (cf * f[q] + cb * bk[q]) * kx; g[q + 1] = (cf * f[q + 1] + cb * bk[q + 1]) * ky
                gn[q] += g[q]; gn[q + 1] += g[q + 1]
            }
            gs.append(g)
        }
        var drawn: [(key: [Float], w: Float, field: [Float])] = []
        for (j, idx) in act.enumerated() where cw[idx] > 0 {
            let a = am[idx], f = data.nk[order[idx]]!, bk = data.kn[order[idx]]!
            let cf = (1 - a) * (1 - a), cb = -a * (1 - a)
            var g = [Float](repeating: 0, count: n2)
            let gj = gs[j]
            for q in stride(from: 0, to: n2, by: 2) {
                g[q] = (cf * f[q] + cb * bk[q]) * kx + gn[q] - gj[q]
                g[q + 1] = (cf * f[q + 1] + cb * bk[q + 1]) * ky + gn[q + 1] - gj[q + 1]
            }
            drawn.append((keyPix[order[idx]]!, cw[idx], g))
        }
        var out = [UInt8](repeating: 0, count: width * height * 4)
        let w = width, h = height
        for y in 0..<h {
            let fy = (Float(y) + 0.5) * sy - 0.5
            for x in 0..<w {
                let i = y * w + x
                let m = maskW[i]
                var r = neutral[i * 3], g = neutral[i * 3 + 1], b = neutral[i * 3 + 2]
                if m > 0.002, !act.isEmpty {
                    let fx = (Float(x) + 0.5) * sx - 0.5
                    let px = Float(x), py = Float(y)
                    let d = Self.bilinear2(gn, fw, fh, fx, fy)
                    let c0 = Self.bilinear3(neutral, w, h, px + d.0, py + d.1)
                    r = a0 * c0.0; g = a0 * c0.1; b = a0 * c0.2
                    for k in drawn {
                        let dk = Self.bilinear2(k.field, fw, fh, fx, fy)
                        let c = Self.bilinear3(k.key, w, h, px + dk.0, py + dk.1)
                        r += k.w * c.0; g += k.w * c.1; b += k.w * c.2
                    }
                }
                let o = i * 4
                out[o] = UInt8(min(255, max(0, r * m)).rounded())
                out[o + 1] = UInt8(min(255, max(0, g * m)).rounded())
                out[o + 2] = UInt8(min(255, max(0, b * m)).rounded())
                out[o + 3] = UInt8(min(255, max(0, 255 * m)).rounded())
            }
        }
        return PixelBuffer.makeImage(out, width: width, height: height)
    }

    /// Snap: only the dominant key's texture shows (one-frame cross-fade), so no half-dissolved
    /// grey teeth; a new dominant key must hold `minHoldMs` before the next switch (no chatter),
    /// closures excepted. Smooth: the prototype's S-curve weights.
    static let minHoldMs = 80.0

    func colourWeights(_ am: [Float], at t: Double) -> [Float] {
        let dz = data.map.dissolve ?? FlowMap.standard.dissolve!
        if dz.mode != "snap" {
            let e0 = Float(data.map.colourEdge), e1 = 1 - e0
            var cw = am.map { a -> Float in let u = min(1, max(0, (a - e0) / (e1 - e0))); return u * u * (3 - 2 * u) }
            let cs = cw.reduce(0, +)
            if cs > 1 { cw = cw.map { $0 / cs } }
            return cw
        }
        let fps = data.map.smoothing.fps
        let dt = snapT.map { t - $0 } ?? (1 / fps)
        snapT = t
        let frames = Float(max(0, min(0.5, dt)) * fps)
        var j = am.indices.max { am[$0] < am[$1] }
        if let jj = j, am[jj] < Float(dz.minAmount) { j = nil }
        let isClosure = j.map { order[$0] == "MBP" } ?? false
        if j != dominant {
            if !isClosure, dominant != nil, (t - dominantSince) * 1000 < Self.minHoldMs, dt > 0 { j = dominant }
            else { dominant = j; dominantSince = t }
        }
        let step = Float(min(1, 1000 / fps / max(1, dz.ms))) * max(1, frames)
        for i in snapW.indices {
            let target: Float = i == j ? 1 : 0
            snapW[i] += min(step, max(-step, target - snapW[i]))
        }
        if dt <= 0 || dt > 0.5 { snapW = snapW.indices.map { $0 == j ? 1 : 0 } }
        return snapW
    }

    // MARK: helpers

    @inline(__always) static func bilinear2(_ v: [Float], _ w: Int, _ h: Int, _ x: Float, _ y: Float) -> (Float, Float) {
        let xc = min(Float(w - 1), max(0, x)), yc = min(Float(h - 1), max(0, y))
        let x0 = Int(xc), y0 = Int(yc), x1 = min(w - 1, x0 + 1), y1 = min(h - 1, y0 + 1)
        let ax = xc - Float(x0), ay = yc - Float(y0)
        let i00 = (y0 * w + x0) * 2, i10 = (y0 * w + x1) * 2, i01 = (y1 * w + x0) * 2, i11 = (y1 * w + x1) * 2
        let dx = (v[i00] * (1 - ax) + v[i10] * ax) * (1 - ay) + (v[i01] * (1 - ax) + v[i11] * ax) * ay
        let dy = (v[i00 + 1] * (1 - ax) + v[i10 + 1] * ax) * (1 - ay) + (v[i01 + 1] * (1 - ax) + v[i11 + 1] * ax) * ay
        return (dx, dy)
    }

    /// Bilinear RGB sample, edges replicated (cv2 BORDER_REPLICATE).
    @inline(__always) static func bilinear3(_ v: [Float], _ w: Int, _ h: Int, _ x: Float, _ y: Float) -> (Float, Float, Float) {
        let xc = min(Float(w - 1), max(0, x)), yc = min(Float(h - 1), max(0, y))
        let x0 = Int(xc), y0 = Int(yc), x1 = min(w - 1, x0 + 1), y1 = min(h - 1, y0 + 1)
        let ax = xc - Float(x0), ay = yc - Float(y0)
        let w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay
        let i00 = (y0 * w + x0) * 3, i10 = (y0 * w + x1) * 3, i01 = (y1 * w + x0) * 3, i11 = (y1 * w + x1) * 3
        return (v[i00] * w00 + v[i10] * w10 + v[i01] * w01 + v[i11] * w11,
                v[i00 + 1] * w00 + v[i10 + 1] * w10 + v[i01 + 1] * w01 + v[i11 + 1] * w11,
                v[i00 + 2] * w00 + v[i10 + 2] * w10 + v[i01 + 2] * w01 + v[i11 + 2] * w11)
    }

    /// `crop` of an image (its pixels, y down) resampled to width×height, as RGB floats 0…255.
    static func rgb(_ cg: CGImage, crop: CGRect, width: Int, height: Int) -> [Float] {
        var d = [UInt8](repeating: 0, count: width * height * 4)
        d.withUnsafeMutableBytes { raw in
            let ctx = CGContext(data: raw.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                space: PixelBuffer.colorSpace, bitmapInfo: PixelBuffer.bitmapInfo)!
            ctx.interpolationQuality = .high
            let sx = Double(width) / Double(crop.width), sy = Double(height) / Double(crop.height)
            let H = Double(cg.height)
            ctx.draw(cg, in: CGRect(x: -Double(crop.minX) * sx, y: -(H - Double(crop.maxY)) * sy, width: Double(cg.width) * sx, height: H * sy))
        }
        var out = [Float](repeating: 0, count: width * height * 3)
        for i in 0..<(width * height) { out[i * 3] = Float(d[i * 4]); out[i * 3 + 1] = Float(d[i * 4 + 1]); out[i * 3 + 2] = Float(d[i * 4 + 2]) }
        return out
    }
}
