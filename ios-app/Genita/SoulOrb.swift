import MetalKit
import SwiftUI
import UIKit

// Live soul orb: a native port of Dyno's three.js orb (bagel-labs-beni/genita 25afbe03, src/orb/entry.js +
// orb-motion.mjs), the one Chelsea wants moving "사르륵 사르륵" (11/4). Dyno's default template is the "dots" mode:
// 9,900 round points on a breathing sphere, folded by a simplex curl field, slowly morphing through eight shape
// profiles. Shaders: SoulOrb.metal. Constants are Dyno's; where a line differs from entry.js it says why.
// Rollback without a release: launch env GENITA_LIVE_ORB=0, or UserDefaults "GenitaLiveOrb" = false → the PNG orb.

/// Dyno's orb-motion.mjs: eight deformation families visited shuffle-bag without repeats, each transition 6–10 s
/// (motion time) eased with smootherstep, with ±3 % scale and ±8 % shape jitter and a random field offset.
struct SoulOrbMotion {
    struct Key: Equatable {
        var scale: SIMD3<Double>
        var shape: SIMD4<Double>
        var offset: SIMD3<Double>
    }
    static let profiles: [(scale: SIMD3<Double>, shape: SIMD4<Double>)] = [
        ([1.05, 0.88, 1.02], [0.82, 0.18, 0.30, 0.08]),
        ([0.78, 1.23, 0.94], [1.08, 0.48, 0.48, 0.16]),
        ([1.23, 0.76, 0.97], [0.95, -0.65, 0.32, 0.22]),
        ([0.97, 1.03, 1.08], [1.42, 0.30, 0.62, 0.12]),
        ([1.10, 0.98, 0.84], [0.76, -0.38, -0.36, 0.18]),
        ([0.88, 1.12, 1.02], [1.23, 0.85, 0.40, 0.28]),
        ([1.13, 0.92, 0.95], [1.52, -0.55, -0.48, 0.24]),
        ([0.95, 1.05, 1.00], [0.90, 0.05, 0.68, 0.32]),
    ]
    /// x³(6x² − 15x + 10)
    static func smootherstep(_ x: Double) -> Double { x * x * x * (x * (x * 6 - 15) + 10) }

    private let random: () -> Double
    private var bag: [Int] = []
    private var last = -1
    private var elapsed = 0.0
    private(set) var duration = 0.0
    private(set) var sequence: [Int] = []
    private var from: Key
    private var to: Key

    init(random: @escaping () -> Double = { Double.random(in: 0..<1) }) {
        self.random = random
        let placeholder = Key(scale: .one, shape: .zero, offset: .zero)
        from = placeholder; to = placeholder
        from = next(); to = next(); duration = 6 + random() * 4
    }

    private mutating func next() -> Key {
        if bag.isEmpty {
            bag = Array(0..<8)
            for i in stride(from: 7, to: 0, by: -1) { bag.swapAt(i, Int(floor(random() * Double(i + 1)))) }
            if bag[7] == last { bag.swapAt(7, 0) }
        }
        last = bag.removeLast(); sequence.append(last)
        let p = Self.profiles[last]
        // same draw order as the JS: scale x y z, shape x y z w, offset x y z
        var scale = p.scale, shape = p.shape, offset = SIMD3<Double>.zero
        for i in 0..<3 { scale[i] *= 0.97 + random() * 0.06 }
        for i in 0..<4 { shape[i] *= 0.92 + random() * 0.16 }
        for i in 0..<3 { offset[i] = random() * 5 - 2.5 }
        return Key(scale: scale, shape: shape, offset: offset)
    }

    mutating func update(_ dt: Double) -> Key {
        elapsed += max(0, dt)
        while elapsed >= duration { elapsed -= duration; from = to; to = next(); duration = 6 + random() * 4 }
        let w = Self.smootherstep(elapsed / duration)
        return Key(scale: from.scale + (to.scale - from.scale) * w,
                   shape: from.shape + (to.shape - from.shape) * w,
                   offset: from.offset + (to.offset - from.offset) * w)
    }
}

