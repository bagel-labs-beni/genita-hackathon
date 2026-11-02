import Foundation
import CoreGraphics

/// MAC-REG: the feature-rich picture the Mac shows full screen once, so any iPhone with A12 or later
/// can find the screen with ARKit image tracking (design-flow r01 `assets/reg-target.svg`, 1600 × 1000).
/// Both apps draw it from these shapes, stretched to the screen's aspect, so the Mac's pixels and the
/// iPhone's ARKit reference image are the same picture. The old teal screen only worked with LiDAR.
enum RegistrationPattern {
    enum Shape { case rect(CGFloat, CGFloat, CGFloat, CGFloat, Int), circle(CGFloat, CGFloat, CGFloat, Int), triangle(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, Int) }
    static let viewBox = CGSize(width: 1600, height: 1000)
    /// ink, sky, teal, paper — the board's four colors
    static let palette: [(CGFloat, CGFloat, CGFloat)] = [(17, 17, 17), (84, 193, 255), (7, 151, 151), (253, 253, 253)]
    private static func R(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ c: Int) -> Shape { .rect(x, y, w, h, c) }
    private static func C(_ x: CGFloat, _ y: CGFloat, _ r: CGFloat, _ c: Int) -> Shape { .circle(x, y, r, c) }
    private static func T(_ a: CGFloat, _ b: CGFloat, _ c: CGFloat, _ d: CGFloat, _ e: CGFloat, _ f: CGFloat, _ k: Int) -> Shape { .triangle(a, b, c, d, e, f, k) }
    static let shapes: [Shape] = [
        R(663,154,74,65,0), R(748,596,31,24,0), R(143,246,35,32,1), C(457,645,52,0), R(812,50,148,184,0), C(593,429,21,0),
        R(1147,835,111,103,0), C(384,381,18,0), T(1267,210,1354,239,1310,326,1), R(953,599,142,81,1), R(368,715,123,77,0), R(1013,896,67,92,1),
        T(241,524,318,549,279,626,0), T(311,500,388,525,349,602,0), R(158,782,95,65,2), R(1017,593,126,50,1), R(552,485,113,121,0), R(1325,591,111,80,1),
        R(1369,355,26,25,1), R(1011,60,51,29,2), R(800,938,135,107,1), T(1125,284,1262,329,1193,466,0), T(1126,285,1240,323,1183,437,1), R(1398,905,72,35,0),
        C(475,674,26,0), R(1206,186,57,43,2), T(756,624,852,656,804,752,2), C(1414,879,44,0), R(1393,817,95,69,1), R(986,649,75,103,0),
        C(902,166,19,2), C(209,0,48,0), T(744,628,771,637,757,664,0), T(1257,385,1300,399,1278,442,2), R(1233,372,84,70,0), R(954,491,85,35,2),
        T(701,758,758,777,729,834,1), T(330,528,356,536,343,562,0), T(1081,370,1123,384,1102,426,0), C(610,658,67,0), R(534,530,70,38,0), C(1109,797,44,2),
        T(1255,830,1379,871,1317,995,0), R(820,757,126,106,0), T(1497,29,1647,79,1572,229,0), C(967,265,24,2), R(1480,357,146,60,2), C(962,201,33,0),
        T(1249,860,1273,868,1261,892,1), T(704,818,810,853,757,959,0), C(245,931,36,0), R(365,444,125,167,2), C(1478,405,41,1), T(173,742,217,756,195,800,0),
        T(56,154,155,187,105,286,1), C(299,626,64,1), R(717,159,94,110,0), C(1487,665,18,0), R(398,845,135,72,0), R(1026,246,121,92,2),
        T(268,62,408,108,338,248,2), T(1356,597,1484,639,1420,767,1), C(1027,133,46,0), C(38,893,40,0), C(306,176,21,1), C(246,569,15,2),
        T(1086,568,1171,596,1128,681,0), R(116,254,48,19,2), C(926,575,13,0), C(1254,517,50,0), C(926,520,46,1), T(507,715,597,745,552,835,2),
        C(414,860,40,0), C(803,452,32,0), T(877,74,928,91,902,142,2), R(316,733,106,134,2), R(957,224,119,99,0), C(1367,852,26,0),
        R(1055,413,67,43,1), C(1478,374,13,2), R(902,720,26,25,1), T(1049,65,1087,77,1068,115,0), R(214,86,57,65,2), T(553,773,593,786,573,826,1),
        C(1384,838,72,2), C(1098,527,48,1), C(183,285,15,0), C(148,275,72,0), R(533,85,101,126,0), T(929,11,996,33,962,100,1),
        C(548,636,20,0), R(488,112,148,73,0), R(638,643,63,53,0), T(364,277,432,299,398,367,0), C(75,15,13,0), C(503,457,18,1),
        T(1118,854,1255,899,1186,1036,1), R(630,704,51,61,0), C(1447,746,52,0), R(711,55,131,129,0), R(523,441,44,53,0), C(1036,686,74,2),
        R(1418,300,29,17,1), T(7,269,77,292,42,362,2), T(1120,331,1175,349,1147,404,0), R(633,223,69,49,0), R(972,285,88,101,0), R(186,270,128,121,0),
        C(806,23,31,2), C(173,599,73,0), T(1466,802,1602,847,1534,983,1), C(1475,506,21,2), C(1317,148,14,1), T(1035,142,1175,188,1105,328,0),
        R(1196,817,138,47,0), R(1304,369,146,116,0), C(103,642,13,0), C(6,467,63,0), C(1030,919,46,0), R(135,763,118,45,1),
        R(543,240,117,118,0), R(942,505,132,171,1), R(588,785,29,13,0), C(520,667,59,2), C(273,12,42,0), C(1376,101,56,0),
        C(595,725,45,2), R(955,785,39,15,0), R(968,17,61,52,1), T(920,275,993,299,956,372,0), R(431,76,98,85,0), T(736,135,837,168,786,269,2),
        T(1440,373,1493,390,1466,443,1), R(995,403,27,22,0), C(923,415,31,0), R(770,323,39,43,2), C(815,122,72,0), R(1515,296,56,40,2),
        T(1206,78,1276,101,1241,171,1), T(98,287,135,299,116,336,0), R(584,650,143,84,0), T(1046,323,1094,339,1070,387,2), T(876,905,903,914,889,941,1), R(1134,562,50,55,0),
        C(923,629,60,0), R(586,497,30,22,0), C(577,304,28,2), R(488,308,85,85,1), C(153,212,44,1), C(927,928,33,1),
        R(1121,197,55,50,0), T(653,244,724,267,688,338,2), R(413,908,26,29,1), T(430,385,488,404,459,462,2), R(1020,284,97,82,2), R(1289,809,134,172,0),
        C(787,409,53,1), R(639,869,128,98,0), R(969,601,86,113,0), R(1081,875,83,34,1), T(316,155,406,185,361,275,0), R(1478,717,106,122,1),
        C(2,801,20,0), T(76,660,191,698,133,813,2), C(1283,257,45,1), C(229,101,16,2), R(1193,196,73,70,2), R(21,550,62,40,1),
        C(496,486,45,0), R(59,421,114,58,2), R(20,20,160,160,0), R(60,60,80,80,3), R(1420,20,160,160,0), R(1460,60,80,80,3),
        R(20,820,160,160,0), R(60,860,80,80,3), R(1420,820,160,160,0), R(1460,860,80,80,3),
    ]

