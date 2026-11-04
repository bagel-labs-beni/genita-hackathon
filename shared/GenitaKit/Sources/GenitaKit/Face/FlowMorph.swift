// L4 face · Full-face key morph (option B, picked 11/3). Prep (server, faceflow.py) turns the Muse
// Image keys into lower-face composites on the neutral still plus dense classical optical flow both
// ways (neutral→key `nk`, key→neutral `kn`), masked so the nose and everything above it never move.
// At runtime the lip timeline picks how far toward each key the face goes; the frame is a
// bidirectional flow morph over the active keys (each key warped along its flow, then mixed with
// colour weights that favour the dominant key), finally `neutral·(1−m) + morph·m`. No ML at runtime.
// Rules mirror the prototype (genita-mouth-proto/proto.py): amounts ladder, attack/release
// smoothing, focus³, S-curve colour weights.

import Accelerate
import CoreGraphics
import Foundation

/// `face.flow` in the prep manifest (PREP_API.md). Boxes normalised to the still, y down.
public struct FaceFlowManifest: Codable, Equatable, Sendable {
    public struct Files: Codable, Equatable, Sendable {
        public var key: String
        public var nk: String?
        public var kn: String?
        /// People (v16 lipmask): where this key's own texture may show (lips + mouth hull), ROI `size`.
        public var lip: String?
        /// Lip rig (v41): the mouth's inside for this key (lip hull minus the lips), ROI `size`.
        public var interior: String?
    }
    public var version: Int?
    public var roi: [Double]
    public var size: [Int]
    /// Absent for 2D snap faces (no flows).
    public var flowSize: [Int]?
    public var keys: [String]
    public var files: [String: Files]
    public var mask: String
    /// The neutral still's ROI as prep corrected it (colour fix); absent → cropped from the still.
    public var neutralRoi: String?
    public var lockY: Double?
    /// Companion type the keys were made for (human | animal | character).
    public var kind: String?
    /// Viseme → key rules (prep writes them; absent → the prototype's defaults).
    public var map: FlowMap?