/// entry.js frame(): the clocks, the "response" reaction (activity) and the motion, per frame.
struct SoulOrbClock {
    /// Dyno's default template: speed 1.5, organic 2
    static let speed = 1.5, organic = 2.0
    /// Reduce Motion: a slow, single morph (no reaction burst)
    static let reducedSpeed = 0.35
    static let reactionSeconds = 2.5

    var idleClock = 0.0
    var time = 0.0
    var activity = 0.0
    var responding = false
    var reactionElapsed = 0.0
    var failureKind = false
    var reduceMotion = false
    var motion = SoulOrbMotion()
    var key: SoulOrbMotion.Key

    init(motion: SoulOrbMotion = SoulOrbMotion()) {
        var m = motion
        key = m.update(0)
        self.motion = m
    }

    /// window.soulOrb.responseComplete() / responseFailed()
    mutating func respond(failure: Bool = false) {
        guard !reduceMotion else { return }
        failureKind = failure; reactionElapsed = 0; responding = true
    }

    mutating func step(_ rawDt: Double) {
        let dt = min(max(rawDt, 0), 0.05)
        let speed = Self.speed * (reduceMotion ? Self.reducedSpeed : 1)
        idleClock += dt * speed
        if responding { reactionElapsed += dt; if reactionElapsed >= Self.reactionSeconds { responding = false } }
        let tau = responding ? (failureKind ? 0.18 : 0.65) : 0.20
        activity += ((responding ? 1 : 0) - activity) * (1 - exp(-dt / tau))
        time += dt * speed * (0.12 + 0.88 * activity)
        key = motion.update(dt * speed * Self.organic * (0.06 + 0.94 * activity))
    }

    var failure: Double { failureKind ? activity : 0 }
    var organicUniform: Double { Self.organic * (0.12 + 0.88 * activity) }
}

/// Layout mirrors `SoulOrbUniforms` in SoulOrb.metal (vectors first, then scalars).
struct SoulOrbUniforms {
    var motionShape = SIMD4<Float>(1, 0, 0.4, 0.1)
    var motionScale = SIMD4<Float>(1, 1, 1, 0)
    var fieldOffset = SIMD4<Float>(0, 0, 0, 0)
    var tint = SIMD4<Float>(0, 0, 0, 1)
    var accent = SIMD4<Float>(0, 0, 0, 1)
    var projection = SIMD2<Float>(1, 1)
    var depth = SIMD2<Float>(0, 0)
    var time: Float = 0
    var idleClock: Float = 0
    var activity: Float = 0
    var failure: Float = 0
    var spread: Float = 0.02
    var swirl: Float = 2
    var organic: Float = 0.24
    var dotSize: Float = 1.2
    var pixelRatio: Float = 3
    var densityGain: Float = 2
    var scaleX: Float = 1
    var cameraZ: Float = 6.8
    var softness: Float = 0.71
    var roundDot: Float = 1
}

enum SoulOrbLook {
    /// Dyno's default ("기준 템플릿") settings
    static let count = 9_900
    static let tintHex = 0x38BDFF, accentHex = 0xD1EDFF
    static let spread: Float = 0.02, swirl: Float = 2, dotSize: Float = 1.2, density: Float = 2, softness: Float = 0.71
    /// PerspectiveCamera(35°, …, 0.1, 30) at z 6.8, zoom 2.65
    static let fov = 35.0, zoom = 2.65, near = 0.1, far = 30.0, cameraZ = 6.8
    static let maxPixelRatio: CGFloat = 1.5

    /// three.js Color.set(hex) under ColorManagement: sRGB → linear
    static func linear(_ hex: Int) -> SIMD4<Float> {
        func c(_ v: Int) -> Float {
            let s = Float(v) / 255
            return s < 0.04045 ? s * 0.0773993808 : pow(s * 0.9478672986 + 0.0521327014, 2.4)
        }
        return SIMD4(c((hex >> 16) & 0xFF), c((hex >> 8) & 0xFF), c(hex & 0xFF), 1)
    }

