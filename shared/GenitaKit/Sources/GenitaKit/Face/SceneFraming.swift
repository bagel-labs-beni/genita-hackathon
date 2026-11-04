// L4 face · Face plan item 1: the call scene drawn in the face set's call-screen crop, so S09 can show the generated
// face at once (the scene arrives long before the face set is downloaded and computed) and the rest frame / live face
// that follow land on the same pixels. The scene is the face set's neutral still (server: `neutral` = the scene).

import CoreGraphics
import CoreImage
import Foundation

/// Zoom (1…2) about (`cx`, `cy`), fractions of the still, y down. Server: `GET /v1/companion/prep` → `framing`
/// (genita-server `sceneFraming`, the same rule as `FaceRenderer.framing(set)`).
public struct SceneFraming: Codable, Equatable, Sendable {
    public var zoom: Double
    public var cx: Double
    public var cy: Double
    public init(zoom: Double, cx: Double, cy: Double) { self.zoom = zoom; self.cx = cx; self.cy = cy }

    /// What the renderer uses for this face set.
    public init(_ set: FaceSet) {
        let fr = FaceRenderer.framing(set)
        let w = max(1, Double(set.pixelSize.width)), h = max(1, Double(set.pixelSize.height))
        self.init(zoom: Double(fr.zoom), cx: Double(fr.center.x) / w, cy: Double(fr.center.y) / h)
    }

    /// Out-of-range or non-finite values are brought back the way the renderer clamps them (nil = unusable).
    public var sanitized: SceneFraming? {
        guard zoom.isFinite, cx.isFinite, cy.isFinite else { return nil }
        return SceneFraming(zoom: min(2, max(1, zoom)), cx: min(1, max(0, cx)), cy: min(1, max(0, cy)))
    }
}

extension FaceRenderer {
    /// Still (Core Image coordinates, y up, origin 0) → output: aspect fill, the overscan unless Reduce Motion, then
    /// the framing zoom about `center` (still px, y up) where it already sits on screen. `image(at:)` draws with this.
    static func fillTransform(still: CGSize, output: CGSize, zoom: CGFloat, center: CGPoint, reduceMotion: Bool) -> CGAffineTransform {
        let scale = max(output.width / still.width, output.height / still.height) * (reduceMotion ? 1 : AliveMotion.overscan)
        var fill = CGAffineTransform(a: scale, b: 0, c: 0, d: scale,
                                     tx: (output.width - still.width * scale) / 2, ty: (output.height - still.height * scale) / 2)
        if zoom > 1.001 {
            // zoom about the framing point where it already sits on screen (inside the image: no edge shows)
            let c = center.applying(fill)
            fill = fill.concatenating(CGAffineTransform(translationX: -c.x, y: -c.y))
                .concatenating(CGAffineTransform(scaleX: zoom, y: zoom))
                .concatenating(CGAffineTransform(translationX: c.x, y: c.y))
        }
        return fill
    }

    /// The call scene as the face set's rest frame shows it: same output size, aspect fill, overscan and framing zoom,
    /// no motion (`AliveMotion` starts every run still). Same Core Image setup as `render(at:lip:)`.
    public static func framedScene(_ scene: CGImage, outputSize: CGSize, framing: SceneFraming, reduceMotion: Bool, context: CIContext? = nil) -> CGImage? {
        guard let fr = framing.sanitized, outputSize.width >= 1, outputSize.height >= 1 else { return nil }
        let still = CGSize(width: scene.width, height: scene.height)
        let center = CGPoint(x: fr.cx * still.width, y: still.height - fr.cy * still.height)
        let fill = fillTransform(still: still, output: outputSize, zoom: CGFloat(fr.zoom), center: center, reduceMotion: reduceMotion)
        let out = CGRect(origin: .zero, size: outputSize)
        let image = CIImage(cgImage: scene).clampedToExtent().transformed(by: fill).cropped(to: out)
        let ctx = context ?? CIContext(options: [.cacheIntermediates: false, .outputColorSpace: CGColorSpace(name: CGColorSpace.sRGB)!])
        return ctx.createCGImage(image, from: out, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
    }

    /// `framedScene` from the scene's encoded bytes (decoded as `FaceSet` decodes its neutral still).
    public static func framedScene(data: Data, outputSize: CGSize, framing: SceneFraming, reduceMotion: Bool) -> CGImage? {
        guard let cg = try? FaceSet.decode(data, name: "scene") else { return nil }
        return framedScene(cg, outputSize: outputSize, framing: framing, reduceMotion: reduceMotion)
    }
}
