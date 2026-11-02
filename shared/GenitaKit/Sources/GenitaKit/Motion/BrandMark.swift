import SwiftUI

/// The Genita brandmark (eye-like G with its orbit line), from ios-app/Genita/Resources/brandmark.svg
/// (152 × 70.9945, one filled path: the eye/G outline, then the orbit). Scales to fit its frame.
public struct BrandMarkShape: Shape {
    public static let size = CGSize(width: 152, height: 70.9945)
    /// centre of the G's round counter in mark units (the "pupil" the light follows)
    public static let pupil = CGPoint(x: 88.5, y: 35.5)

    public enum Part: Sendable { case all, eye, orbit }
    /// 0…1 vertical opening (the eye opens): squashes the geometry, not the stroke
    public var open: CGFloat
    /// draw only the eye/G or only the orbit line (splash B draws them one after the other)
    public var part: Part

    public init(open: CGFloat = 1, part: Part = .all) {
        self.open = open
        self.part = part
    }

    public var animatableData: CGFloat {
        get { open }
        set { open = newValue }
    }

    public func path(in rect: CGRect) -> Path {
        guard open < 0.999 else { return unitPath(in: rect) }
        let t = CGAffineTransform(translationX: 0, y: rect.midY).scaledBy(x: 1, y: max(open, 0.001)).translatedBy(x: 0, y: -rect.midY)
        return unitPath(in: rect).applying(t)
    }

    private func unitPath(in rect: CGRect) -> Path {
        let s = min(rect.width / Self.size.width, rect.height / Self.size.height)
        let ox = rect.midX - Self.size.width * s / 2
        let oy = rect.midY - Self.size.height * s / 2
        func P(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: ox + x * s, y: oy + y * s) }
        var p = Path()
        if part != .orbit {
        // eye + G
        p.move(to: P(0, 35.4971))
        p.addCurve(to: P(104.946, 8.6279), control1: P(0.0014, 24.6412), control2: P(68.2085, -18.0441))
        p.addCurve(to: P(88.5, 3.9971), control1: P(100.159, 5.6915), control2: P(94.5276, 3.9971))
        p.addCurve(to: P(58.1191, 27.1533), control1: P(73.9919, 3.9971), control2: P(61.7766, 13.806))
        p.addCurve(to: P(24, 35.9971), control1: P(37.8275, 28.8303), control2: P(24.0007, 32.1607))
        p.addCurve(to: P(58.415, 44.8633), control1: P(24.0005, 39.8521), control2: P(37.962, 43.1943))
        p.addCurve(to: P(88.5, 66.9971), control1: P(62.403, 57.6865), control2: P(74.3646, 66.9971))
        p.addCurve(to: P(104.946, 62.3662), control1: P(94.5277, 66.9971), control2: P(100.159, 65.3027))
        p.addCurve(to: P(0, 35.4971), control1: P(68.2085, 89.0386), control2: P(0.001, 46.3528))
        p.closeSubpath()
        }
        if part != .eye {
        // orbit
        p.move(to: P(89, 26.5))
        p.addCurve(to: P(119, 26), control1: P(92.8333, 26), control2: P(104.2, 25.2))
        p.addLine(to: P(119.005, 26.0088))
        p.addCurve(to: P(152, 34.7578), control1: P(138.682, 27.7146), control2: P(152, 30.9926))
        p.addCurve(to: P(118.608, 43.541), control1: P(152, 38.5483), control2: P(138.503, 41.845))
        p.addCurve(to: P(120, 34.2578), control1: P(119.512, 40.6063), control2: P(120, 37.4891))
        p.addCurve(to: P(119.732, 30.1514), control1: P(120, 32.8659), control2: P(119.908, 31.4954))
        p.addCurve(to: P(89, 26.5), control1: P(113.435, 28.8832), control2: P(100.576, 26.1383))
        p.closeSubpath()
        }
        return p
    }
}

/// PREP-1 stage tick (scene → expressions → mouth): pending ring → running arc → done fills ink and the
/// check draws itself → failed shows a dash. Reduce Motion: no spin, no draw.
public struct GenitaStageTick: View {
    public enum Status: Equatable, Sendable { case pending, running, done, failed }
    public var status: Status
    public var ink: Color
    public var paper: Color
    public var size: CGFloat
    @State private var spin = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(_ status: Status, ink: Color = Color(red: 17 / 255, green: 17 / 255, blue: 17 / 255), paper: Color = .white, size: CGFloat = 24) {
        self.status = status
        self.ink = ink
        self.paper = paper
        self.size = size
    }

    public var body: some View {
        let still = reduceMotion || GenitaMotion.reviewStill
        ZStack {
            Circle().fill(status == .done ? ink : ink.opacity(0.08))
                .scaleEffect(status == .done ? 1 : 0.92)
            if status == .running {
                Circle().trim(from: 0, to: 0.28)
                    .stroke(ink, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(spin ? 360 : 0))
                    .padding(2)
                    .onAppear { if !still { withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) { spin = true } } }
                    .transition(.opacity)
            }
            CheckShape()
                .trim(from: 0, to: status == .done ? 1 : 0)
                .stroke(paper, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                .frame(width: size * 0.42, height: size * 0.32)
            if status == .failed {
                Capsule().fill(ink.opacity(0.45)).frame(width: size * 0.36, height: 2).transition(.scale.combined(with: .opacity))
            }
        }
        .frame(width: size, height: size)
        .animation(still ? GenitaMotion.fade : GenitaMotion.bouncy, value: status)
        .accessibilityHidden(true)
    }
}

struct CheckShape: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: r.minX, y: r.midY + r.height * 0.05))
        p.addLine(to: CGPoint(x: r.minX + r.width * 0.36, y: r.maxY))
        p.addLine(to: CGPoint(x: r.maxX, y: r.minY))
        return p
    }
}