    /// entry.js resize(): portrait boxes widen the fov so the orb keeps its width; wide boxes stretch x (`stretchWide`).
    static func projection(width: Double, height: Double) -> (xy: SIMD2<Float>, depth: SIMD2<Float>) {
        let aspect = max(width, 1) / max(height, 1)
        let tanHalf = tan(fov * .pi / 360) / min(1, aspect)
        let y = zoom / tanHalf, x = y / aspect
        let c = -(far + near) / (far - near), d = -2 * far * near / (far - near)
        return (SIMD2(Float(x), Float(y)), SIMD2(Float(c), Float(d)))
    }

    /// The seeds: entry.js's LCG from 9182, four per point (Float32 like its Float32Array).
    static func seeds(count: Int) -> [SIMD4<Float>] {
        var state: UInt32 = 9182
        func rand() -> Float { state = state &* 1_664_525 &+ 1_013_904_223; return Float(Double(state) / 4_294_967_296) }
        return (0..<count).map { _ in SIMD4(rand(), rand(), rand(), rand()) }
    }
}

/// Feature flag (default ON) + whether this device can draw it.
enum SoulOrbFlag {
    static var isOn: Bool {
        if ProcessInfo.processInfo.environment["GENITA_LIVE_ORB"] == "0" { return false }
        if let stored = UserDefaults.standard.object(forKey: "GenitaLiveOrb") as? Bool, !stored { return false }
        return SoulOrbGPU.shared != nil
    }
}

/// Device, pipelines and the seed buffer, built once.
final class SoulOrbGPU {
    static let shared: SoulOrbGPU? = SoulOrbGPU()
    let device: MTLDevice
    let queue: MTLCommandQueue
    let points: MTLRenderPipelineState
    let composite: MTLRenderPipelineState
    let seeds: MTLBuffer

    private init?() {
        guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue(),
              let library = device.makeDefaultLibrary(),
              let pointVertex = library.makeFunction(name: "soul_orb_points"),
              let pointFragment = library.makeFunction(name: "soul_orb_point_fragment"),
              let fullVertex = library.makeFunction(name: "soul_orb_full"),
              let compositeFragment = library.makeFunction(name: "soul_orb_composite") else { return nil }
        let p = MTLRenderPipelineDescriptor()
        p.label = "soul-orb points"
        p.vertexFunction = pointVertex; p.fragmentFunction = pointFragment
        // three.js NormalBlending (straight alpha): rgb = src·a + dst·(1−a), alpha = src + dst·(1−a)
        let a = p.colorAttachments[0]!
        a.pixelFormat = .rgba16Float
        a.isBlendingEnabled = true
        a.rgbBlendOperation = .add; a.alphaBlendOperation = .add
        a.sourceRGBBlendFactor = .sourceAlpha; a.destinationRGBBlendFactor = .oneMinusSourceAlpha
        a.sourceAlphaBlendFactor = .one; a.destinationAlphaBlendFactor = .oneMinusSourceAlpha
        let c = MTLRenderPipelineDescriptor()
        c.label = "soul-orb composite"
        c.vertexFunction = fullVertex; c.fragmentFunction = compositeFragment
        c.colorAttachments[0].pixelFormat = .bgra8Unorm
        let seedData = SoulOrbLook.seeds(count: SoulOrbLook.count)
        guard let points = try? device.makeRenderPipelineState(descriptor: p),
              let composite = try? device.makeRenderPipelineState(descriptor: c),
              let seeds = device.makeBuffer(bytes: seedData, length: MemoryLayout<SIMD4<Float>>.stride * seedData.count, options: .storageModeShared)
        else { return nil }
        self.device = device; self.queue = queue; self.points = points; self.composite = composite; self.seeds = seeds
    }
}

/// Draws the orb each frame: points into a half-float target, then the tone-mapped composite into the drawable.
final class SoulOrbRenderer: NSObject, MTKViewDelegate {
    var clock = SoulOrbClock()
    var stretchWide = true
    var lastReaction = 0
    var lastFailure = 0
    private var lastTime: CFTimeInterval?
    private var scene: MTLTexture?
    private let stats = SoulOrbStats()