    public init(version: Int?, roi: [Double], size: [Int], flowSize: [Int]?, keys: [String], files: [String: Files], mask: String,
                neutralRoi: String?, lockY: Double?, kind: String?, map: FlowMap?) {
        self.version = version; self.roi = roi; self.size = size; self.flowSize = flowSize; self.keys = keys; self.files = files
        self.mask = mask; self.neutralRoi = neutralRoi; self.lockY = lockY; self.kind = kind; self.map = map
    }
    enum CodingKeys: String, CodingKey { case version, roi, size, flowSize, keys, files, mask, neutralRoi, lockY, kind, map }
    /// A map this build can't read falls back to the standard rules (the flows still play).
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decodeIfPresent(Int.self, forKey: .version)
        roi = try c.decode([Double].self, forKey: .roi); size = try c.decode([Int].self, forKey: .size)
        flowSize = try c.decodeIfPresent([Int].self, forKey: .flowSize)
        keys = try c.decode([String].self, forKey: .keys); files = try c.decode([String: Files].self, forKey: .files)
        mask = try c.decode(String.self, forKey: .mask); neutralRoi = try c.decodeIfPresent(String.self, forKey: .neutralRoi)
        lockY = try c.decodeIfPresent(Double.self, forKey: .lockY); kind = try c.decodeIfPresent(String.self, forKey: .kind)
        map = try? c.decodeIfPresent(FlowMap.self, forKey: .map)
    }
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
    public struct Blink: Codable, Equatable, Sendable { public var mode: String; public var frames: Int? }
    public var blink: Blink? = nil

    // Non-human profiles (prep merges PROFILE[kind] over the base map; reference render_nh.py).
    /// "viseme" (default), "open" (one jaw parameter, animals) or "snap" (2D replacement mouths, no flows).
    public var drive: String? = nil
    public struct Jaw: Codable, Equatable, Sendable {
        public var floor: Double; public var gain: Double; public var gamma: Double?; public var mbpClose: Double?
        public var steps: [FlowKeyValue]; public var vowel: [String: Double]?
        enum CodingKeys: String, CodingKey { case floor, gain, gamma, mbpClose, steps, vowel }
        public init(floor: Double = 0, gain: Double = 1, gamma: Double? = nil, mbpClose: Double? = nil, steps: [FlowKeyValue], vowel: [String: Double]? = nil) {
            self.floor = floor; self.gain = gain; self.gamma = gamma; self.mbpClose = mbpClose; self.steps = steps; self.vowel = vowel
        }
        /// 11/3 pm: a jaw block without `floor` (or `gain`) decoded to nil and the mouth never opened (a cat export with
        /// one key C2); missing numbers now take their defaults, only `steps` is required.
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            floor = (try? c.decodeIfPresent(Double.self, forKey: .floor)) ?? 0
            gain = (try? c.decodeIfPresent(Double.self, forKey: .gain)) ?? 1
            gamma = try? c.decodeIfPresent(Double.self, forKey: .gamma)
            mbpClose = try? c.decodeIfPresent(Double.self, forKey: .mbpClose)
            steps = try c.decode([FlowKeyValue].self, forKey: .steps)
            vowel = try? c.decodeIfPresent([String: Double].self, forKey: .vowel)
        }
    }
    public var jaw: Jaw? = nil
    /// Per-key amount ceiling after focus (the flow pulls the shape back toward neutral).
    public var cap: [String: Double]? = nil
    /// Snap: a shown key stays at least this many frames; a new key must win minHold−1 frames in a row.
    public var minHold: Int? = nil
    /// Hold every other frame (12.5 fps replacement-mouth look).
    public var onTwos: Bool? = nil
    public var snapMin: Double? = nil
    public var shownFloor: Double? = nil
    public var neutralFlow: Double? = nil
    public struct SnapRule: Codable, Equatable, Sendable {
        public var visemes: [String]; public var minLoudness: Double; public var key: String; public var minRun: Int?
        public init(from decoder: Decoder) throws {
            var c = try decoder.unkeyedContainer()
            visemes = try c.decode([String].self); minLoudness = try c.decode(Double.self); key = try c.decode(String.self)
            minRun = c.isAtEnd ? nil : try c.decode(Int.self)
        }
        public func encode(to encoder: Encoder) throws {
            var c = encoder.unkeyedContainer(); try c.encode(visemes); try c.encode(minLoudness); try c.encode(key)
            if let minRun { try c.encode(minRun) }
        }
    }
    public struct Snap2D: Codable, Equatable, Sendable {
        public var hold: Int?; public var minHold: Int?; public var closedBelow: Double; public var rules: [SnapRule]; public var `default`: String
    }
    public var snap: Snap2D? = nil
    /// People: cheeks and the nasolabial fold follow the mouth corners (one frame late), corners are
    /// pulled back by the same amount, spread vowels lift the cheeks (px at 540 wide). s40 (11/3).
    public struct Cheek: Codable, Equatable, Sendable {
        public var spread: Double; public var pull: Double; public var cheek: Double; public var naso: Double; public var lift: Double
        /// 1 = the lift follows the whole opening (animal whisker pads), else only spread vowels.
        public var liftAll: Double? = nil
        /// Cheek blob [out, up, σx, σy] as fractions of the face box (people: .12, .24, .15, .12).
        public var geometry: [Double]? = nil
        public init(spread: Double, pull: Double, cheek: Double, naso: Double, lift: Double, liftAll: Double? = nil, geometry: [Double]? = nil) {
            self.spread = spread; self.pull = pull; self.cheek = cheek; self.naso = naso; self.lift = lift; self.liftAll = liftAll; self.geometry = geometry
        }
        enum CodingKeys: String, CodingKey { case spread, pull, cheek, naso, cheekW, nasoW, lift, liftAll, geometry }
        /// Prep writes `cheekW` / `nasoW` (v16); `cheek` / `naso` are accepted too.
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            spread = try c.decode(Double.self, forKey: .spread); pull = try c.decode(Double.self, forKey: .pull)
            cheek = try c.decodeIfPresent(Double.self, forKey: .cheekW) ?? c.decode(Double.self, forKey: .cheek)
            naso = try c.decodeIfPresent(Double.self, forKey: .nasoW) ?? c.decode(Double.self, forKey: .naso)
            lift = try c.decodeIfPresent(Double.self, forKey: .lift) ?? 0
            liftAll = try c.decodeIfPresent(Double.self, forKey: .liftAll)
            geometry = try c.decodeIfPresent([Double].self, forKey: .geometry)
        }
        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(spread, forKey: .spread); try c.encode(pull, forKey: .pull); try c.encode(cheek, forKey: .cheekW)
            try c.encode(naso, forKey: .nasoW); try c.encode(lift, forKey: .lift)
            try c.encodeIfPresent(liftAll, forKey: .liftAll); try c.encodeIfPresent(geometry, forKey: .geometry)
        }
    }
    /// v16: per-key amount ceilings (same as `cap`) and consonant gain overrides.
    public var maxAmount: [String: Double]? = nil
    public var consonantOverride: [String: Double]? = nil
    public var cheek: Cheek? = nil
    /// Whole-face life (11/3 "botox + electrocuted mouth" review): head sway/drift and nod gains for
    /// the alive base, a cheek-coupling gain, and loudness-driven lip micro-motion (px at 540 wide).
    public struct Alive: Codable, Equatable, Sendable {
        public var headGain = 1.5, nodGain = 1.5, cheekGain = 1.8, lipLifePx = 0.4
        /// head roll gain (nil = headGain); nod pulse width (×, slower nod spring)
        public var rollGain: Double? = nil, nodWidth = 1.0
        /// handheld-camera drift gain (0 = the background never moves; 11/3 Chelsea)
        public var camera = 0.0
        /// 11/3 pm: the person never moves vertically against the locked still (false = the old nod / drift / breathing)
        public var lockY = true
        /// 11/4: speech-coupled rigid head sway gain (AliveMotion.swayGain); 0 = the still head
        public var sway = 1.0
        public init() {}
        enum CodingKeys: String, CodingKey { case headGain, nodGain, cheekGain, lipLifePx, rollGain, nodWidth, headX, headRoll, nodPx, camera, lockY, sway }
        public init(from decoder: Decoder) throws {
            self.init()
            cheekGain = 1      // a prep that sends alive sends its cheek values as meant
            guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return }   // a block of the wrong shape keeps its defaults
            // prep #266 names: headX (drift ×), headRoll (roll ×), nodPx (px at a full onset; 2.5 = ×1), nodWidth
            if let v = try? c.decodeIfPresent(Double.self, forKey: .headX) { headGain = v }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .headRoll) { rollGain = v }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .nodPx) { nodGain = v / AliveMotion.nodPixels }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .rollGain) { rollGain = v }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .nodWidth) { nodWidth = max(0.25, v) }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .camera) { camera = max(0, v) }
            if let v = try? c.decodeIfPresent(Bool.self, forKey: .lockY) { lockY = v }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .sway) { sway = min(2, max(0, v)) }
            if let v = try c.decodeIfPresent(Double.self, forKey: .headGain) { headGain = v }
            if let v = try c.decodeIfPresent(Double.self, forKey: .nodGain) { nodGain = v }
            if let v = try c.decodeIfPresent(Double.self, forKey: .cheekGain) { cheekGain = v }
            if let v = try c.decodeIfPresent(Double.self, forKey: .lipLifePx) { lipLifePx = v }
        }
        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(headGain, forKey: .headGain); try c.encode(nodGain, forKey: .nodGain); try c.encode(cheekGain, forKey: .cheekGain)
            try c.encode(lipLifePx, forKey: .lipLifePx); try c.encodeIfPresent(rollGain, forKey: .rollGain); try c.encode(nodWidth, forKey: .nodWidth); try c.encode(camera, forKey: .camera)
            try c.encode(lockY, forKey: .lockY); try c.encode(sway, forKey: .sway)
        }
    }
    public var alive: Alive? = nil
    /// Lip rig (human lane v41): slow chin, cross-blended lip textures, an opaque teeth layer from the
    /// top key, living lips. Absent → the v2 snap texture. Any field may be missing.
    public struct Rig: Codable, Equatable, Sendable {
        /// the part of each key flow below the lower lip follows the amounts low-passed at this Hz
        /// (2nd order, critically damped), × chinGain; the lips stay on the raw amounts
        public var chinLpHz = 2.0, chinGain = 0.3
        /// critic bgperi (11/3): the skin around the lips (outside the lip ellipse) also takes this share
        /// of its motion from the slow amounts (× skinGain), so it moves continuously; 0 = off
        public var skinShare = 0.0, skinGain = 1.0   // 0.4 made the jaw 1.5× fast for no perioral gain (v9.3)
        /// ramp start below the mouth box bottom and its length (× still height)
        public var chinRamp = [0.035, 0.03]
        /// texture blend: w_k = a_k/Σa × clip((Σa − blendFloor[0]) / blendFloor[1])
        public var blendFloor = [0.12, 0.40]      // v43+
        /// keys never textured (geometry only)
        public var noTex = ["MBP"]
        /// teeth layer: top key (hysteresis, none below teethMin), alpha = interior × clip((a − teethAlpha[0]) / teethAlpha[1])
        public var teethHyst = 0.05, teethMin = 0.08, teethAlpha = [0.06, 0.12]
        /// v44: the teeth layer leaves on the frame before a closure
        public var teethExitBeforeClose = true
        /// v44 teeth-layer texture tone (teethTop.tone): darker, warmer cavity; an upper band of bright,
        /// unsaturated pixels lifted toward white. nil = the key texture as it is.
        public struct TeethTone: Codable, Equatable, Sendable {
            public var cavityDark = 0.5, teethLift = 0.5, band = 0.90, split = 0.40, thrPct = 50.0   // v9.1 release
            public init() {}
            enum CodingKeys: String, CodingKey { case cavityDark, teethLift, band, split, thrPct }
            public init(from decoder: Decoder) throws {
                self.init()
                guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return }   // a block of the wrong shape keeps its defaults
                if let v = try? c.decodeIfPresent(Double.self, forKey: .cavityDark) { cavityDark = v }
                if let v = try? c.decodeIfPresent(Double.self, forKey: .teethLift) { teethLift = v }
                if let v = try? c.decodeIfPresent(Double.self, forKey: .band) { band = v }
                if let v = try? c.decodeIfPresent(Double.self, forKey: .split) { split = v }
                if let v = try? c.decodeIfPresent(Double.self, forKey: .thrPct) { thrPct = v }
            }
        }
        public var teethTone: TeethTone? = nil
        /// living lips: loudness × smooth random field (σ = lipFlowSigma × still width), px at 540 wide
        public var lipFlowPx = 1.2, lipFlowSigma = 0.012, lipTex = 0.15
        /// closed lips (neutral texture) take the open keys' lip tone (0 = off, 1 = full)
        public var lipTone = 1.0
        /// lip saturation ceiling: × the neutral texture's mean lip saturation (v9.0 review: magenta closed lips); 0 = off
        public var lipSatMax = 1.05
        public init() {}
        enum CodingKeys: String, CodingKey { case chinLpHz, chinGain, skinShare, skinGain, chinRamp, blendFloor, noTex, teethHyst, teethMin, teethAlpha, lipFlowPx, lipFlowSigma, lipTex, lipTone, lipSatMax, teethTop }
        enum TeethKeys: String, CodingKey { case hyst, min, alpha, tone, exitBeforeClose }
        public init(from decoder: Decoder) throws {
            self.init()
            guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return }   // a block of the wrong shape keeps its defaults
            if let v = try? c.decodeIfPresent(Double.self, forKey: .chinLpHz) { chinLpHz = v }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .chinGain) { chinGain = v }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .skinShare) { skinShare = min(1, max(0, v)) }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .skinGain) { skinGain = v }
            if let v = try? c.decodeIfPresent([Double].self, forKey: .chinRamp), v.count == 2 { chinRamp = v }
            if let v = try? c.decodeIfPresent([Double].self, forKey: .blendFloor), v.count == 2 { blendFloor = v }
            if let v = try? c.decodeIfPresent([String].self, forKey: .noTex) { noTex = v }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .teethHyst) { teethHyst = v }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .teethMin) { teethMin = v }
            if let v = try? c.decodeIfPresent([Double].self, forKey: .teethAlpha), v.count == 2 { teethAlpha = v }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .lipFlowPx) { lipFlowPx = v }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .lipFlowSigma) { lipFlowSigma = v }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .lipTex) { lipTex = v }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .lipTone) { lipTone = v }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .lipSatMax) { lipSatMax = v }
            // prep #266 nests the teeth rules: teethTop {hyst, min, alpha, fade, cavity}
            if let t = try? c.nestedContainer(keyedBy: TeethKeys.self, forKey: .teethTop) {
                if let v = try? t.decodeIfPresent(Double.self, forKey: .hyst) { teethHyst = v }
                if let v = try? t.decodeIfPresent(Double.self, forKey: .min) { teethMin = v }
                if let v = try? t.decodeIfPresent([Double].self, forKey: .alpha), v.count == 2 { teethAlpha = v }
                if let v = try? t.decodeIfPresent(TeethTone.self, forKey: .tone) { teethTone = v }
                if let v = try? t.decodeIfPresent(Double.self, forKey: .exitBeforeClose) { teethExitBeforeClose = v >= 0.5 }
                else if let v = try? t.decodeIfPresent(Bool.self, forKey: .exitBeforeClose) { teethExitBeforeClose = v }
            }
        }
        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(chinLpHz, forKey: .chinLpHz); try c.encode(chinGain, forKey: .chinGain); try c.encode(skinShare, forKey: .skinShare); try c.encode(skinGain, forKey: .skinGain); try c.encode(chinRamp, forKey: .chinRamp)
            try c.encode(blendFloor, forKey: .blendFloor); try c.encode(noTex, forKey: .noTex)
            try c.encode(teethHyst, forKey: .teethHyst); try c.encode(teethMin, forKey: .teethMin); try c.encode(teethAlpha, forKey: .teethAlpha)
            try c.encode(lipFlowPx, forKey: .lipFlowPx); try c.encode(lipFlowSigma, forKey: .lipFlowSigma); try c.encode(lipTex, forKey: .lipTex); try c.encode(lipTone, forKey: .lipTone); try c.encode(lipSatMax, forKey: .lipSatMax)
            var t = c.nestedContainer(keyedBy: TeethKeys.self, forKey: .teethTop)
            try t.encode(teethHyst, forKey: .hyst); try t.encode(teethMin, forKey: .min); try t.encode(teethAlpha, forKey: .alpha)
            try t.encodeIfPresent(teethTone, forKey: .tone); try t.encode(teethExitBeforeClose ? 1.0 : 0.0, forKey: .exitBeforeClose)
        }
    }
    public var rig: Rig? = nil
    /// Call-screen framing: zoom (1…2) about cy (still height, y down). Absent → from the face box.
    public struct Framing: Codable, Equatable, Sendable {
        public var zoom: Double?
        public var cy: Double?
        public init(zoom: Double? = nil, cy: Double? = nil) { self.zoom = zoom; self.cy = cy }
        enum CodingKeys: String, CodingKey { case zoom, cy }
        public init(from decoder: Decoder) throws {
            guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return }   // a block of the wrong shape keeps its defaults
            zoom = (try? c.decodeIfPresent(Double.self, forKey: .zoom)) ?? nil
            cy = (try? c.decodeIfPresent(Double.self, forKey: .cy)) ?? nil
        }
    }
    public var framing: Framing? = nil
    /// Animals (prep `chinWarp`, 11/4 CA-06: "the jaw barely moves, the chin fur stays like a patch"): the lower jaw and
    /// chin fur below the lower lip move down with the opening, `px` (at 540 px frame width) at full opening, following
    /// it through a `springMs` low-pass; full across the mouth, fading out over `sideW` face widths beside it.
    public struct ChinWarp: Codable, Equatable, Sendable {
        public var px = 7.0, springMs = 170.0, sideW = 0.2
        public init() {}
        enum CodingKeys: String, CodingKey { case px, springMs, sideW }
        public init(from decoder: Decoder) throws {
            self.init()
            guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return }   // a block of the wrong shape keeps its defaults
            if let v = try? c.decodeIfPresent(Double.self, forKey: .px), v.isFinite { px = min(20, max(0, v)) }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .springMs), v.isFinite { springMs = min(1000, max(0, v)) }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .sideW), v.isFinite { sideW = min(1, max(0.02, v)) }
        }
    }
    public var chinWarp: ChinWarp? = nil
    /// Skin around the mouth (11/3 Chelsea: "still a bit botox around the mouth"), still px at 960 high
    /// unless noted. All 0 = off; values come from the human lane.
    public struct Perioral: Codable, Equatable, Sendable {
        /// skin around the lips follows the corners' motion (share), falling off over `falloff` × mouth width.
        /// Pixel values below are still px at 540 wide (like the cheek rules).
        public var follow = 0.0, falloff = 0.8
        /// skin below the lower lip moves down with the opening (px at full opening)
        public var followOpenPx = 0.0
        /// upper lip / philtrum lift at full opening (px)
        public var philtrumPx = 0.0
        /// corners pull the cheeks harder on EE (spread × (1 + eeSpread × EE amount))
        public var eeSpread = 0.0
        /// cheeks bulge outward on O / U (px at full rounding)
        public var roundBulgePx = 0.0
        /// the skin just outside each corner is pulled outward on EE (px at full spread; it drags the
        /// lower cheek along, v51 / critic: mouth width barely changed on spread vowels)
        public var spreadPx = 0.0
        /// v55: the same corner fields pull inward on O / U (px at full rounding)
        public var roundInPx = 0.0
        /// v55: the jaw contour under the mouth drops with the slow opening (px at full opening)
        public var jawDropPx = 0.0
        /// chin moves up on a closure (px at full MBP)
        public var mbpChinPx = 0.0
        /// critic bgperi (11/3): the cheek / perioral drive is low-passed (1st order, ms) so the skin moves
        /// continuously instead of only on syllables; plus a loudness-envelope micro-motion (px) that
        /// carries on between syllables
        public var lpfMs = 0.0, microPx = 0.0
        /// v57c: on spread vowels the lips thin — rows within the lip band (opening half-height +
        /// lipThinPx × frame height) are pulled toward the opening by lipThin × spread; the teeth layer
        /// keeps its own coordinates (only its alpha follows), so teeth are revealed, never stretched
        public var lipThin = 0.0, lipThinPx = 0.014
        /// v58 (11/3 pm, Chelsea: "the mouth moves far too little, like talking through a slight gap"):
        /// on open / round vowels the opening is magnified vertically about its centre — the upper lip
        /// lifts (band openUpPx × frame height above the opening) and the lower lip and chin drop (band
        /// openDnPx below), centre scale 1 / (1 − openMag × opening). The teeth layer follows the same
        /// rows, so the teeth fill the bigger opening instead of a dark slit. Closures are never touched.
        public var openMag = 0.0, openUpPx = 0.004, openDnPx = 0.012
        /// v60: sideways widening on flat vowels (share of the mouth half-width at the opening's centre row)
        public var openWide = 0.0
        public init() {}
        enum CodingKeys: String, CodingKey { case follow, falloff, followOpenPx, philtrumPx, eeSpread, roundBulgePx, spreadPx, roundInPx, jawDropPx, mbpChinPx, lpfMs, microPx, lipThin, lipThinPx, openMag, openUpPx, openDnPx, openWide }
        public init(from decoder: Decoder) throws {
            self.init()
            guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .follow) { follow = v }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .falloff) { falloff = max(0.1, v) }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .followOpenPx) { followOpenPx = v }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .philtrumPx) { philtrumPx = v }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .eeSpread) { eeSpread = v }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .roundBulgePx) { roundBulgePx = v }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .spreadPx) { spreadPx = v }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .roundInPx) { roundInPx = v }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .jawDropPx) { jawDropPx = v }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .mbpChinPx) { mbpChinPx = v }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .lpfMs) { lpfMs = max(0, v) }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .microPx) { microPx = v }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .lipThin) { lipThin = min(0.95, max(0, v)) }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .lipThinPx) { lipThinPx = max(0, v) }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .openMag) { openMag = min(1.5, max(0, v)) }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .openUpPx) { openUpPx = max(0, v) }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .openDnPx) { openDnPx = max(0, v) }
            if let v = try? c.decodeIfPresent(Double.self, forKey: .openWide) { openWide = min(0.3, max(0, v)) }
        }
        /// Release values for people on the lip rig when prep sends no perioral block: the human lane's
        /// v56 (critic 8.5; jawDrop 0 — 5 px made the jaw 1.34× too fast), plus the app's ring follow.
        public static let release: Perioral = {
            var p = Perioral()
            p.follow = 0.2; p.philtrumPx = 1.6; p.spreadPx = 5; p.roundInPx = 3; p.jawDropPx = 0; p.roundBulgePx = 1.2
            p.mbpChinPx = 1.1; p.lpfMs = 150; p.microPx = 0      // MBP chin 1.3 → 1.1 (critic: jawspd 1.5)
            p.lipThin = 0.8; p.lipThinPx = 0.014                  // v57c
            p.openMag = Self.releaseOpenMag; p.openDnPx = 0.024; p.openUpPx = 0.006; p.openWide = 0.2  // v60 (v58: .012 / .004)
            return p
        }()
        /// v58 open magnifier strength for the release block (rollback: 0).
        nonisolated(unsafe) public static var releaseOpenMag = 0.0   // 11/3 18:46 Chelsea: "looks synthetic when the mouth opens" — off (v9.3 mouth); was 1.0 in v60b
        var isOff: Bool { openMag == 0 && follow == 0 && followOpenPx == 0 && philtrumPx == 0 && eeSpread == 0 && roundBulgePx == 0 && spreadPx == 0 && roundInPx == 0 && jawDropPx == 0 && mbpChinPx == 0 && microPx == 0 && lipThin == 0 }
    }
    public var perioral: Perioral? = nil
    /// Continuous motion (11/3, "robotic a-e-i-o-u" review): geometry follows a critically damped
    /// spring instead of stepping with the texture snap; amplitude scaled by stress; the next shape is
    /// blended in ahead; only closures are fast. Texture snap keeps its own hysteresis.
    public struct Motion: Codable, Equatable, Sendable {
        public var riseMs: Double = 75          // geometry 90% rise time (short vowels must land; jerk vs reach)
        public var closeRiseMs: Double = 40     // m/b/p closing
        public var amplitude: Double = 0.9      // overall geometry scale (stressed vowels; 11/3 open more)
        public var unstressed: Double = 0.45    // share for unstressed vowels (stressed = 1)
        public var anticipation: Double = 0.25  // blend of the shape coming next (vowels only)
        public var aheadMs: Double = 120        // how far ahead "next" is
        public var textureOn: Double = 0.55     // hysteresis: a new texture needs this share …
        public var textureOff: Double = 0.45    // … and the shown one must have dropped below this
        public var textureMin: Double = 0.15    // below: the neutral texture
        /// Idle life: a slow, small jaw drift (amount of the first jaw key) so the mouth is never frozen.
        public var idleJaw: Double = 0.2
        /// Skin micro-motion of the lower face (px at 540 wide, smooth noise ~2–4 Hz): a live face is
        /// never pixel-still between frames.
        public var microPx: Double = 0.5
        public init() {}
        enum CodingKeys: String, CodingKey { case riseMs, closeRiseMs, amplitude, unstressed, anticipation, aheadMs, textureOn, textureOff, textureMin, idleJaw, microPx }
        /// Any field may be missing (prep sends only what it tunes); missing ones keep the defaults.
        public init(from decoder: Decoder) throws {
            self.init()
            let c = try decoder.container(keyedBy: CodingKeys.self)
            if let v = try c.decodeIfPresent(Double.self, forKey: .riseMs) { riseMs = v }
            if let v = try c.decodeIfPresent(Double.self, forKey: .closeRiseMs) { closeRiseMs = v }
            if let v = try c.decodeIfPresent(Double.self, forKey: .amplitude) { amplitude = v }
            if let v = try c.decodeIfPresent(Double.self, forKey: .unstressed) { unstressed = v }
            if let v = try c.decodeIfPresent(Double.self, forKey: .anticipation) { anticipation = v }
            if let v = try c.decodeIfPresent(Double.self, forKey: .aheadMs) { aheadMs = v }
            if let v = try c.decodeIfPresent(Double.self, forKey: .textureOn) { textureOn = v }
            if let v = try c.decodeIfPresent(Double.self, forKey: .textureOff) { textureOff = v }
            if let v = try c.decodeIfPresent(Double.self, forKey: .textureMin) { textureMin = v }
            if let v = try c.decodeIfPresent(Double.self, forKey: .idleJaw) { idleJaw = v }
            if let v = try c.decodeIfPresent(Double.self, forKey: .microPx) { microPx = v }
        }
    }
    public var motion: Motion? = nil
    /// v2 coarticulated motion (needs aligner phonemes; human lane v23). Absent → v2 defaults for people.
    public var motionV2: MotionV2Params? = nil

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
    public let kind: String?
    /// Nose-base line (0…1 of the still's height), from prep.
    public let lockY: Double?
    public let map: FlowMap
    let keyImages: [String: CGImage]
    let lipMasks: [String: CGImage]
    let interiorMasks: [String: CGImage]
    let nk: [String: [Float]]
    let kn: [String: [Float]]
    let mask: CGImage
    let neutralROI: CGImage?

    init(manifest m: FaceFlowManifest, stillSize: CGSize, load: (String) throws -> Data) throws {
        let fsz = m.flowSize ?? [4, 4]
        guard m.roi.count == 4, m.size.count == 2, fsz.count == 2, m.size.allSatisfy({ $0 > 4 }), fsz.allSatisfy({ $0 > 2 }) else {
            throw FaceSetError.undecodable("flow")
        }
        let W = Double(stillSize.width), H = Double(stillSize.height)
        roi = CGRect(x: m.roi[0] * W, y: m.roi[1] * H, width: (m.roi[2] - m.roi[0]) * W, height: (m.roi[3] - m.roi[1]) * H)
        size = (m.size[0], m.size[1]); flowSize = (fsz[0], fsz[1])
        kind = m.kind
        lockY = m.lockY
        var rules = m.map ?? .standard
        // People: the full "A" key is yawn-sized (review 11/3: a 2-frame yawn pop on "Oh"); the
        // ladder stops at AH2 when that key exists.
        if m.kind == "human", m.keys.contains("AH2") { rules.ladder.steps.removeAll { $0.key == "A" } }
        for (k, v) in rules.consonantOverride ?? [:] { rules.consonant[k] = v }
        if let mx = rules.maxAmount { rules.cap = (rules.cap ?? [:]).merging(mx) { min($0, $1) } }
        map = rules
        mask = try FaceSet.decode(try load(m.mask), name: "flow.mask")
        neutralROI = try m.neutralRoi.map { try FaceSet.decode(try load($0), name: "flow.neutral") }
        var keys: [String] = [], imgs: [String: CGImage] = [:], nk: [String: [Float]] = [:], kn: [String: [Float]] = [:]
        var lips: [String: CGImage] = [:], ints: [String: CGImage] = [:]
        let n = flowSize.w * flowSize.h * 2
        let flows = rules.drive != "snap"     // 2D snap mouths are composited as they are
        if flows, m.flowSize == nil { throw FaceSetError.undecodable("flow: no flowSize") }
        for k in m.keys {
            guard let f = m.files[k] else { continue }
            if flows {
                guard let fn = f.nk, let fk = f.kn else { throw FaceSetError.undecodable("flow \(k)") }
                let a = Self.f16(try load(fn)), b = Self.f16(try load(fk))
                guard a.count == n, b.count == n else { throw FaceSetError.undecodable("flow \(k)") }
                nk[k] = a; kn[k] = b
            } else {
                nk[k] = [Float](repeating: 0, count: n); kn[k] = nk[k]
            }
            imgs[k] = try FaceSet.decode(try load(f.key), name: "flow.\(k)")
            if let l = f.lip { lips[k] = try FaceSet.decode(try load(l), name: "flow.\(k).lip") }
            if let l = f.interior { ints[k] = try FaceSet.decode(try load(l), name: "flow.\(k).interior") }
            keys.append(k)
        }
        guard !keys.isEmpty else { throw FaceSetError.undecodable("flow: no keys") }
        self.keys = keys; keyImages = imgs; self.nk = nk; self.kn = kn; lipMasks = lips; interiorMasks = ints
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
    private var neutral: [Float]          // RGB, working res
    private var keyPix: [String: [Float]]
    /// Per-key lip hull (0…1, working res); a key's colour shows only inside it, the skin is the warped neutral.
    private let lipPix: [String: [Float]]
    /// v29: teeth pixels per key (fade to the mouth's inside colour while the key is barely open).
    private let teethPix: [String: [Float]]
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

    init(data: FaceFlowData, neutralStill: CGImage, scale: Double, face: CGRect? = nil, mouth: CGRect? = nil, expressions: Bool = false) {
        self.data = data
        let s = min(1, max(0.1, scale))
        workScale = s
        stillWidth = Double(neutralStill.width)
        width = max(8, Int((Double(data.roi.width) * s).rounded()))
        height = max(8, Int((Double(data.roi.height) * s).rounded()))
        kx = Float(width) / Float(data.size.w); ky = Float(height) / Float(data.size.h)
        if let n = data.neutralROI {
            neutral = Self.rgb(n, crop: CGRect(x: 0, y: 0, width: n.width, height: n.height), width: width, height: height)
        } else {
            neutral = Self.rgb(neutralStill, crop: data.roi, width: width, height: height)
        }
        var kp: [String: [Float]] = [:]
        for (key, img) in data.keyImages {
            kp[key] = Self.rgb(img, crop: CGRect(x: 0, y: 0, width: img.width, height: img.height), width: width, height: height)
        }
        keyPix = kp
        var lm: [String: [Float]] = [:]
        for (key, img) in data.lipMasks {
            let v = Self.rgb(img, crop: CGRect(x: 0, y: 0, width: img.width, height: img.height), width: width, height: height)
            lm[key] = stride(from: 0, to: v.count, by: 3).map { v[$0] / 255 }
        }
        lipPix = lm
        // v29 teeth fade: bright, unsaturated pixels inside the lip hull are teeth
        var tm: [String: [Float]] = [:]
        for (key, px) in kp {
            guard let lip = lm[key] else { continue }
            var m = [Float](repeating: 0, count: width * height)
            for i in 0..<(width * height) where lip[i] > 0.5 {
                let r = px[i * 3], g = px[i * 3 + 1], b = px[i * 3 + 2]
                let mx = max(r, g, b), mn = min(r, g, b)
                let sat = mx > 0 ? (mx - mn) / mx : 0
                if sat < 0.35 && mx > 165 { m[i] = 1 }
            }
            tm[key] = m
        }
        teethPix = tm
        var ip: [String: [Float]] = [:]
        for (key, img) in data.interiorMasks {
            let v = Self.rgb(img, crop: CGRect(x: 0, y: 0, width: img.width, height: img.height), width: width, height: height)
            ip[key] = stride(from: 0, to: v.count, by: 3).map { v[$0] / 255 }
        }
        intPix = ip
        let m = Self.rgb(data.mask, crop: CGRect(x: 0, y: 0, width: data.mask.width, height: data.mask.height), width: width, height: height)
        var mw = stride(from: 0, to: m.count, by: 3).map { m[$0] / 255 }
        // 11/3 night (gate: only the mouth and jaw move): the blend mask stops at the chin — the SAM face box's
        // bottom — so neck, collar, chest fur and the beard below the jaw stay the still photo.
        if Self.chinStop, let face, data.roi.height > 0 {
            let kys = Double(height) / Double(data.roi.height)
            // the open keys drop the lower lip and jaw below the neutral chin line: leave room for that (codex P2)
            let chin = (Self.chinLine(data: data, face: face, mouth: mouth) - Double(data.roi.minY)) * kys
            let feather = max(2, 0.05 * Double(face.height) * kys)
            let top = chin - feather
            for y in 0..<height where Double(y) > top {
                let k = Float(max(0, 1 - (Double(y) - top) / (2 * feather)))
                let k2 = k * k * (3 - 2 * k)
                for x in 0..<width { mw[y * width + x] *= k2 }
            }
        }
        // … and only an ellipse around the mouth and jaw blends (cheeks, freckles and pores outside stay the photo):
        // from a mouth height above the lips down to the chin, 0.36 face widths either side, soft edge
        if Self.chinStop, let face, let mouth, data.roi.width > 0, data.roi.height > 0 {
            let kxs = Double(width) / Double(data.roi.width), kys = Double(height) / Double(data.roi.height)
            let top = (Double(mouth.minY) - Double(mouth.height) - Double(data.roi.minY)) * kys
            let bottom = (Self.chinLine(data: data, face: face, mouth: mouth) - Double(data.roi.minY)) * kys
            let cx = (Double(mouth.midX) - Double(data.roi.minX)) * kxs, cy = (top + bottom) / 2
            let rx = max(4, 0.36 * Double(face.width) * kxs), ry = max(4, (bottom - top) / 2)
            for y in 0..<height { for x in 0..<width {
                let dx = (Double(x) - cx) / rx, dy = (Double(y) - cy) / ry
                let r = (dx * dx + dy * dy).squareRoot()
                let k = Float(max(0, min(1, (1.0 - r) / 0.25)))
                mw[y * width + x] *= k * k * (3 - 2 * k)
            } }
        }
        maskW = mw
        order = data.keys
        if let tone = data.map.rig?.teethTone {
            for (k, inn) in ip { if let p = keyPix[k] { teethTex[k] = Self.toneTeeth(p, interior: inn, width: width, height: height, tone: tone) } }
        }
        if let rg = data.map.rig, rg.lipTone > 0, data.neutralROI != nil, let closedLip = lm["MBP"] {
            // the photo's own lip tone (prep's colour fix greyed the lips toward lilac, v8.8 review)
            let mw = stride(from: 0, to: m.count, by: 3).map { m[$0] / 255 }
            let photo = Self.rgb(neutralStill, crop: data.roi, width: width, height: height)
            if let g = Self.lipToneGain(from: neutral, to: photo, lip: closedLip, mask: mw, strength: Float(rg.lipTone)) {
                let sMax = rg.lipSatMax > 0 ? Self.meanLipSat(neutral, lip: closedLip, skinRG: g.skinRG).map { $0 * Float(rg.lipSatMax) } : nil
                neutral = Self.applyLipGain(neutral, lip: closedLip, interior: nil, gain: g.gain, skinRG: g.skinRG, satMax: sMax)
                for (k, p) in kp where lm[k] != nil { keyPix[k] = Self.applyLipGain(p, lip: lm[k]!, interior: ip[k], gain: g.gain, skinRG: g.skinRG, satMax: sMax) }
            }
        }
        smooth = [Float](repeating: 0, count: data.keys.count)
        snapW = smooth
        let cheekRules = data.map.cheek ?? (data.kind == "human" ? FlowMap.Cheek(spread: 0.52, pull: 1.0, cheek: 1.2, naso: 0.35, lift: 2.0) : nil)
        let aliveP = data.map.alive ?? (data.kind == "human" ? FlowMap.Alive() : nil)
        if var c = cheekRules, let face, let mouth, data.map.drive != "snap" {
            let g = aliveP?.cheekGain ?? 1
            c.spread *= g; c.cheek *= g; c.naso *= g
            cheekRig = CheekRig(rules: c, data: data, neutralStill: neutralStill, scale: s, face: face, mouth: mouth, stillWidth: Double(neutralStill.width),
                                expressions: expressions, perioral: data.map.perioral ?? (data.map.rig != nil && data.kind == "human" ? .release : nil))
        } else { cheekRig = nil }
        if let face { faceNorm = min(1.2, max(0.6, 356 / max(1, Double(face.height) * 960 / Double(neutralStill.height)))) }
        nkF = data.nk; knF = data.kn
        // chin warp (animals on the open drive): per flow cell weight, still rows y down
        if let cw = data.map.chinWarp, data.map.drive == "open", cw.px > 0, let face, let mouth,
           data.flowSize.w > 0, data.flowSize.h > 0, data.roi.width > 0, data.roi.height > 0 {
            let fw = data.flowSize.w, fh = data.flowSize.h
            let yTop = Double(mouth.midY), yLip = Double(mouth.maxY)
            let yEnd = Self.chinLine(data: data, face: face, mouth: mouth), yFade = yLip + 0.6 * max(1, yEnd - yLip)
            let cx = Double(mouth.midX), hw = 0.6 * Double(mouth.width), side = max(1, 1.5 * cw.sideW * Double(face.width))
            func ss(_ a: Double, _ b: Double, _ v: Double) -> Double { let u = min(1, max(0, (v - a) / max(1e-6, b - a))); return u * u * (3 - 2 * u) }
            var w = [Float](repeating: 0, count: fw * fh)
            for j in 0..<fh { for i in 0..<fw {
                let x = Double(data.roi.minX) + (Double(i) + 0.5) / Double(fw) * Double(data.roi.width)
                let y = Double(data.roi.minY) + (Double(j) + 0.5) / Double(fh) * Double(data.roi.height)
                let vy = ss(yTop, yLip, y) * (1 - ss(yFade, yEnd, y))
                let vx = 1 - ss(hw, hw + side, abs(x - cx))
                w[j * fw + i] = Float(vy * vx)
            } }
            chinWarpW = w
            chinWarpPx = Float(cw.px * workScale * Double(neutralStill.width) / 540)
        }
        let v2p = data.map.motionV2 ?? (data.kind == "human" ? MotionV2Params() : nil)
        stillH = Double(neutralStill.height)
        if let mouth {
            let kxs = Double(width) / Double(data.roi.width), kys = Double(height) / Double(data.roi.height)
            rigMouth = CGRect(x: (Double(mouth.minX) - Double(data.roi.minX)) * kxs, y: (Double(mouth.minY) - Double(data.roi.minY)) * kys,
                              width: Double(mouth.width) * kxs, height: Double(mouth.height) * kys)
        }
        if let rg = data.map.rig, let mouth, data.map.drive != "snap" {
            // lip rig: raw flows; the chin's share is split off per row at render time (slow, × chinGain)
            let H = Double(neutralStill.height)
            let yl = Double(mouth.maxY) + rg.chinRamp[0] * H, yc = yl + max(1e-3, rg.chinRamp[1]) * H
            let fw = data.flowSize.w, fh = data.flowSize.h
            rigLo = (0..<fh).map { gy in
                let Y = Double(data.roi.minY) + (Double(gy) + 0.5) / Double(fh) * Double(data.roi.height)
                return Float(min(1, max(0, (Y - yl) / (yc - yl))))
            }
            // living-lip noise: two smooth random 2-axis fields on the flow grid inside a soft mouth ellipse
            var rng = SplitMix64(seed: 17)
            func normal() -> Float {
                let u1 = max(1e-9, rng.nextUnit()), u2 = rng.nextUnit()
                return Float((-2 * log(u1)).squareRoot() * cos(2 * Double.pi * u2))
            }
            let cell = Double(data.roi.width) / Double(fw)
            let sig = max(0.6, rg.lipFlowSigma * Double(neutralStill.width) / cell)
            func base() -> [Float] {
                var z = (0..<(fw * fh * 2)).map { _ in normal() }
                z = Self.blurGrid(z, fw, fh, sigma: sig)
                let mx = z.map { abs($0) }.max() ?? 1
                return z.map { $0 / max(1e-6, mx) }
            }
            rigN1 = base(); rigN2 = base()
            let cxg = (Double(mouth.midX) - Double(data.roi.minX)) / cell - 0.5
            let cyg = (Double(mouth.midY) + 0.004 * H - Double(data.roi.minY)) / (Double(data.roi.height) / Double(fh)) - 0.5
            let rx = max(1, Double(mouth.width) / 2 * 1.1 / cell), ry = max(1, 0.03 * H / (Double(data.roi.height) / Double(fh)))
            let soft = max(0.15, 0.006 * Double(neutralStill.width) / cell / min(rx, ry))
            rigLipMask = (0..<(fw * fh)).map { i in
                let dx = (Double(i % fw) - cxg) / rx, dy = (Double(i / fw) - cyg) / ry
                let r = (dx * dx + dy * dy).squareRoot()
                return Float(1 - smoothstep(1 - soft, 1 + soft, r))
            }
            // slow share and gain per flow cell: chin rows (chinGain) and, optionally, the skin ring (skinGain)
            var loC = [Float](repeating: 0, count: fw * fh), gC = [Float](repeating: Float(rg.chinGain), count: fw * fh)
            for i in 0..<(fw * fh) {
                let dx = (Double(i % fw) - cxg) / rx, dy = (Double(i / fw) - cyg) / ry
                let skin = rg.skinShare * smoothstep(1.1, 1.6, (dx * dx + dy * dy).squareRoot())
                let row = Double(rigLo[i / fw])
                let lo = max(row, skin)
                loC[i] = Float(lo)
                if row + skin > 1e-6 { gC[i] = Float((row * rg.chinGain + skin * rg.skinGain) / (row + skin)) }
            }
            rigLoC = loC; rigGC = gC
        } else if let p = v2p, p.chinScale > 0, let mouth, data.map.drive != "snap" {
            // row weight w(y) = 1 − chinScale·clip((y − yl)/(yc − yl)), yl = lower lip + 3.5% H, yc = yl + 3% H
            let H = Double(neutralStill.height)
            let yl = Double(mouth.maxY) + 0.035 * H, yc = yl + 0.03 * H
            let fw = data.flowSize.w, fh = data.flowSize.h
            var rowW = [Float](repeating: 1, count: fh)
            for gy in 0..<fh {
                let Y = Double(data.roi.minY) + (Double(gy) + 0.5) / Double(fh) * Double(data.roi.height)
                rowW[gy] = Float(1 - p.chinScale * min(1, max(0, (Y - yl) / (yc - yl))))
            }
            func scaled(_ f: [Float]) -> [Float] {
                var o = f
                for gy in 0..<fh { let w = rowW[gy]; for gx in 0..<fw { let i = (gy * fw + gx) * 2; o[i] *= w; o[i + 1] *= w } }
                return o
            }
            nkF = nkF.mapValues(scaled); knF = knF.mapValues(scaled)
        }
    }
    /// Lip rig: interior masks per key (working res), chin share per flow-grid row (0 lips … 1 chin),
    /// living-lip noise bases and mouth ellipse on the flow grid.
    private let intPix: [String: [Float]]
    /// Lip rig teeth-layer textures (teethTop.tone); keys without one use their own texture.
    private var teethTex: [String: [Float]] = [:]
    private var rigLo: [Float] = []
    /// mouth box in working px (lip thinning)
    private var rigMouth: CGRect?
    /// The blend mask fades out across the chin line (rollback: false)
    nonisolated(unsafe) public static var chinStop = true
    /// how far below the neutral chin (share of the face height) an open jaw may still move
    nonisolated(unsafe) public static var jawRoom = 0.10
    /// v60: the magnifier's strength, low-passed (its peaks jumped: jerk 1.8 vs the reference 0.8)
    private var openKS: Float = 0, openKT: Double?
    private var stillH: Double = 0
    /// per flow cell: slow share and its gain (chin rows, skin ring)
    private var rigLoC: [Float] = [], rigGC: [Float] = []
    private var rigN1: [Float] = [], rigN2: [Float] = [], rigLipMask: [Float] = []
    private var rigChinX: [Double] = [], rigChinV: [Double] = [], rigT: Double?
    /// test hook: the chin's low-passed amounts of the last frame
    var debugChinAmounts: [Double] { rigChinX }
    private var rigTop: Int?
    private var rigPhase = 0.0
    private var rigRng = SplitMix64(seed: 29)
    /// Key flows used at runtime (v25: the chin below the lower lip follows them only partly).
    private(set) var nkF: [String: [Float]] = [:], knF: [String: [Float]] = [:]
    let workScale: Double
    /// v2: 356 px face-box height at 960 tall = 1 (clip .6…1.2).
    var faceNorm: Double = 1
    let stillWidth: Double
    /// Cheek / nasolabial coupling (people); nil = the morph ROI is the output.
    let cheekRig: CheekRig?
    /// Where the last output sits (still px, y down).
    var outputRect: CGRect { cheekRig?.region ?? data.roi }
    /// Corner displacement of the last frame per side (still px), from the neutral warp field.
    private var cornerD: [(Double, Double)] = [(0, 0), (0, 0)]
    /// Perioral low-pass state (corner displacement for the cheeks, drive amounts, loudness envelope).
    private var periD: [(Double, Double)]? = nil
    private var periA: (open: Double, ee: Double, round: Double, mbp: Double) = (0, 0, 0, 0)
    private var periLoud = 0.0, periT: Double?
    /// Where the blend stops below the face (still px, y down): the face box's bottom + `jawRoom`. Animals with a chin
    /// warp: at least 2.5 mouth heights under the mouth — prep keeps that band in the blend for animals (maskVersion 3);
    /// an animal's face box often ends at the mouth, which cut the moving chin off in a hard line.
    static func chinLine(data: FaceFlowData, face: CGRect, mouth: CGRect?) -> Double {
        let base = Double(face.maxY) + jawRoom * Double(face.height)
        guard data.map.chinWarp != nil, data.map.drive == "open", let mouth else { return base }
        return max(base, Double(mouth.maxY) + 2.5 * Double(mouth.height))
    }
    /// Animal chin warp: weight per flow cell, working px at full opening, low-passed opening and its clock.
    private var chinWarpW: [Float] = [], chinWarpPx: Float = 0
    private var chinO = 0.0, chinT: Double?

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
        if m.drive == "open", let jw = m.jaw { return openAmounts(lip, jw) }
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

    /// Animals: one jaw parameter from loudness × the vowel's openness, mapped onto the jaw keys
    /// (neutral at 0, then each step's key) by linear interpolation between neighbours.
    func openAmounts(_ lip: LipFrame, _ jw: FlowMap.Jaw) -> [String: Float] {
        let op = Double(min(1, max(0, lip.openness)))
        let w = lip.weights.mapValues(Double.init)
        let voiced = 1 - (w[.rest] ?? 0) - (w[.MBP] ?? 0) * (jw.mbpClose ?? 1)
        var f = 1.0
        if let vf = jw.vowel {
            let shaped = w.filter { $0.key != .rest && $0.key != .MBP }
            let tot = shaped.values.reduce(0, +)
            f = tot > 0 ? shaped.reduce(0) { $0 + $1.value * (vf[$1.key.rawValue] ?? vf["other"] ?? 0.5) } / tot : 0
        }
        let o = pow(max(0, min(1, (jw.floor + jw.gain * (data.map.gain ?? 1) * op) * f * max(0, voiced))), jw.gamma ?? 1)
        let steps: [(String?, Double)] = [(nil, 0)] + jw.steps.filter { resolve($0.key) == $0.key }.map { ($0.key, $0.value) }
        var amt: [String: Float] = [:]
        guard steps.count > 1 else { return amt }
        for i in 0..<(steps.count - 1) where o <= steps[i + 1].1 {
            let u = (o - steps[i].1) / max(1e-9, steps[i + 1].1 - steps[i].1)
            if let ka = steps[i].0 { amt[ka, default: 0] += Float(1 - u) }
            amt[steps[i + 1].0!, default: 0] += Float(u)
            return amt
        }
        let last = steps[steps.count - 1]
        amt[last.0!] = Float(last.1 > 0 ? min(1, o / last.1) : 1)
        return amt
    }

    private var motionX: [Float] = [], motionV: [Float] = []
    private var v2: MotionV2?
    private var v2Closed = false
    private var v2Shown: Int?
    /// Expression layer (v29): events on the reply's audio clock; only used when the rig was built with them.
    var expressionEvents: [FaceExpressionEvent] = []
    /// Laugh weight and audio time of the last frame (the renderer bobs the head with it).
    private(set) var lastLaugh: (w: Double, ms: Double) = (0, 0)

    /// Weight per tag at audio time `ms`: intensity × attack 250 ms before start, release 400 ms after end.
    func expressionWeights(atMs ms: Double) -> [String: Double] {
        var w: [String: Double] = [:]
        for e in expressionEvents {
            let a = smoothstep(Double(e.startMs) - 250, Double(e.startMs), ms) * (1 - smoothstep(Double(e.endMs), Double(e.endMs) + 400, ms))
            if a > 0 { w[e.tag, default: 0] += e.intensity * a }
        }
        return w
    }
    private var motionT: Double?
    private var loudPeak: Float = 0.3
    /// Texture amounts of the last motion step (focused, before amplitude), for the snap.
    private(set) var textureAmounts: [Float] = []

    var motion: FlowMap.Motion? { data.map.motion ?? (data.kind == "human" && data.map.drive == nil ? FlowMap.Motion() : nil) }

    /// Jaw floor shared by both steppers.
    private func applyJawFloor(_ raw: inout [String: Float], lip: LipFrame, at t: Double) {
        let top = lip.weights.max { $0.value < $1.value }?.key.rawValue ?? "rest"
        guard let jf = data.map.jawFloor ?? FlowMap.standard.jawFloor else { return }
        if jf.vowels.contains(top) { lastVowel = (t, raw) }
        else if !jf.closed.contains(top), let v = lastVowel, (t - v.t) * 1000 <= jf.windowMs, t >= v.t {
            for (k, a) in v.amounts { raw[k] = max(raw[k] ?? 0, Float(jf.share) * a) }
            let s = raw.values.reduce(0, +)
            if s > 1 { for (k, a) in raw { raw[k] = a / s } }
        }
    }

    /// Continuous geometry (spring) + separate texture amounts. `ahead` = the lip frame `aheadMs` later.
    func stepMotion(_ lip: LipFrame, ahead: LipFrame?, at t: Double, _ mo: FlowMap.Motion) -> [Float] {
        var raw = amounts(lip)
        applyJawFloor(&raw, lip: lip, at: t)
        let fps = data.map.smoothing.fps
        // closures: shut now, hold the map's minimum from the start
        var closing = false
        if let jm = order.firstIndex(of: "MBP") {
            let frames = (data.map.holdFrames ?? ["MBP": 2])["MBP"] ?? 2
            if (lip.weights[.MBP] ?? 0) >= 0.5 { if closeStart == nil { closeStart = t }; closing = true }
            else if let s0 = closeStart, t < s0 + Double(frames) / fps - 1e-6 { closing = true }
            else { closeStart = nil }
            _ = jm
        }
        // anticipation: blend toward what comes next (not into or out of a closure)
        let aheadTop = ahead?.weights.max { $0.value < $1.value }?.key
        if !closing, let ah = ahead, (ah.weights[.MBP] ?? 0) < 0.5, let at = aheadTop, at == .A || at == .O || at == .EI || at == .U {
            let ra = amounts(ah)
            let a = Float(mo.anticipation)
            for k in Set(raw.keys).union(ra.keys) where k != "MBP" { raw[k] = (1 - a) * (raw[k] ?? 0) + a * (ra[k] ?? 0) }
        }
        var x = order.map { raw[$0] ?? 0 }
        if closing, let jm = order.firstIndex(of: "MBP") { x = x.indices.map { $0 == jm ? 1 : 0 } }
        // texture: the prototype's focus on the unscaled amounts
        var tex = x
        let tt = tex.reduce(0, +)
        if data.map.focus > 1, tt > 1e-4 {
            let pw = tex.map { pow($0, Float(data.map.focus)) }; let ps = max(1e-9, pw.reduce(0, +))
            tex = pw.map { min(1, tt) * $0 / ps }
        }
        textureAmounts = tex
        // stress: loudness against a slowly decaying recent peak
        let op = min(1, max(0, lip.openness))
        let dtPeak = motionT.map { max(0, t - $0) } ?? 0
        loudPeak = max(op, loudPeak * Float(exp(-dtPeak / 1.2)), 0.05)
        let rel = Double(op / loudPeak)
        let stress = smoothstep(0.45, 0.85, rel)
        let gain = Float(mo.amplitude * (mo.unstressed + (1 - mo.unstressed) * stress))
        var target = order.indices.map { order[$0] == "MBP" ? x[$0] : x[$0] * gain }
        // idle micro-motion on the smallest jaw key (never through a closure)
        if !closing, mo.idleJaw > 0, let j0 = order.firstIndex(of: data.map.ladder.steps.first?.key ?? "MID") {
            let w = 2 * Double.pi * t
            let n = 0.5 + 0.5 * (sin(w * 0.37 + 1.3) * 0.6 + sin(w * 0.83 + 0.4) * 0.4)
            target[j0] += Float(mo.idleJaw * n) * (1 - min(1, op * 3))
        }
        // critically damped spring per key (closing m/b/p rises faster)
        if motionX.count != order.count { motionX = target; motionV = target.map { _ in 0 } }
        let dt = motionT.map { t - $0 } ?? 0
        motionT = t
        if dt <= 0 || dt > 0.5 { motionX = target; motionV = motionV.map { _ in 0 } } else {
            let steps = max(1, Int((dt * 240).rounded(.up))); let h = Float(dt) / Float(steps)
            for i in order.indices {
                let fast = order[i] == "MBP" && target[i] > motionX[i]
                let omega = Float(3.9 / ((fast ? mo.closeRiseMs : mo.riseMs) / 1000))
                for _ in 0..<steps {
                    let acc = omega * omega * (target[i] - motionX[i]) - 2 * omega * motionV[i]
                    motionV[i] += acc * h; motionX[i] += motionV[i] * h
                }
            }
        }
        var geo = motionX.map { min(1, max(0, $0)) }
        let gs = geo.reduce(0, +)
        if gs > 1 { geo = geo.map { $0 / gs } }
        if let cap = data.map.cap { for (k, c) in cap { if let j = order.firstIndex(of: k) { geo[j] = min(geo[j], Float(c)) } } }
        lastAmounts = Dictionary(uniqueKeysWithValues: zip(order, geo))
        return geo
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
        if data.map.focus > 1 {
            if t2 > 1e-4 {
                let focus = Float(data.map.focus)
                let pw = sm.map { pow($0, focus) }
                let ps = max(1e-9, pw.reduce(0, +))
                sm = pw.map { t2 * $0 / ps }
            } else { sm = sm.map { _ in 0 } }
        }
        if let cap = data.map.cap {
            for (k, c) in cap { if let j = order.firstIndex(of: k) { sm[j] = min(sm[j], Float(c)) } }
        }
        lastAmounts = Dictionary(uniqueKeysWithValues: zip(order, sm))
        return sm
    }

    /// Amounts used for the last rendered frame (tools, parity checks).
    private(set) var lastAmounts: [String: Float] = [:]

    // MARK: render

    /// The morphed ROI as premultiplied RGBA with alpha = mask (composite over the expression still).
    /// Barge-in / cancel: the mouth returns to the still at once (no smoothing tail, no held key).
    func reset() {
        smooth = smooth.map { _ in 0 }; snapW = smooth
        lastT = nil; snapT = nil; closeStart = nil; lastVowel = nil
        motionX = []; motionV = []; motionT = nil; loudPeak = 0.3
        v2?.reset()
        dominant = nil; dominantSince = -.infinity; candidate = nil; candidateRun = 0; shownHeld = 0
        snapKey = nil; snapHeld = 99; recentOpen = []; lastImage = nil; lastFrame = .min
        cornerD = [(0, 0), (0, 0)]
        rigChinX = []; rigChinV = []; rigT = nil; rigTop = nil
        periD = nil; periA = (0, 0, 0, 0); periLoud = 0; periT = nil
        expressionEvents = []
    }

    /// Parity checks: use these amounts (in `keys` order) instead of the lip timeline once.
    var amountsOverride: [Float]?

    func render(_ lip: LipFrame, ahead: LipFrame? = nil, context: LipContext? = nil, at t: Double) -> CGImage {
        let fps = data.map.smoothing.fps
        let frame = Int((t * fps).rounded())
        // On twos (3D characters): odd frames repeat the previous mouth (replacement-mouth look).
        if data.map.onTwos == true, frame % 2 == 1, let last = lastImage, lastFrame == frame - 1 { lastFrame = frame; return last }
        let image = data.map.drive == "snap" ? render2D(lip, at: t, frame: frame) : renderFlow(lip, ahead: ahead, context: context, at: t)
        lastImage = image; lastFrame = frame
        return image
    }
    private var lastImage: CGImage?
    private var lastFrame = Int.min

    // MARK: 2D snap mouths (no flows)

    private var snapKey: String?
    private var snapHeld = 99
    private var recentOpen: [Float] = []

    /// Which replacement mouth a 2D face shows (nil = the still's own closed line).
    func snapShape(_ lip: LipFrame) -> String? {
        guard let sn = data.map.snap else { return nil }
        let op = lip.openness
        if (lip.weights[.rest] ?? 0) >= 0.5 || Double(op) < sn.closedBelow { return nil }
        guard let dom = lip.weights.filter({ $0.key != .rest }).max(by: { $0.value < $1.value })?.key, dom != .MBP else { return nil }
        for r in sn.rules where r.visemes.contains(dom.rawValue) && Double(op) >= r.minLoudness {
            // minRun: loud for n frames in a row (causal: the frames ending now).
            if let n = r.minRun, recentOpen.suffix(n).count < n || recentOpen.suffix(n).contains(where: { Double($0) < r.minLoudness }) { continue }
            return resolve(r.key)
        }
        return resolve(sn.default)
    }

    private func render2D(_ lip: LipFrame, at t: Double, frame: Int) -> CGImage {
        let sn = data.map.snap
        recentOpen.append(lip.openness); if recentOpen.count > 16 { recentOpen.removeFirst() }
        if frame % max(1, sn?.hold ?? 2) == 0 {
            var k = snapShape(lip)
            if k != snapKey, snapHeld < (sn?.minHold ?? 2) { k = snapKey }
            if k != snapKey { snapHeld = 0 }
            snapKey = k
        }
        snapHeld += 1
        lastAmounts = Dictionary(uniqueKeysWithValues: order.map { ($0, $0 == snapKey ? Float(1) : 0) })
        let src = snapKey.flatMap { keyPix[$0] } ?? neutral
        var out = [UInt8](repeating: 0, count: width * height * 4)
        for i in 0..<(width * height) {
            let m = maskW[i], o = i * 4
            out[o] = UInt8(min(255, max(0, src[i * 3] * m)).rounded())
            out[o + 1] = UInt8(min(255, max(0, src[i * 3 + 1] * m)).rounded())
            out[o + 2] = UInt8(min(255, max(0, src[i * 3 + 2] * m)).rounded())
            out[o + 3] = UInt8(min(255, max(0, 255 * m)).rounded())
        }
        return PixelBuffer.makeImage(out, width: width, height: height)
    }

    // MARK: flow morph

    private func renderFlow(_ lip: LipFrame, ahead: LipFrame?, context: LipContext?, at t: Double) -> CGImage {
        let mo = motion
        var am: [Float]
        var usedV2 = false
        if mo != nil, let ctx = context, let p = data.map.motionV2 ?? (data.kind == "human" ? MotionV2Params() : nil),
           case let ph = ctx.timeline.phonemeTimings, !ph.isEmpty {
            if v2 == nil {
                let rigHuman = data.map.rig != nil && data.kind == "human"
                v2 = MotionV2(params: rigHuman ? p.v59() : p, faceNorm: faceNorm)
                v2!.useV60 = rigHuman && MotionV2.v60Ladders && p.preset != "v93"
            }
            if let r = v2!.step(ms: ctx.audioMs, phonemes: ph, openness: { ctx.timeline.loudness(atMs: $0) },
                                order: order, resolve: resolve) {
                am = r.amounts; v2Closed = r.closed; usedV2 = true
                textureAmounts = am
                lastAmounts = Dictionary(uniqueKeysWithValues: zip(order, am))
            } else { am = stepMotion(lip, ahead: ahead, at: t, mo!) }
        } else {
            am = mo.map { stepMotion(lip, ahead: ahead, at: t, $0) } ?? step(lip, at: t)
        }
        if let cap = data.map.cap, usedV2 { for (k, c) in cap { if let j = order.firstIndex(of: k) { am[j] = min(am[j], Float(c)) } } }
        // expression floors: open smile / laugh show teeth (never through a closure); laugh pulses "ha-ha"
        if let ctx = context, !expressionEvents.isEmpty, !(usedV2 ? v2Closed : closeStart != nil) {
            let ew = expressionWeights(atMs: ctx.audioMs)
            if let eh = order.firstIndex(of: "EH") ?? order.firstIndex(of: "EI") {
                let f = 0.35 * (ew["smileopen"] ?? 0) + 0.55 * (ew["laugh"] ?? 0)
                am[eh] = max(am[eh], Float(f))
            }
            if let sw = ew["surprised"], let ah = order.firstIndex(of: "AH") { am[ah] = max(am[ah], Float(0.3 * sw)) }
            if let lw = ew["laugh"], let ah2 = order.firstIndex(of: "AH2") {
                let pulse = pow(sin(2 * Double.pi * 4.5 * ctx.audioMs / 1000), 2)
                am[ah2] = max(am[ah2], Float(0.25 * lw * (0.6 + 0.4 * pulse)))
            }
        }
        var overridden = false
        if let o = amountsOverride, o.count == am.count { am = o; amountsOverride = nil; overridden = true }
        var (cw, shown) = colourWeights(mo == nil || overridden ? am : textureAmounts, at: t)
        if usedV2, !overridden {
            // v2 texture: the leading key above .12 (hysteresis .05 for the one shown), fading in with
            // its amount; a closure is geometry only (neutral texture).
            let mbpIdx = order.firstIndex(of: "MBP")
            var j = am.indices.filter { $0 != mbpIdx }.max { am[$0] < am[$1] }   // MBP: geometry only, never its texture
            if let jj = j, am[jj] < 0.12 { j = nil }
            if let d = v2Shown, let jj = j, jj != d, am[d] >= 0.12, am[jj] - am[d] < 0.05 { j = d }
            v2Shown = v2Closed ? nil : j
            cw = am.indices.map { i in
                guard i == v2Shown else { return 0 }
                return Float(min(1, max(0, (Double(am[i]) - 0.04) / 0.16)))
            }
        } else if mo != nil, !overridden {
            // Teeth/cavity texture only where the lips are really apart (a 1–2 px gap showed the
            // warped teeth as a silver wire); a closure shows the closed texture.
            let mbp = order.firstIndex(of: "MBP")
            if closeStart != nil { cw = cw.indices.map { $0 == mbp ? 1 : 0 }; if mbp == nil { cw = cw.map { _ in 0 } } }
            else {
                // each key's texture fades in with its own geometry: a key barely opened shows the still
                cw = cw.indices.map { $0 == mbp ? cw[$0] : cw[$0] * Float(smoothstep(0.16, 0.32, Double(am[$0]))) }
            }
        }
        // With a minimum hold the geometry follows the shown key too (no one-frame flow pops).
        if mo == nil, let n = data.map.minHold, n > 1 {
            let top = am.max() ?? 0
            if let j = shown { am = am.indices.map { $0 == j ? max(am[j], top, Float(data.map.shownFloor ?? 0)) : 0 } }
            else { am = am.map { min($0, Float(data.map.snapMin ?? 0.3)) * Float(data.map.neutralFlow ?? 1) } }
        }
        // Lip rig (v41): chin amounts low-passed; lip/skin texture cross-blended by share; teeth from the top key.
        let rg: FlowMap.Rig? = rigLo.isEmpty ? nil : data.map.rig
        var amC = am
        if let rg {
            let dtR = rigT.map { t - $0 } ?? 0
            rigT = t
            if rigChinX.count != am.count || dtR < 0 || dtR > 0.5 {
                rigChinX = am.map(Double.init); rigChinV = am.map { _ in 0 }        // warm start
            } else if dtR > 0 {
                let wq = 2 * Double.pi * rg.chinLpHz, hq = dtR / 8
                for _ in 0..<8 { for i in am.indices {
                    rigChinV[i] += hq * (wq * wq * (Double(am[i]) - rigChinX[i]) - 2 * wq * rigChinV[i])
                    rigChinX[i] += hq * rigChinV[i]
                } }
            }
            amC = rigChinX.map { Float(min(1, max(0, $0))) }
            if !intPix.isEmpty, usedV2, v2Closed {
                cw = cw.map { _ in 0 }; rigTop = nil          // a closure shows the closed (neutral) lips, never teeth
            } else if !intPix.isEmpty {
                let sk = am.indices.map { rg.noTex.contains(order[$0]) ? 0 : am[$0] }
                let tot = sk.reduce(0, +)
                let f = Float(min(1, max(0, (Double(tot) - rg.blendFloor[0]) / max(1e-3, rg.blendFloor[1]))))
                cw = sk.map { tot > 1e-4 ? $0 / tot * f : 0 }
                cw = cw.map { $0 < 0.02 ? 0 : $0 }      // a sliver of a key costs a full warp for nothing
                if let j = sk.indices.max(by: { sk[$0] < sk[$1] }) {
                    if Double(sk[j]) < rg.teethMin { rigTop = nil }
                    else if let c = rigTop, c < sk.count, Double(sk[j]) <= Double(sk[c]) + rg.teethHyst, Double(sk[c]) >= rg.teethAlpha[0] {}
                    else { rigTop = j }
                }
            } else { rigTop = nil }
        }
        let act = order.indices.filter { am[$0] > 1e-3 || (rg != nil && amC[$0] > 1e-3) }
        let a0 = max(0, 1 - cw.reduce(0, +))
        let fw = data.flowSize.w, fh = data.flowSize.h, n2 = fw * fh * 2
        let sx = Float(fw) / Float(width), sy = Float(fh) / Float(height)
        // Warp fields on the coarse flow grid (linear in the flows, so this equals combining the
        // upsampled flows), already in working px: GN for the neutral, GK per drawn key.
        var gn = [Float](repeating: 0, count: n2)
        var gs: [[Float]] = []
        for idx in act {
            let a = am[idx], f = nkF[order[idx]]!, bk = knF[order[idx]]!
            let cf = -a * (1 - a), cb = a * a
            var g = [Float](repeating: 0, count: n2)
            if let rg {
                // lips on the raw amount, the chin (rows below the lower lip) on the slow one × chinGain
                let ac = amC[idx]
                let cfL = -ac * (1 - ac), cbL = ac * ac
                for c in 0..<(fw * fh) {
                    let lo = rigLoC[c], gc = rigGC[c], q = c * 2
                    let cfy = cf * (1 - lo) + cfL * gc * lo, cby = cb * (1 - lo) + cbL * gc * lo
                    g[q] = (cfy * f[q] + cby * bk[q]) * kx; g[q + 1] = (cfy * f[q + 1] + cby * bk[q + 1]) * ky
                    gn[q] += g[q]; gn[q + 1] += g[q + 1]
                }
            } else {
                for q in stride(from: 0, to: n2, by: 2) {
                    g[q] = (cf * f[q] + cb * bk[q]) * kx; g[q + 1] = (cf * f[q + 1] + cb * bk[q + 1]) * ky
                    gn[q] += g[q]; gn[q + 1] += g[q + 1]
                }
            }
            gs.append(g)
        }
        // Micro-motion: a tiny smooth drift of the whole lower-face warp (people / motion profiles).
        if let mo = motion, mo.microPx > 0 {
            let w = 2 * Double.pi * t
            // lip life: loudness drives it (a talking mouth's skin never sits still)
            let life = (rg?.lipFlowPx ?? 0) > 0 ? 0 : (data.map.alive ?? (data.kind == "human" ? FlowMap.Alive() : nil))?.lipLifePx ?? 0
            let amp = mo.microPx * 0.5 + life * Double(min(1, max(0, lip.openness))) * 2
            let px = amp * workScale * stillWidth / 540     // px at 540 wide → working px
            let jx = Float(px * (sin(w * 2.3 + 0.7) * 0.6 + sin(w * 3.7 + 2.1) * 0.4))
            let jy = Float(px * (sin(w * 2.9 + 1.9) * 0.6 + sin(w * 4.1 + 0.3) * 0.4))
            for q in stride(from: 0, to: n2, by: 2) { gn[q] += jx; gn[q + 1] += jy }
        }
        // animals: the lower jaw and chin fur move down with the opening (sample from above = content moves down)
        if !chinWarpW.isEmpty, chinWarpW.count == fw * fh, let cw = data.map.chinWarp {
            var o = 0.0
            for st in data.map.jaw?.steps ?? [] { if let j = order.firstIndex(of: st.key) { o += Double(am[j]) * st.value } }
            o = min(1, max(0, o))
            let dtC = chinT.map { t - $0 } ?? 0
            chinT = t
            if dtC <= 0 || dtC > 0.5 { chinO = o } else { chinO += (o - chinO) * (cw.springMs > 0 ? 1 - exp(-dtC * 1000 / cw.springMs) : 1) }
            let d = chinWarpPx * Float(chinO)
            if d > 0.01 { for c in 0..<(fw * fh) { gn[2 * c + 1] -= d * chinWarpW[c] } }
        }
        let gnGeo = gn
        // Living lips (rig): loudness × a smooth random field inside the lips, re-drawn every frame,
        // plus a matching highlight shimmer (texture life, not geometry).
        var shG: [Float]? = nil
        if let rg, rg.lipFlowPx > 0, rigN1.count == n2, rigLipMask.count == fw * fh {
            rigPhase += 0.5 + 0.9 * rigRng.nextUnit()
            let rel = min(1.2, Double(max(0, lip.openness)) / 0.8)
            if rel > 0.02 {
                let px = Float(rel * rg.lipFlowPx * stillWidth / 540 * workScale)
                let c = Float(cos(rigPhase)), sn = Float(sin(rigPhase))
                for i in 0..<(fw * fh) {
                    let m = rigLipMask[i] * px
                    gn[2 * i] += (c * rigN1[2 * i] + sn * rigN2[2 * i]) * m
                    gn[2 * i + 1] += (c * rigN1[2 * i + 1] + sn * rigN2[2 * i + 1]) * m
                }
                if rg.lipTex > 0 {
                    let c2 = Float(cos(1.3 * rigPhase)), s2 = Float(sin(1.3 * rigPhase)), k = Float(rg.lipTex * min(1, rel))
                    shG = (0..<(fw * fh)).map { (c2 * rigN1[2 * $0] + s2 * rigN2[2 * $0 + 1]) * rigLipMask[$0] * k }
                }
            }
        }
        var drawn: [(key: [Float], w: Float, field: [Float], lip: [Float]?, teeth: [Float]?, u: Float, lf: Float)] = []
        // Every key with colour weight is drawn, including one still held by the snap rule after its
        // amount fell to 0 (leaving it out left that weight unpainted: a black mouth).
        let zero = [Float](repeating: 0, count: n2)
        // GK: the key's texture pulled to the common target (rig: the key's own term on the lip rows only)
        func keyField(_ idx: Int) -> [Float] {
            let a = am[idx], f = nkF[order[idx]]!, bk = knF[order[idx]]!
            let cf = (1 - a) * (1 - a), cb = -a * (1 - a)
            var g = [Float](repeating: 0, count: n2)
            let gj = act.firstIndex(of: idx).map { gs[$0] } ?? zero
            for c in 0..<(fw * fh) {
                let u: Float = rg == nil ? 1 : 1 - rigLoC[c], cfy = cf * u, cby = cb * u, q = c * 2
                g[q] = (cfy * f[q] + cby * bk[q]) * kx + gn[q] - gj[q]
                g[q + 1] = (cfy * f[q + 1] + cby * bk[q + 1]) * ky + gn[q + 1] - gj[q + 1]
            }
            return g
        }
        var fieldOf: [Int: [Float]] = [:]
        for idx in order.indices where cw[idx] > 0 {
            let a = am[idx]
            let g = keyField(idx); fieldOf[idx] = g
            let lf: Float = rg != nil && !intPix.isEmpty ? Float(min(1, max(0, (Double(a) - 0.04) / 0.16))) : 1
            let u = Float(smoothstep(0, 1, (Double(a) - 0.1) / 0.2))   // v30: teeth leave earlier on closing
            // teeth fade off: prep bakes the mouth's inside tone now (#266); the runtime fade read lip
            // highlights as teeth and left dark blotches on the upper lip (v8.6 render)
            drawn.append((keyPix[order[idx]]!, cw[idx], g, lipPix[order[idx]], nil, u, lf))
        }
        // Teeth layer (rig): the top key's mouth inside, opaque, alpha = its warped interior × opening.
        var teethL: (key: [Float], field: [Float], int: [Float], s: Float)? = nil
        if let rg, let j = rigTop, let ip = intPix[order[j]] {
            let s = Float(min(1, max(0, (Double(am[j]) - rg.teethAlpha[0]) / max(1e-3, rg.teethAlpha[1]))))
            let leaving = rg.teethExitBeforeClose && usedV2 && (v2?.preClose ?? false)
            if s > 0, !leaving { teethL = (teethTex[order[j]] ?? keyPix[order[j]]!, fieldOf[j] ?? keyField(j), ip, s) }
        }
        var out = [UInt8](repeating: 0, count: width * height * 4)
        let w = width, h = height
        // v57c lip thinning (spread vowels): band around the opening, centre column scanned on the teeth layer
        var thin: (yc: Float, R: Float, cx: Float, hw: Float, k: Float)? = nil
        // v58 open magnifier: (centre row, band above, band below, strength)
        var openW: (yc: Float, core: Float, eUp: Float, eDn: Float, rUp: Float, rDn: Float, cx: Float, hw: Float, paint: Bool, wid: Float, flat: Float)? = nil
        if rg != nil, let pr = cheekRig?.perioral, pr.lipThin > 0 || pr.openMag > 0, let mb = rigMouth, !(usedV2 && v2Closed) {
            let ewT = (context.map { expressionWeights(atMs: $0.audioMs) }) ?? [:]
            let swT = max(ewT["smile"] ?? 0, ewT["smileopen"] ?? 0, 0.8 * (ewT["laugh"] ?? 0))
            let spreadN = min(1, Double(["EH", "EI"].compactMap { order.firstIndex(of: $0) }.reduce(Float(0)) { $0 + am[$1] }) / 0.45) * (1 - swT)
            let k = Float(pr.lipThin * spreadN)
            // opening: every open / round / spread key (closures and fricatives excluded), with a knee so a
            // resting gap is left alone and only real vowels grow
            let openSum = Double(["AH", "AH2", "A", "OH", "O", "EH", "EI", "U", "MID"].compactMap { order.firstIndex(of: $0) }.reduce(Float(0)) { $0 + am[$1] })
            let openN = min(1, max(0, (openSum - 0.12) / 0.5))
            let koRaw = Float(pr.openMag * openN * openN * (3 - 2 * openN))
            let dtK = openKT.map { t - $0 } ?? 0
            openKT = t
            if dtK <= 0 || dtK > 0.5 { openKS = koRaw }
            else { openKS += (koRaw - openKS) * Float(min(1, dtK / 0.045)) }   // ~45 ms: softens the peaks, keeps the beat
            let ko = openKS
            // v60 vowel shape: open / spread keys open wide and flat (upper teeth band), only o / u / w round
            let roundSum = Double(["OH", "O", "U", "WQ"].compactMap { order.firstIndex(of: $0) }.reduce(Float(0)) { $0 + am[$1] })
            let flatShare = Float(openSum > 1e-3 ? max(0, min(1, 1 - roundSum / openSum)) : 0)
            if k > 0.01 || ko > 0.01 {
                var yc = Float(mb.midY), dop: Float = 1
                var ySplit: Float? = nil       // v58: the darkest row between the teeth rows (upper teeth stay up)
                if let tl = teethL {
                    let cx = Float(mb.midX), fxc = (cx + 0.5) * sx - 0.5
                    var lo = Float.infinity, hi = -Float.infinity
                    var lum: [(Float, Float)] = []
                    let y0 = max(0, Int(mb.minY - 2 * mb.height)), y1 = min(h - 1, Int(mb.maxY + 2 * mb.height))
                    if y0 < y1 { for yy in y0...y1 {
                        let dk = Self.bilinear2(tl.field, fw, fh, fxc, (Float(yy) + 0.5) * sy - 0.5)
                        if Self.bilinear1(tl.int, w, h, cx + dk.0, Float(yy) + dk.1) > 0.5 {
                            lo = min(lo, Float(yy)); hi = max(hi, Float(yy))
                            if ko > 0.01 {
                                var l: Float = 0
                                for ox in [-0.08, 0, 0.08] as [Float] {
                                    let c = Self.bilinear3(tl.key, w, h, cx + ox * Float(mb.width) + dk.0, Float(yy) + dk.1)
                                    l += c.0 + c.1 + c.2
                                }
                                lum.append((Float(yy), l))
                            }
                        }
                    } }
                    if hi >= lo { yc = (lo + hi) / 2; dop = max(1, (hi - lo) / 2) }
                    if lum.count >= 5 {
                        let a = lo + 0.2 * (hi - lo), b = hi - 0.15 * (hi - lo)
                        var best = Float.infinity
                        for i in 1..<(lum.count - 1) where lum[i].0 >= a && lum[i].0 <= b {
                            let v = lum[i - 1].1 + lum[i].1 + lum[i + 1].1
                            if v < best { best = v; ySplit = lum[i].0 }
                        }
                    }
                }
                let R = dop + Float(pr.lipThinPx * stillH) * Float(h) / Float(data.roi.height)
                if k > 0.01 { thin = (yc, R, Float(mb.midX), Float(mb.width / 2 * 1.05), k) }
                if ko > 0.01, ySplit != nil {   // no clean teeth rows at the centre (broken prep interiors): leave the opening alone
                    // the lower lip / lower teeth / chin translate down by eDn, the upper lip lifts by eUp; only a
                    // thin core of the opening (the dark middle) stretches, so teeth move but are never stretched
                    let pxH = Float(stillH) * Float(h) / Float(data.roi.height)
                    // flat (a / e / i) vowels drop 30% less and widen instead; round ones keep the full drop
                    let eDn = ko * Float(pr.openDnPx) * pxH * (1 - 0.3 * flatShare), eUp = ko * Float(pr.openUpPx) * pxH
                    let core = max(0.5, 0.2 * dop)
                    openW = (ySplit ?? yc, core, eUp, eDn, dop + eUp + 0.025 * pxH, dop + eDn + 0.06 * pxH, Float(mb.midX), Float(mb.width / 2 * 1.1), ySplit != nil,
                             ko * Float(pr.openWide) * flatShare, flatShare)
                }
            }
        }
        for y in 0..<h {
            let fy0 = (Float(y) + 0.5) * sy - 0.5
            for x in 0..<w {
                let i = y * w + x
                let m = maskW[i]
                var r = neutral[i * 3], g = neutral[i * 3 + 1], b = neutral[i * 3 + 2]
                if m > 0.002, !act.isEmpty || !drawn.isEmpty || shG != nil {
                    var fx = (Float(x) + 0.5) * sx - 0.5
                    var px = Float(x)
                    let py0 = Float(y)
                    var py = py0, fy = fy0
                    var cav: Float = 0          // v58: share of the dark mouth inside painted over this pixel
                    var pyT = py0, fyT = fy0
                    var cavT: Float = 0.5       // v60b: 0 at the top of the gap → 1 at the bottom (tongue side)    // v58: teeth rows — the opening's move only, never the v57c thinning (codex P2)
                    if let th = thin {
                        let d = abs(py0 - th.yc)
                        if d < th.R {
                            let u = (px - th.cx) / th.hw, u2 = u * u
                            let kx = th.k * exp(-(u2 * u2 * u2))
                            if kx > 0.002 {
                                py = th.yc + (py0 >= th.yc ? 1 : -1) * (d - kx * d * (th.R - d) / th.R)
                                fy = (py + 0.5) * sy - 0.5
                            }
                        }
                    }
                    if let ow = openW {
                        let dd = py - ow.yc, ad = abs(dd)
                        let R = dd >= 0 ? ow.rDn : ow.rUp
                        // v60 widen: flat vowels pull the mouth out sideways about its centre (fades with the band)
                        if ow.wid > 0.002, ad < R {
                            let v = 1 - ad / R, uw = (px - ow.cx) / (1.6 * ow.hw)
                            let hz = ow.wid * v * v * max(0, 1 - uw * uw)
                            if hz > 0.001 { px = ow.cx + (px - ow.cx) * (1 - hz); fx = (px + 0.5) * sx - 0.5 }
                        }
                        let u = (px - ow.cx) / ow.hw, u2 = u * u
                        let wu = max(0, 1 - u2)        // lens-shaped gap, nothing at the corners (a flat profile drew a slab)
                        let E = (dd >= 0 ? ow.eDn : ow.eUp) * wu * wu
                        if ad < R, E > 0.05 {
                            let c2 = ow.core + E
                            var sd: Float
                            if ad <= c2 {
                                // the new gap between the teeth: dark mouth inside (stretching it drew fangs)
                                sd = ad * ow.core / c2
                                let z = 1 - ad / c2
                                // the whole lens-shaped gap (it narrows to nothing at the corners): any stretched texture
                                // here — teeth rows (fangs, v58) or key teeth (white bars, v60 beard) — is covered
                                let ze = min(1, z / 0.6); cav = min(1, E / 2.0) * ze * ze * (3 - 2 * ze) * 0.95   // soft inner-lip edge
                                cavT = (dd / c2 + 1) / 2
                            }
                            else {                                                      // lips / teeth / chin translate, easing to 0 at R
                                let q = min(1, (R - ad) / max(1, R - c2))
                                sd = ad - E * q * q * (3 - 2 * q)
                            }
                            py = ow.yc + (dd >= 0 ? sd : -sd)
                            fy = (py + 0.5) * sy - 0.5
                        }
                        // the same opening move from the unthinned row, for the teeth layer
                        let dT = py0 - ow.yc, aT = abs(dT), RT = dT >= 0 ? ow.rDn : ow.rUp
                        let ET = (dT >= 0 ? ow.eDn : ow.eUp) * wu * wu
                        if aT < RT, ET > 0.05 {
                            let c2 = ow.core + ET
                            let sT: Float = aT <= c2 ? aT * ow.core / c2 : aT - ET * { let q = min(1, (RT - aT) / max(1, RT - c2)); return q * q * (3 - 2 * q) }()
                            pyT = ow.yc + (dT >= 0 ? sT : -sT); fyT = (pyT + 0.5) * sy - 0.5
                        }
                    }
                    let d = Self.bilinear2(gn, fw, fh, fx, fy)
                    let c0 = Self.bilinear3(neutral, w, h, px + d.0, py + d.1)
                    r = a0 * c0.0; g = a0 * c0.1; b = a0 * c0.2
                    for k in drawn {
                        let dk = Self.bilinear2(k.field, fw, fh, fx, fy)
                        var c = Self.bilinear3(k.key, w, h, px + dk.0, py + dk.1)
                        if let th = k.teeth, k.u < 1 {
                            let tmk = Self.bilinear1(th, w, h, px + dk.0, py + dk.1) * (1 - k.u)
                            c = (c.0 * (1 - tmk) + 30 * tmk, c.1 * (1 - tmk) + 17 * tmk, c.2 * (1 - tmk) + 19 * tmk)
                        }
                        if let lip = k.lip {
                            // the key's colour only inside its lip hull (warped with it); skin = warped neutral
                            let mk = Self.bilinear1(lip, w, h, px + dk.0, py + dk.1) * k.lf
                            c = (c.0 * mk + c0.0 * (1 - mk), c.1 * mk + c0.1 * (1 - mk), c.2 * mk + c0.2 * (1 - mk))
                        }
                        r += k.w * c.0; g += k.w * c.1; b += k.w * c.2
                    }
                    if let tl = teethL {
                        // teeth texture in its own (pre-thinning) coordinates; the alpha grows with the map
                        let tY = openW != nil ? pyT : py0, tFy = openW != nil ? fyT : fy0
                        let dk = Self.bilinear2(tl.field, fw, fh, fx, tFy)
                        var al = Self.bilinear1(tl.int, w, h, px + dk.0, tY + dk.1)
                        if py != tY {
                            let dm = Self.bilinear2(tl.field, fw, fh, fx, fy)
                            al = max(al, Self.bilinear1(tl.int, w, h, px + dm.0, py + dm.1))
                        }
                        al = min(1, al * tl.s)
                        if al > 0.002 {
                            var c = Self.bilinear3(tl.key, w, h, px + dk.0, tY + dk.1)
                            // v60b: the key's thin upper-teeth band reads a little brighter (bright pixels only, above the gap)
                            if let ow = openW, tY < ow.yc {
                                let l = (c.0 + c.1 + c.2) / 3, bw = min(1, max(0, (l - 120) / 60)) * 0.18
                                if bw > 0 { c = (c.0 + (255 - c.0) * bw, c.1 + (255 - c.1) * bw, c.2 + (255 - c.2) * bw) }
                            }
                            r = r * (1 - al) + c.0 * al; g = g * (1 - al) + c.1 * al; b = b * (1 - al) + c.2 * al
                        }
                    }
                    if cav > 0.002 {
                        // v60b: warm dark red-brown, #3a1a1a at the top → #5a2a2a toward the tongue (never a black hole)
                        let cr = 58 + 32 * cavT, cg = 26 + 16 * cavT, cb = 26 + 16 * cavT
                        r += (cr - r) * cav; g += (cg - g) * cav; b += (cb - b) * cav
                    }   // mouth shadow, not a black hole
                    if let sh = shG {
                        let v = Self.bilinear1(sh, fw, fh, fx, fy)
                        if v != 0 { let f = 1 + v * (0.5 + (r + g + b) / 765); r *= f; g *= f; b *= f }
                    }
                }
                let o = i * 4
                out[o] = UInt8(min(255, max(0, r * m)).rounded())
                out[o + 1] = UInt8(min(255, max(0, g * m)).rounded())
                out[o + 2] = UInt8(min(255, max(0, b * m)).rounded())
                out[o + 3] = UInt8(min(255, max(0, 255 * m)).rounded())
            }
        }
        guard let rig = cheekRig else { return PixelBuffer.makeImage(out, width: width, height: height) }
        // Corner displacement this frame (still px): −GN at each corner (GN maps output → neutral).
        var d: [(Double, Double)] = []
        for c in rig.cornersROI {
            let fx = Float(c.x * workScale + 0.5) * sx - 0.5, fy = Float(c.y * workScale + 0.5) * sy - 0.5
            let g = act.isEmpty ? (Float(0), Float(0)) : Self.bilinear2(gnGeo, fw, fh, fx, fy)
            d.append((-Double(g.0) / workScale, -Double(g.1) / workScale))
        }
        let lift = (rig.rules.liftAll ?? 0) >= 1
            ? min(1, am.reduce(0, +))
            : ["EH", "EI", "TEETH"].compactMap { order.firstIndex(of: $0) }.reduce(Float(0)) { $0 + am[$1] }
        let ew = (context.map { expressionWeights(atMs: $0.audioMs) }) ?? [:]
        lastLaugh = (ew["laugh"] ?? 0, context?.audioMs ?? 0)
        func sum(_ ks: [String]) -> Double { Double(ks.compactMap { order.firstIndex(of: $0) }.reduce(Float(0)) { $0 + am[$1] }) }
        let mbpA = sum(["MBP"])
        // v56 drivers: spread / round normalised (a stressed EY is only ~.3 of spread keys), straight from
        // the lips; open / closure low-passed below. A smile owns the corners: spread / round × (1 − w).
        let sw = max(ew["smile"] ?? 0, ew["smileopen"] ?? 0, 0.8 * (ew["laugh"] ?? 0))
        let peri = (open: min(1, max(0, Double(am.reduce(0, +)) - mbpA)), ee: min(1, sum(["EH", "EI"]) / 0.45) * (1 - sw),
                    round: min(1, sum(["O", "OH", "U", "WQ"]) / 0.6) * (1 - sw), mbp: min(1, mbpA))
        var dCheek = cornerD, periUse = peri, micro = (0.0, 0.0)
        if let pr = rig.perioral {
            let dt = periT.map { min(0.5, max(0, t - $0)) } ?? 0
            periT = t
            let a = pr.lpfMs > 0 && dt > 0 ? 1 - exp(-dt * 1000 / pr.lpfMs) : 1
            if periD == nil || dt >= 0.5 { periD = d; periA = peri }
            else {
                periD = zip(periD!, d).map { ($0.0 + a * ($1.0 - $0.0), $0.1 + a * ($1.1 - $0.1)) }
                periA = (periA.open + a * (peri.open - periA.open), periA.ee + a * (peri.ee - periA.ee),
                         periA.round + a * (peri.round - periA.round), periA.mbp + a * (peri.mbp - periA.mbp))
            }
            if pr.lpfMs > 0 { periUse = (periA.open + 0.25 * (1 - periA.open) * min(1, periLoud), peri.ee, peri.round, periA.mbp) }
            // loudness envelope: fast attack, 400 ms release, so the skin keeps living between syllables
            let o = Double(max(0, min(1, lip.openness)))
            periLoud = o > periLoud ? periLoud + (1 - exp(-dt / 0.04)) * (o - periLoud) : periLoud * exp(-dt / 0.4)
            if pr.microPx > 0 {
                let w = 2 * Double.pi * t, amp = pr.microPx * (0.35 + 0.65 * min(1, periLoud / 0.6))
                micro = (amp * (0.6 * sin(w * 2.1 + 0.4) + 0.4 * sin(w * 3.3 + 1.7)), amp * (0.6 * sin(w * 2.7 + 2.2) + 0.4 * sin(w * 3.9 + 0.9)))
            }
        }
        let image = rig.render(morph: out, morphWidth: width, morphHeight: height, d: d, dPrev: dCheek, lift: Double(lift), expressions: ew, peri: periUse, micro: micro)
        cornerD = d
        return image
    }

    /// Snap: only the dominant key's texture shows (one-frame cross-fade), so no half-dissolved
    /// grey teeth; a new dominant key must hold `minHoldMs` before the next switch (no chatter),
    /// closures excepted. Smooth: the prototype's S-curve weights.
    static let minHoldMs = 80.0

    private var shownHeld = 0
    private var candidate: Int?
    private var candidateRun = 0

    func colourWeights(_ am: [Float], at t: Double) -> (cw: [Float], shown: Int?) {
        let dz = data.map.dissolve ?? FlowMap.standard.dissolve!
        if dz.mode != "snap" {
            let e0 = Float(data.map.colourEdge), e1 = 1 - e0
            var cw = am.map { a -> Float in let u = min(1, max(0, (a - e0) / (e1 - e0))); return u * u * (3 - 2 * u) }
            let cs = cw.reduce(0, +)
            if cs > 1 { cw = cw.map { $0 / cs } }
            return (cw, nil)
        }
        let fps = data.map.smoothing.fps
        let dt = snapT.map { t - $0 } ?? (1 / fps)
        snapT = t
        let frames = Float(max(0, min(0.5, dt)) * fps)
        var j = am.indices.max { am[$0] < am[$1] }
        if let mo = motion {
            // Texture only, with hysteresis: a new key needs `textureOn` of the total and the shown one
            // must have fallen below `textureOff`; nothing shows below `textureMin`.
            let total = max(1e-6, am.reduce(0, +))
            if let jj = j, am[jj] < Float(mo.textureMin) { j = nil }
            if j != dominant, let jj = j, let d = dominant, am[d] >= Float(mo.textureMin) {
                if Double(am[jj] / total) < mo.textureOn || Double(am[d] / total) > mo.textureOff { j = d }
            }
            if j != dominant { dominant = j; dominantSince = t }
        } else {
        if let jj = j, am[jj] < Float(data.map.snapMin ?? dz.minAmount) { j = nil }
        if let n = data.map.minHold, n > 1 {
            // Profiles with minHold: a shown key stays ≥ n frames; a new one must lead n−1 frames running.
            candidateRun = j == candidate ? candidateRun + 1 : 1
            candidate = j
            if j != dominant {
                if shownHeld < n || candidateRun < n - 1 { j = dominant } else { dominant = j; shownHeld = 0 }
            }
            shownHeld += 1
        } else {
            let isClosure = j.map { order[$0] == "MBP" } ?? false
            if j != dominant {
                if !isClosure, dominant != nil, (t - dominantSince) * 1000 < Self.minHoldMs, dt > 0 { j = dominant }
                else { dominant = j; dominantSince = t }
            }
        }
        }
        let step = Float(min(1, 1000 / fps / max(1, dz.ms))) * max(1, frames)
        for i in snapW.indices {
            let target: Float = i == j ? 1 : 0
            snapW[i] += min(step, max(-step, target - snapW[i]))
        }
        if dt <= 0 || dt > 0.5 { snapW = snapW.indices.map { $0 == j ? 1 : 0 } }
        return (snapW, j)
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

    /// Bilinear single-channel sample; 0 outside (a warped mask has nothing beyond its edge).
    /// Teeth-layer texture (v44 teethTop.tone): inside the interior, low-saturation pixels darker than
    /// the interior's V percentile + 25 become a darker, warmer cavity; an upper band (rows above
    /// `split`, |dx| < `band`, fading 40 % toward the sides) of bright unsaturated pixels is lifted
    /// toward white by `teethLift`.
    static func toneTeeth(_ p: [Float], interior: [Float], width w: Int, height h: Int, tone: FlowMap.Rig.TeethTone) -> [Float] {
        var ys: [Int] = [], xs: [Int] = [], vs: [Float] = []
        for y in 0..<h { for x in 0..<w where interior[y * w + x] > 0.5 {
            let i = (y * w + x) * 3
            ys.append(y); xs.append(x); vs.append(max(p[i], p[i + 1], p[i + 2]))
        } }
        guard ys.count > 20, let y0 = ys.min(), let y1 = ys.max(), let x0 = xs.min(), let x1 = xs.max() else { return p }
        vs.sort(); let thr = vs[min(vs.count - 1, max(0, Int(Double(vs.count - 1) * min(100, max(0, tone.thrPct.isFinite ? tone.thrPct : 50)) / 100)))]
        let cx = Float(x0 + x1) / 2, hw = max(1, Float(x1 - x0) / 2), band = Float(tone.band), split = Float(tone.split)
        func clip(_ v: Float) -> Float { min(1, max(0, v)) }
        var teeth = [Float](repeating: 0, count: w * h)
        for y in y0...y1 {
            let r = Float(y - y0) / Float(max(1, y1 - y0)), up = clip((split - r) / 0.15)
            if up <= 0 { continue }
            for x in x0...x1 {
                let k = y * w + x, inn = interior[k] > 0.5 ? Float(1) : 0
                if inn == 0 { continue }
                let i = k * 3, mx = max(p[i], p[i + 1], p[i + 2]), mn = min(p[i], p[i + 1], p[i + 2])
                let sat = mx > 0 ? (mx - mn) / mx : 0
                let dx = abs(Float(x) - cx) / hw
                let bw = clip((band - dx) / 0.1) * (1 - 0.4 * clip(dx / band))
                teeth[k] = up * bw * clip((0.4 - sat) / 0.1) * clip((mx - thr) / 15)
            }
        }
        // v57c: the upper teeth read as one row — close horizontal gaps in the teeth band (kernel 2 % of the
        // ROI width) on the upper half of the interior, lifted at 70 %
        do {
            let kw = max(1, Int((0.02 * Double(w)).rounded()) / 2)
            var bin = [Bool](repeating: false, count: w * h), dil = bin
            for k in 0..<(w * h) { bin[k] = teeth[k] > 0.3 }
            for y in y0...y1 { for x in x0...x1 {
                var any = false
                for dx in -kw...kw { let xx = x + dx; if xx >= 0, xx < w, bin[y * w + xx] { any = true; break } }
                dil[y * w + x] = any
            } }
            let ymid = y0 + (y1 - y0) / 2
            for y in y0...ymid { for x in x0...x1 {
                let k = y * w + x
                guard dil[k], !bin[k], interior[k] > 0.5 else { continue }
                var all = true
                for dx in -kw...kw { let xx = x + dx; if xx < 0 || xx >= w || !dil[y * w + xx] { all = false; break } }
                if all { teeth[k] = max(teeth[k], 0.7) }
            } }
        }
        var o = p
        let white: (Float, Float, Float) = (242, 240, 238), lift = Float(tone.teethLift), dark = Float(tone.cavityDark)
        for y in y0...y1 { for x in x0...x1 {
            let k = y * w + x
            guard interior[k] > 0.5 else { continue }
            let i = k * 3, mx = max(p[i], p[i + 1], p[i + 2]), mn = min(p[i], p[i + 1], p[i + 2])
            let sat = mx > 0 ? (mx - mn) / mx : 0
            let t = teeth[k] * lift
            var c = (p[i] + (white.0 - p[i]) * t, p[i + 1] + (white.1 - p[i + 1]) * t, p[i + 2] + (white.2 - p[i + 2]) * t)
            let cav = (1 - clip(teeth[k] * 2)) * clip((0.35 - sat) / 0.1) * clip((thr + 25 - mx) / 20)
            if cav > 0 {
                // warm cavity: BGR × (0.8, 0.82, 1.1) → RGB × (1.1, 0.82, 0.8)
                c = (c.0 * (1 - cav) + c.0 * dark * 1.1 * cav, c.1 * (1 - cav) + c.1 * dark * 0.82 * cav, c.2 * (1 - cav) + c.2 * dark * 0.8 * cav)
            }
            o[i] = c.0; o[i + 1] = c.1; o[i + 2] = c.2
        } }
        return o
    }

    /// Lip tone (v8.8 review: lilac lips): per-channel gain of the lip mean from the texture to the
    /// photo (lip pixels = lip hull, redder than the skin around it); ±15 % max.
    static func lipToneGain(from n: [Float], to photo: [Float], lip: [Float], mask: [Float], strength: Float) -> (gain: (Float, Float, Float), skinRG: Float)? {
        let count = n.count / 3
        guard photo.count == n.count, lip.count == count, mask.count == count else { return nil }
        var skin: [Float] = []
        for i in stride(from: 0, to: count, by: 3) where lip[i] < 0.05 && mask[i] > 0.5 { skin.append(n[3 * i] - n[3 * i + 1]) }
        guard skin.count > 50 else { return nil }
        skin.sort(); let skinRG = skin[skin.count / 2]
        var a = (Float(0), Float(0), Float(0)), b = a, c: Float = 0
        for i in 0..<count where lip[i] > 0.5 && n[3 * i] - n[3 * i + 1] > skinRG + 12 {
            a.0 += n[3 * i]; a.1 += n[3 * i + 1]; a.2 += n[3 * i + 2]
            b.0 += photo[3 * i]; b.1 += photo[3 * i + 1]; b.2 += photo[3 * i + 2]; c += 1
        }
        guard c > 30 else { return nil }
        func g(_ t: Float, _ s: Float) -> Float { 1 + strength * (min(1.15, max(0.85, t / max(1, s))) - 1) }
        return ((g(b.0, a.0), g(b.1, a.1), g(b.2, a.2)), skinRG)
    }

    /// Applies a lip gain on the lip pixels only (weighted by how much redder than the skin they are).
    static func meanLipSat(_ p: [Float], lip: [Float], skinRG: Float) -> Float? {
        var s: Float = 0, c: Float = 0
        for i in 0..<(p.count / 3) where lip[i] > 0.5 && p[3 * i] - p[3 * i + 1] > skinRG + 12 {
            let mx = max(p[3 * i], p[3 * i + 1], p[3 * i + 2]), mn = min(p[3 * i], p[3 * i + 1], p[3 * i + 2])
            if mx > 0 { s += (mx - mn) / mx; c += 1 }
        }
        return c > 30 ? s / c : nil
    }

    static func applyLipGain(_ p: [Float], lip: [Float], interior: [Float]?, gain: (Float, Float, Float), skinRG: Float, satMax: Float? = nil) -> [Float] {
        let count = p.count / 3
        guard lip.count == count else { return p }
        var o = p
        for i in 0..<count where lip[i] > 0.01 {
            let red = p[3 * i] - p[3 * i + 1]
            let w = lip[i] * min(1, max(0, (red - skinRG - 6) / 20)) * (1 - min(1, interior?[i] ?? 0))
            if w <= 0 { continue }
            o[3 * i] *= 1 + (gain.0 - 1) * w; o[3 * i + 1] *= 1 + (gain.1 - 1) * w; o[3 * i + 2] *= 1 + (gain.2 - 1) * w
            if let sm = satMax {
                // saturation above the ceiling pulls toward the pixel's own max (grey at the same brightness)
                let mx = max(o[3 * i], o[3 * i + 1], o[3 * i + 2]), mn = min(o[3 * i], o[3 * i + 1], o[3 * i + 2])
                let sat = mx > 0 ? (mx - mn) / mx : 0
                if sat > sm {
                    let k = 1 - w * (1 - sm / sat)
                    for c in 0..<3 { o[3 * i + c] = mx - (mx - o[3 * i + c]) * k }
                }
            }
        }
        return o
    }

    /// Separable Gaussian blur of an interleaved 2-channel grid (edges clamped).
    static func blurGrid(_ v: [Float], _ w: Int, _ h: Int, sigma: Double) -> [Float] {
        let r = max(1, Int((3 * sigma).rounded(.up)))
        let k = (-r...r).map { Float(exp(-Double($0 * $0) / (2 * sigma * sigma))) }
        let ks = k.reduce(0, +)
        var a = [Float](repeating: 0, count: v.count), b = a
        for y in 0..<h { for x in 0..<w { for c in 0..<2 {
            var acc: Float = 0
            for j in -r...r { let xx = min(w - 1, max(0, x + j)); acc += k[j + r] * v[(y * w + xx) * 2 + c] }
            a[(y * w + x) * 2 + c] = acc / ks
        } } }
        for y in 0..<h { for x in 0..<w { for c in 0..<2 {
            var acc: Float = 0
            for j in -r...r { let yy = min(h - 1, max(0, y + j)); acc += k[j + r] * a[(yy * w + x) * 2 + c] }
            b[(y * w + x) * 2 + c] = acc / ks
        } } }
        return b
    }

    @inline(__always) static func bilinear1(_ v: [Float], _ w: Int, _ h: Int, _ x: Float, _ y: Float) -> Float {
        guard x > -1, y > -1, x < Float(w), y < Float(h) else { return 0 }
        let xc = min(Float(w - 1), max(0, x)), yc = min(Float(h - 1), max(0, y))
        let x0 = Int(xc), y0 = Int(yc), x1 = min(w - 1, x0 + 1), y1 = min(h - 1, y0 + 1)
        let ax = xc - Float(x0), ay = yc - Float(y0)
        return (v[y0 * w + x0] * (1 - ax) + v[y0 * w + x1] * ax) * (1 - ay) + (v[y1 * w + x0] * (1 - ax) + v[y1 * w + x1] * ax) * ay
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

/// Cheek and nasolabial coupling (reference: genita-mouth-proto render.py `--cheek`). After the mouth
/// morph, a smooth backward warp over the lower face: the cheek apples and the nasolabial fold follow the
/// mouth corners one frame late (`spread`), the corners are pulled back by their own move (`pull`), and
/// spread vowels lift the cheeks. The nose and everything above the lower eyelids are locked.
final class CheekRig: @unchecked Sendable {
    let region: CGRect           // still px, y down
    let width: Int, height: Int  // working px
    /// Mouth corners in ROI still px (for sampling the morph's warp field).
    let cornersROI: [(x: Double, y: Double)]
    private let scale: Double, stillToOut: Double
    let rules: FlowMap.Cheek
    private var geom: [Double] = []
    private let neutral: [Float]
    private let wCorner: [[Float]], wCheek: [[Float]]
    private let alpha: [Float]
    private let roiOrigin: (x: Int, y: Int)
    private var lockYpx = 0.0

    /// Perioral skin (map.perioral): ring around the lips (with its left/right split), the lower ring,
    /// philtrum and chin weights, working res.
    let perioral: FlowMap.Perioral?
    private var wRing: [Float] = [], wSideL: [Float] = [], wLower: [Float] = [], wPhil: [Float] = [], wChin: [Float] = [], wSpread: [[Float]] = [], wJaw: [Float] = []
    /// Expression layer fields per tag (dx, dy in still px per unit weight, working res), when enabled.
    private(set) var exprFields: [String: [Float]] = [:]
    /// Products of the perioral fields, fixed per face (render's vDSP warp): ring×side, ring×(1−side), ring + phil/2, spread R−L.
    private lazy var derived: (ringSide: [Float], ringOther: [Float], lw: [Float], spreadDiff: [Float]) = {
        let n = wRing.count
        guard n > 0, wSideL.count == n, wPhil.count == n else { return ([], [], [], []) }
        var rs = [Float](repeating: 0, count: n), ro = rs, lw = rs, sd = rs
        for k in 0..<n {
            rs[k] = wRing[k] * wSideL[k]; ro[k] = wRing[k] * (1 - wSideL[k]); lw[k] = wRing[k] + wPhil[k] * 0.5
        }
        if wSpread.count == 2, wSpread[0].count == n, wSpread[1].count == n { for k in 0..<n { sd[k] = wSpread[1][k] - wSpread[0][k] } }
        return (rs, ro, lw, sd)
    }()

    init(rules: FlowMap.Cheek, data: FaceFlowData, neutralStill: CGImage, scale s: Double, face: CGRect, mouth: CGRect, stillWidth: Double,
         expressions: Bool = false, perioral: FlowMap.Perioral? = nil) {
        self.rules = rules
        self.perioral = perioral.flatMap { $0.isOff ? nil : $0 }
        scale = s
        stillToOut = 540 / stillWidth           // the rules' pixel values are at 540 px wide
        let fw = Double(face.width), fh = Double(face.height)
        let cy = Double(mouth.midY)
        let geo = rules.geometry.flatMap { $0.count == 4 ? $0 : nil } ?? [0.12, 0.24, 0.15, 0.12]
        geom = geo
        // A small mouth (cats, rabbits: < 12% of the face width) puts the corners at the nose ±6%.
        let small = Double(mouth.width) < 0.12 * fw
        let cxL = small ? Double(mouth.midX) - 0.06 * fw : Double(mouth.minX), cxR = small ? Double(mouth.midX) + 0.06 * fw : Double(mouth.maxX)
        let corners = [(cxL, cy, -1.0), (cxR, cy, 1.0)]
        var r = data.roi
        for (cx, cy, sx) in corners {
            r = r.union(CGRect(x: cx - 0.15 * fw, y: cy - 0.12 * fh, width: 0.3 * fw, height: 0.24 * fh))
            let kx = cx + sx * geo[0] * fw, ky = cy - geo[1] * fh
            r = r.union(CGRect(x: kx - 2 * geo[2] * fw, y: ky - 2 * geo[3] * fh, width: 4 * geo[2] * fw, height: 4 * geo[3] * fh))
        }
        if expressions {   // brows to chin
            r = r.union(CGRect(x: face.minX, y: face.minY + face.height * 0.1, width: face.width, height: face.height * 0.95))
        }
        region = r.intersection(CGRect(x: 0, y: 0, width: neutralStill.width, height: neutralStill.height)).integral
        width = max(8, Int((Double(region.width) * s).rounded())); height = max(8, Int((Double(region.height) * s).rounded()))
        neutral = FlowMorph.rgb(neutralStill, crop: region, width: width, height: height)
        cornersROI = corners.map { ($0.0 - Double(data.roi.minX), $0.1 - Double(data.roi.minY)) }
        roiOrigin = (Int(((Double(data.roi.minX) - Double(region.minX)) * s).rounded()), Int(((Double(data.roi.minY) - Double(region.minY)) * s).rounded()))
        // Lock: the nose column down to the lock line, and everything above the lower eyelids.
        lockYpx = (data.lockY ?? Double(data.roi.minY) / Double(neutralStill.height)) * Double(neutralStill.height)
        let lockY = lockYpx
        let noseX = Double(mouth.midX)
        let noseBottom = lockY + 6 / stillToOut
        let eyeLine = Double(face.minY) + 0.42 * fh
        let feather = 0.03 * fw
        func soft(_ inside: Double) -> Double { smoothstep(-feather, feather, inside) }   // 1 inside, 0 outside
        var wc: [[Float]] = [], wk: [[Float]] = []
        var total = [Float](repeating: 0, count: width * height)
        for (cx, cy, sx) in corners {
            var a = [Float](repeating: 0, count: width * height), b = a
            for j in 0..<height {
                let Y = Double(region.minY) + (Double(j) + 0.5) / s
                for i in 0..<width {
                    let X = Double(region.minX) + (Double(i) + 0.5) / s
                    let inNose = soft(min(0.13 * fw - abs(X - noseX), noseBottom - Y))
                    let keep = max(inNose, soft(eyeLine - Y))
                    let free = 1 - keep
                    func g(_ x0: Double, _ y0: Double, _ sgx: Double, _ sgy: Double) -> Double {
                        exp(-(pow((X - x0) / sgx, 2) + pow((Y - y0) / sgy, 2)) / 2)
                    }
                    let k = j * width + i
                    a[k] = Float(g(cx, cy, 0.05 * fw, 0.04 * fh) * free)
                    b[k] = Float((rules.cheek * g(cx + sx * geo[0] * fw, cy - geo[1] * fh, geo[2] * fw, geo[3] * fh)
                                  + rules.naso * g(cx + sx * 0.04 * fw, cy - 0.09 * fh, 0.05 * fw, 0.06 * fh)) * free)
                    total[k] += a[k] + b[k]
                }
            }
            wc.append(a); wk.append(b)
        }
        wCorner = wc; wCheek = wk
        if let pr = self.perioral {
            let mw = Double(mouth.width), mh = Double(mouth.height), mx = Double(mouth.midX), my = Double(mouth.midY)
            let n = width * height
            var ring = [Float](repeating: 0, count: n), side = ring, lower = ring, phil = ring, chin = ring
            var spr = [ring, ring], jaw = ring
            let W = Double(neutralStill.width), Hs = Double(neutralStill.height)
            for j in 0..<height {
                let Y = Double(region.minY) + (Double(j) + 0.5) / s
                for i in 0..<width {
                    let X = Double(region.minX) + (Double(i) + 0.5) / s
                    let k = j * width + i
                    let inNose = soft(min(0.13 * fw - abs(X - noseX), noseBottom - Y))
                    let free = 1 - max(inNose, soft(eyeLine - Y))
                    let ex = (X - mx) / (mw / 2), ey = (Y - my) / max(1, mh / 2)
                    let insideLips = 1 - smoothstep(0.8, 1.3, (ex * ex + ey * ey).squareRoot())
                    let sg = pr.falloff * mw
                    let gR = exp(-(pow((X - mx) / sg, 2) + pow((Y - my) / (0.6 * sg), 2)) / 2)
                    ring[k] = Float(gR * (1 - insideLips) * free)
                    side[k] = Float(1 / (1 + exp((X - mx) / (0.1 * mw))))          // 1 on the left corner's side
                    lower[k] = ring[k] * Float(smoothstep(Double(mouth.maxY) - 0.2 * mh, Double(mouth.maxY) + 0.3 * mh, Y))
                    let gx = exp(-pow((X - mx) / (0.35 * mw), 2) / 2)
                    let up = min(1, max(0, (Y - lockY) / max(1, Double(mouth.minY) - lockY)))
                    let below = 1 - smoothstep(Double(mouth.minY), Double(mouth.minY) + 0.4 * mh, Y)
                    phil[k] = Float(gx * up * below * (1 - inNose * 0.5))
                    let gc = exp(-(pow((X - mx) / (0.5 * mw), 2) + pow((Y - (Double(mouth.maxY) + 0.05 * fh)) / (0.06 * fh), 2)) / 2)
                    chin[k] = Float(gc * free)
                    for (si, (cx, cy, _)) in corners.enumerated() {
                        // v55: centred on the corner, σ = half the mouth width (× .9 vertically)
                        let sg = max(1, mw / 2)
                        spr[si][k] = Float(exp(-(pow((X - cx) / sg, 2) + pow((Y - cy) / (0.9 * sg), 2)) / 2) * free)
                    }
                    let jy = Double(mouth.maxY) + 55.0 / 960 * Hs
                    jaw[k] = Float(exp(-(pow((X - mx) / (0.2 * W), 2) + pow((Y - jy) / (0.045 * Hs), 2)) / 2) * (1 - inNose))
                }
            }
            wRing = ring; wSideL = side; wLower = lower; wPhil = phil; wChin = chin; wSpread = spr; wJaw = jaw
            for k in 0..<n { total[k] += ring[k] + phil[k] + chin[k] + spr[0][k] + spr[1][k] + jaw[k] }
        }
        // Output coverage: the morph's mask plus wherever the warp reaches (the rest stays the base).
        let m = FlowMorph.rgb(data.mask, crop: CGRect(x: 0, y: 0, width: data.mask.width, height: data.mask.height),
                              width: max(1, Int((Double(data.roi.width) * s).rounded())), height: max(1, Int((Double(data.roi.height) * s).rounded())))
        let mw = max(1, Int((Double(data.roi.width) * s).rounded())), mh = max(1, Int((Double(data.roi.height) * s).rounded()))
        var al = total.map { min(1, 4 * $0) }
        for y in 0..<mh { for x in 0..<mw {
            let X = x + roiOrigin.x, Y = y + roiOrigin.y
            guard X >= 0, Y >= 0, X < width, Y < height else { continue }
            al[Y * width + X] = max(al[Y * width + X], m[(y * mw + x) * 3] / 255)
        } }
        if expressions {
            let f = Self.expressionFields(face: face, mouth: mouth, lockY: lockY, stillHeight: Double(neutralStill.height), region: region,
                                          width: width, height: height, scale: s)
            exprFields = f
            for (_, v) in f { for k in 0..<(width * height) { let m = abs(v[k * 2]) + abs(v[k * 2 + 1]); if m > 0.05 { al[k] = max(al[k], min(1, m * 2)) } } }
        }
        alpha = al
    }

    /// The v29 expression layer as displacement fields per tag (still px for weight 1).
    static func expressionFields(face: CGRect, mouth: CGRect, lockY: Double, stillHeight H0: Double, region: CGRect,
                                 width: Int, height: Int, scale s: Double) -> [String: [Float]] {
        let W = Double(face.width), H = Double(face.height)
        let fsc = (H * 960 / H0) / 356 * 3.2 * (H0 / 960)   // v30 gain 3.2      // spec px (960-high frame) → still px
        let mcx = Double(mouth.midX), mcy = Double(mouth.midY)
        let corners = [(Double(mouth.minX), mcy, -1.0), (Double(mouth.maxX), mcy, 1.0)]
        // eyes box from the face box (T9-measured proportions: x .23–.80 W, y .354–.419 H)
        let ex1 = Double(face.minX) + 0.229 * W, ex2 = Double(face.minX) + 0.803 * W
        let eyeY = Double(face.minY) + 0.386 * H, eh = 0.065 * H
        let eyes = [(ex1 + 0.25 * (ex2 - ex1), -1.0), (ex1 + 0.75 * (ex2 - ex1), 1.0)]
        let feather = 0.03 * W
        typealias Part = (cx: Double, cy: Double, sx: Double, sy: Double, dx: Double, dy: Double)
        // the outer quarter of the lips, gently: a smile mostly widens (×1.5 out, ×.6 up); a narrow
        // tip warp hooked the corners up like an emoji, a wide central one curled the lip line
        func corner(_ kx: Double, _ ky: Double, _ inward: Bool = false, dx0: Double = 3, dy0: Double = -4) -> [Part] {
            corners.map { (c) in (c.0, c.1, 0.09 * W, 0.035 * H, (inward ? -c.2 : c.2) * dx0 * kx * 1.5, dy0 * ky * 0.6) }   // v33: dx 4.5, dy −2.4
        }
        func cheekApple(_ k: Double) -> [Part] { eyes.map { e in (e.0 + 0.15 * (e.0 - mcx), eyeY + 0.17 * H, 0.09 * W, 0.06 * H, 0, -3 * k) } }
        func lowerLid(_ k: Double, _ dy: Double = -1.6, _ off: Double = 0.9) -> [Part] { eyes.map { e in (e.0, eyeY + off * eh, 0.07 * W, 0.6 * eh, 0, dy * k) } }
        func brows(_ dy: Double) -> [Part] { eyes.map { e in (e.0, eyeY - 2.2 * eh, 0.09 * W, 1.0 * eh, 0, dy) } }
        // v30: an eye-led smile (cheek apples −3.6, lower lids −2.4)
        let smile = corner(1, 1) + cheekApple(1.6) + lowerLid(2.0)
        var tags: [String: [Part]] = [:]
        tags["smile"] = smile
        tags["smileopen"] = smile.map { ($0.cx, $0.cy, $0.sx, $0.sy, $0.dx * 1.15, $0.dy * 1.15) }
        // laugh: the lower lip drops a little with the open mouth (it read as curled in)
        tags["laugh"] = corner(1.4, 1.5) + cheekApple(1.2) + lowerLid(1.9 * 1.5) + brows(-1.5)
            + [(mcx, Double(mouth.maxY), 0.12 * W, 0.025 * H, 0, 1.0)]
        tags["surprised"] = brows(-5) + eyes.map { e in (e.0, eyeY - 0.6 * eh, 0.06 * W, 0.35 * eh, 0, -1.6) } + lowerLid(1, 0.8, 0.7)
        tags["concerned"] = eyes.map { e in (e.0 + 0.45 * (mcx - e.0), eyeY - 2 * eh, 0.035 * W, 0.8 * eh, (mcx - e.0 > 0 ? 1.6 : -1.6), -2.6) }
            + eyes.map { e in (e.0 - 0.45 * (mcx - e.0), eyeY - 2 * eh, 0.05 * W, 0.8 * eh, 0, 1.2) }
            + corner(0.8 / 3, -0.5, true)   // corners dx −.8 inward, dy +2
        var out: [String: [Float]] = [:]
        for (tag, parts) in tags {
            var f = [Float](repeating: 0, count: width * height * 2)
            for j in 0..<height {
                let Y = Double(region.minY) + (Double(j) + 0.5) / s
                for i in 0..<width {
                    let X = Double(region.minX) + (Double(i) + 0.5) / s
                    // nose box stays put
                    let inNose = smoothstep(-feather, feather, min(0.1 * W - abs(X - mcx), min(Y - (eyeY + eh), lockY - Y)))
                    let free = 1 - inNose
                    var dx = 0.0, dy = 0.0
                    for p in parts {
                        let g = exp(-(pow((X - p.cx) / p.sx, 2) + pow((Y - p.cy) / p.sy, 2)) / 2)
                        dx += g * p.dx; dy += g * p.dy
                    }
                    let k = (j * width + i) * 2
                    f[k] = Float(dx * fsc * free); f[k + 1] = Float(dy * fsc * free)
                }
            }
            out[tag] = f
        }
        return out
    }

    /// The warped lower face over `region` (premultiplied RGBA, alpha = coverage).
    func render(morph: [UInt8], morphWidth mw: Int, morphHeight mh: Int, d: [(Double, Double)], dPrev: [(Double, Double)], lift: Double,
                expressions: [String: Double] = [:], peri: (open: Double, ee: Double, round: Double, mbp: Double) = (0, 0, 0, 0),
                micro: (Double, Double) = (0, 0)) -> CGImage {
        let active = expressions.filter { $0.value > 0.001 }.compactMap { k, w in exprFields[k].map { ($0, Float(w)) } }
        // Frame = neutral with the morph composited in.
        var frame = neutral
        for y in 0..<mh { for x in 0..<mw {
            let X = x + roiOrigin.x, Y = y + roiOrigin.y
            guard X >= 0, Y >= 0, X < width, Y < height else { continue }
            let o = (y * mw + x) * 4, k = (Y * width + X) * 3
            let a = Float(morph[o + 3]) / 255
            for c in 0..<3 { frame[k + c] = Float(morph[o + c]) + frame[k + c] * (1 - a) }
        } }
        let up = rules.lift * lift / stillToOut       // still px
        let pr = perioral
        let spreadK = rules.spread * (1 + (pr?.eeSpread ?? 0) * peri.ee)
        let bulge = (pr?.roundBulgePx ?? 0) * peri.round / stillToOut
        let lowerPx = (pr?.followOpenPx ?? 0) * peri.open / stillToOut
        let philPx = (pr?.philtrumPx ?? 0) * peri.open / stillToOut
        let chinPx = (pr?.mbpChinPx ?? 0) * peri.mbp / stillToOut
        let follow = pr?.follow ?? 0
        let sprPx = ((pr?.spreadPx ?? 0) * peri.ee - (pr?.roundInPx ?? 0) * peri.round) / stillToOut
        let jawPx = (pr?.jawDropPx ?? 0) * peri.open / stillToOut
        let mx = micro.0 / stillToOut, my = micro.1 / stillToOut
        // Mac CPU (QA: a call at 80 % on build 6, this loop ≈ half of it). The warp is linear in the weight fields with
        // per-frame coefficients, so it is built with vDSP (one multiply-add pass per field) instead of ~12 array reads
        // and ~40 Double ops per pixel; the per-pixel loop only samples. Float accumulation: differences ≤ 1e-5 px.
        let n = width * height
        var fx = [Float](repeating: 0, count: n), fy = [Float](repeating: 0, count: n)
        func add(_ w: [Float], _ c: Double, _ into: inout [Float]) {
            guard c != 0, w.count == n else { return }
            var s = Float(c)
            into.withUnsafeMutableBufferPointer { o in vDSP_vsma(w, 1, &s, o.baseAddress!, 1, o.baseAddress!, 1, vDSP_Length(n)) }
        }
        let d0 = d[0], d1 = d[1], p0 = dPrev[0], p1 = dPrev[1], pull = rules.pull
        add(wCheek[0], spreadK * p0.0 - bulge, &fx); add(wCorner[0], -pull * d0.0, &fx)
        add(wCheek[1], spreadK * p1.0 + bulge, &fx); add(wCorner[1], -pull * d1.0, &fx)
        add(wCheek[0], spreadK * p0.1 - up, &fy); add(wCorner[0], -pull * d0.1, &fy)
        add(wCheek[1], spreadK * p1.1 - up, &fy); add(wCorner[1], -pull * d1.1, &fy)
        if pr != nil {
            let dv = derived
            add(dv.ringSide, follow * d0.0, &fx); add(dv.ringOther, follow * d1.0, &fx); add(dv.lw, mx, &fx)
            if sprPx != 0 { add(dv.spreadDiff, sprPx, &fx) }
            add(dv.ringSide, follow * d0.1, &fy); add(dv.ringOther, follow * d1.1, &fy); add(dv.lw, my, &fy)
            add(wLower, lowerPx, &fy); add(wPhil, -philPx, &fy); add(wChin, -chinPx, &fy); add(wJaw, jawPx, &fy)
        }
        for (f, w) in active where f.count == 2 * n {
            var s = w
            f.withUnsafeBufferPointer { fp in
                fx.withUnsafeMutableBufferPointer { o in vDSP_vsma(fp.baseAddress!, 2, &s, o.baseAddress!, 1, o.baseAddress!, 1, vDSP_Length(n)) }
                fy.withUnsafeMutableBufferPointer { o in vDSP_vsma(fp.baseAddress! + 1, 2, &s, o.baseAddress!, 1, o.baseAddress!, 1, vDSP_Length(n)) }
            }
        }
        var out = [UInt8](repeating: 0, count: n * 4)
        let alpha = self.alpha
        out.withUnsafeMutableBufferPointer { out in
        for j in 0..<height {
            for i in 0..<width {
                let k = j * width + i
                let a = alpha[k]
                if a < 0.0001 { continue }   // every channel rounds to 0 (c·a < 0.5 for any c < 5000) = the buffer's zeros
                let vx = Double(fx[k]), vy = Double(fy[k])
                var c: (Float, Float, Float)
                if abs(vx) + abs(vy) < 0.01 { c = (frame[k * 3], frame[k * 3 + 1], frame[k * 3 + 2]) }
                else { c = FlowMorph.bilinear3(frame, width, height, Float(Double(i) - vx * scale), Float(Double(j) - vy * scale)) }
                let o = k * 4
                out[o] = UInt8(min(255, max(0, c.0 * a)).rounded())
                out[o + 1] = UInt8(min(255, max(0, c.1 * a)).rounded())
                out[o + 2] = UInt8(min(255, max(0, c.2 * a)).rounded())
                out[o + 3] = UInt8(min(255, max(0, 255 * a)).rounded())
            }
        }
        }
        return PixelBuffer.makeImage(out, width: width, height: height)
    }
}

/// What the v2 motion needs beyond one lip frame: the reply's audio clock (lookahead included) and
/// the timeline with its aligner phonemes.
public struct LipContext: @unchecked Sendable {
    public let audioMs: Double
    public let timeline: LipTimeline
    public init(audioMs: Double, timeline: LipTimeline) { self.audioMs = audioMs; self.timeline = timeline }
}

/// One expression from the server (`expression` event, per clause) on the reply's audio clock.
public struct FaceExpressionEvent: Equatable, Sendable {
    public var tag: String          // smile | smileopen | laugh | surprised | concerned
    public var intensity: Double    // 0…1
    public var startMs: Int, endMs: Int
    public init(tag: String, intensity: Double, startMs: Int, endMs: Int) {
        self.tag = tag; self.intensity = intensity; self.startMs = startMs; self.endMs = endMs
    }
}