    /// Draws the picture into `size` pixels (y down like the SVG). The 16-unit frame is part of it.
    static func draw(in context: CGContext, size: CGSize) {
        let sx = size.width / viewBox.width, sy = size.height / viewBox.height
        context.saveGState()
        context.translateBy(x: 0, y: size.height); context.scaleBy(x: 1, y: -1)
        func fill(_ c: Int) { let p = palette[c]; context.setFillColor(red: p.0 / 255, green: p.1 / 255, blue: p.2 / 255, alpha: 1) }
        fill(3); context.fill(CGRect(origin: .zero, size: size))
        for shape in shapes {
            switch shape {
            case let .rect(x, y, w, h, c): fill(c); context.fill(CGRect(x: x * sx, y: y * sy, width: w * sx, height: h * sy))
            case let .circle(x, y, r, c): fill(c); context.fillEllipse(in: CGRect(x: (x - r) * sx, y: (y - r) * sy, width: 2 * r * sx, height: 2 * r * sy))
            case let .triangle(a, b, c2, d, e, f, c):
                fill(c); context.beginPath()
                context.move(to: CGPoint(x: a * sx, y: b * sy)); context.addLine(to: CGPoint(x: c2 * sx, y: d * sy)); context.addLine(to: CGPoint(x: e * sx, y: f * sy))
                context.closePath(); context.fillPath()
            }
        }
        fill(0); context.setLineWidth(16 * min(sx, sy)); context.stroke(CGRect(x: 8 * sx, y: 8 * sy, width: size.width - 16 * sx, height: size.height - 16 * sy))
        context.restoreGState()
    }

    /// The picture as an image of `width` pixels at `aspect` (width / height of the Mac screen).
    static func image(width: Int = 1280, aspect: CGFloat) -> CGImage? {
        let a = aspect.isFinite && aspect > 0.5 && aspect < 3 ? aspect : 1.6
        let height = max(1, Int((CGFloat(width) / a).rounded()))
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        draw(in: context, size: CGSize(width: width, height: height))
        return context.makeImage()
    }
}

/// What the Mac tells the iPhone about the picture it shows: physical size in meters of the whole
/// screen (the picture fills it). The iPhone turns this into an ARKit reference image.
struct RegistrationGeometry: Equatable {
    let widthM: Double
    let heightM: Double
    var aspect: Double { widthM / heightM }
    init?(widthM: Double, heightM: Double) {
        guard widthM.isFinite, heightM.isFinite, (0.15...1.6).contains(widthM), (0.1...1.2).contains(heightM) else { return nil }
        self.widthM = widthM; self.heightM = heightM
    }
    init?(_ message: [String: Any]) {
        guard let w = message["widthM"] as? Double, let h = message["heightM"] as? Double else { return nil }
        self.init(widthM: w, heightM: h)
    }
    var message: [String: Any] { ["type": "registration", "widthM": widthM, "heightM": heightM] }
}