    func resetClock() { lastTime = nil }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) { scene = nil }

    func draw(in view: MTKView) {
        guard let gpu = SoulOrbGPU.shared, let drawable = view.currentDrawable,
              let pass = view.currentRenderPassDescriptor else { return }
        let size = view.drawableSize
        guard size.width >= 1, size.height >= 1 else { return }
        if scene == nil || scene!.width != Int(size.width) || scene!.height != Int(size.height) {
            let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba16Float, width: Int(size.width), height: Int(size.height), mipmapped: false)
            d.usage = [.renderTarget, .shaderRead]; d.storageMode = .private
            scene = gpu.device.makeTexture(descriptor: d)
        }
        guard let scene, let buffer = gpu.queue.makeCommandBuffer() else { return }

        let now = CACurrentMediaTime()
        clock.step(lastTime.map { now - $0 } ?? 0)
        lastTime = now
        stats.frame(at: now)

        let bounds = view.bounds.size
        let proj = SoulOrbLook.projection(width: bounds.width, height: bounds.height)
        var u = SoulOrbUniforms()
        let k = clock.key
        u.motionShape = SIMD4(Float(k.shape.x), Float(k.shape.y), Float(k.shape.z), Float(k.shape.w))
        u.motionScale = SIMD4(Float(k.scale.x), Float(k.scale.y), Float(k.scale.z), 0)
        u.fieldOffset = SIMD4(Float(k.offset.x), Float(k.offset.y), Float(k.offset.z), 0)
        u.tint = SoulOrbLook.linear(SoulOrbLook.tintHex)
        u.accent = SoulOrbLook.linear(SoulOrbLook.accentHex)
        u.projection = proj.xy; u.depth = proj.depth
        u.time = Float(clock.time); u.idleClock = Float(clock.idleClock)
        u.activity = Float(clock.activity); u.failure = Float(clock.failure)
        u.spread = SoulOrbLook.spread; u.swirl = SoulOrbLook.swirl; u.organic = Float(clock.organicUniform)
        u.dotSize = SoulOrbLook.dotSize; u.pixelRatio = Float(view.contentScaleFactor)
        u.densityGain = SoulOrbLook.density; u.softness = SoulOrbLook.softness; u.roundDot = 1
        u.scaleX = stretchWide ? Float(max(1, bounds.width / max(bounds.height, 1))) : 1
        u.cameraZ = Float(SoulOrbLook.cameraZ)

        let offscreen = MTLRenderPassDescriptor()
        offscreen.colorAttachments[0].texture = scene
        offscreen.colorAttachments[0].loadAction = .clear
        offscreen.colorAttachments[0].storeAction = .store
        offscreen.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        if let e = buffer.makeRenderCommandEncoder(descriptor: offscreen) {
            e.setRenderPipelineState(gpu.points)
            e.setVertexBuffer(gpu.seeds, offset: 0, index: 0)
            e.setVertexBytes(&u, length: MemoryLayout<SoulOrbUniforms>.stride, index: 1)
            e.setFragmentBytes(&u, length: MemoryLayout<SoulOrbUniforms>.stride, index: 1)
            e.drawPrimitives(type: .point, vertexStart: 0, vertexCount: SoulOrbLook.count)
            e.endEncoding()
        }
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        if let e = buffer.makeRenderCommandEncoder(descriptor: pass) {
            e.setRenderPipelineState(gpu.composite)
            e.setFragmentTexture(scene, index: 0)
            e.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
            e.endEncoding()
        }
        if stats.enabled { buffer.addCompletedHandler { [stats] b in stats.gpu(b.gpuEndTime - b.gpuStartTime) } }
        buffer.present(drawable)
        buffer.commit()
    }
}

/// GENITA_ORB_STATS=1: fps and GPU time per frame, logged and written to tmp/soul-orb-stats.txt every 120 frames.
final class SoulOrbStats: @unchecked Sendable {
    let enabled = ProcessInfo.processInfo.environment["GENITA_ORB_STATS"] == "1"
    private let lock = NSLock()
    private var frames: [CFTimeInterval] = []
    private var gpuTimes: [Double] = []

    func frame(at t: CFTimeInterval) {
        guard enabled else { return }
        lock.lock(); defer { lock.unlock() }
        frames.append(t)
        guard frames.count >= 121 else { return }
        let fps = Double(frames.count - 1) / (frames.last! - frames.first!)
        let g = gpuTimes.sorted()
        let p50 = g.isEmpty ? 0 : g[g.count / 2] * 1000, p95 = g.isEmpty ? 0 : g[min(g.count - 1, g.count * 95 / 100)] * 1000
        let line = String(format: "soul-orb fps=%.1f gpu_ms_p50=%.2f gpu_ms_p95=%.2f n=%d\n", fps, p50, p95, g.count)
        NSLog("%@", line)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("soul-orb-stats.txt")
        if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(Data(line.utf8)); try? h.close() }
        else { try? line.write(to: url, atomically: true, encoding: .utf8) }
        frames = [frames.last!]; gpuTimes = []
    }

    func gpu(_ seconds: Double) {
        lock.lock(); gpuTimes.append(seconds); lock.unlock()
    }
}

/// Pauses off-screen and in the background (no frames, no GPU).
final class SoulOrbMTKView: MTKView {
    weak var orbRenderer: SoulOrbRenderer?
    private var background = UIApplication.shared.applicationState == .background
    private var observers: [NSObjectProtocol] = []

    init(device: MTLDevice) {
        super.init(frame: .zero, device: device)
        colorPixelFormat = .bgra8Unorm
        clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        isOpaque = false; layer.isOpaque = false; backgroundColor = .clear
        enableSetNeedsDisplay = false
        isUserInteractionEnabled = false
        preferredFramesPerSecond = 60
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.background = true; self?.updatePaused()
        })
        observers.append(center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.background = false; self?.updatePaused()
        })
        updatePaused()
    }

    required init(coder: NSCoder) { fatalError("init(coder:) is not used") }
    deinit { for o in observers { NotificationCenter.default.removeObserver(o) } }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        // entry.js: renderer.setPixelRatio(min(devicePixelRatio, 1.5)) — drawn at 1.5× and scaled up, which is what
        // gives Dyno's dots their soft edge (and costs a quarter of the 3× pixels)
        if let window { contentScaleFactor = min(window.screen.scale, SoulOrbLook.maxPixelRatio) }
        updatePaused()
    }

    private func updatePaused() {
        let pause = window == nil || background
        if isPaused != pause { isPaused = pause; if !pause { orbRenderer?.resetClock() } }
    }
}

/// The live orb filling its frame like Dyno's iframe fills the soul-orb node's box.
struct SoulOrbView: UIViewRepresentable {
    /// wide boxes stretch the orb horizontally, as entry.js does (points.scale.x = w / h)
    var stretchWide = true
    /// change it to play "response complete" (2.5 s reaction, activity → 1)
    var reaction = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeCoordinator() -> SoulOrbRenderer { SoulOrbRenderer() }

    func makeUIView(context: Context) -> SoulOrbMTKView {
        let view = SoulOrbMTKView(device: SoulOrbGPU.shared!.device)
        view.orbRenderer = context.coordinator
        view.delegate = context.coordinator
        context.coordinator.lastReaction = reaction
        return view
    }

    func updateUIView(_ view: SoulOrbMTKView, context: Context) {
        let renderer = context.coordinator
        renderer.stretchWide = stretchWide
        renderer.clock.reduceMotion = reduceMotion
        view.preferredFramesPerSecond = reduceMotion ? 30 : 60
        if reaction != renderer.lastReaction {
            renderer.lastReaction = reaction
            renderer.clock.respond()
        }
    }
}

/// A soul-orb design node: the live orb, or the PNG when the flag is off or Metal is missing.
struct SoulOrbSlot: View {
    var node: DesignNode
    var resource: String
    var body: some View {
        if SoulOrbFlag.isOn {
            SoulOrbView().frame(width: node.w, height: node.h).accessibilityHidden(true)
        } else {
            DesignImage(node: node, resource: resource)
        }
    }
}
