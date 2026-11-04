import SwiftUI
import UIKit
import CoreText

/// The values in FigmaScreens.json are read-only measurements exported from the user's nodes.
/// Device chrome is excluded. Fonts never scale with screen width; compact screens scroll.
struct DesignColor: Decodable {
    var r: CGFloat; var g: CGFloat; var b: CGFloat; var a: CGFloat?
    /// D1: every Figma #B7B7B7 text (card subtitles, SUM labels, D01 time, V04 voice lines) reads as #737373.
    var ui: UIColor { Palette.isFigmaSecondary(r: r, g: g, b: b) ? Palette.secondaryUI : UIColor(red: r, green: g, blue: b, alpha: a ?? 1) }
    var color: Color { Color(uiColor: ui) }
}
struct DesignRun: Decodable { var start: Int; var end: Int; var color: DesignColor? }
struct DesignPaint: Decodable { var imageTransform: [[CGFloat]]? }
struct DesignNode: Decodable, Identifiable {
    var figmaId: String; var name: String; var type: String
    var x: CGFloat; var y: CGFloat; var w: CGFloat; var h: CGFloat
    var characters: String?; var fontFamily: String?; var fontStyle: String?
    var fontSize: CGFloat?; var lineHeight: CGFloat?; var letterSpacing: CGFloat?
    var weight: Int?; var align: String?; var color: DesignColor?
    var fill: DesignColor?; var stroke: DesignColor?; var strokeWidth: CGFloat?
    var radius: CGFloat?; var radii: [CGFloat]?; var imageFill: Bool?
    var paintsRaw: [DesignPaint]?
    var runs: [DesignRun]?
    var id: String { figmaId }
    var font: UIFont {
        if fontFamily == "KMU80 TTF" { return UIFont(name: "KMUTTF-SungkokSemiSerif", size: fontSize ?? 35)! }
        let face = [100:"Thin",200:"ExtraLight",300:"Light",400:"Regular",500:"Medium",600:"SemiBold",700:"Bold",800:"ExtraBold",900:"Black"][weight ?? 400]!
        return UIFont(name: "PretendardVariable-" + face, size: fontSize ?? 16)!
    }
    func attributed(_ text: String? = nil, color override: UIColor? = nil) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        if let lineHeight { paragraph.minimumLineHeight = lineHeight; paragraph.maximumLineHeight = lineHeight }
        paragraph.alignment = align == "CENTER" ? .center : align == "RIGHT" ? .right : .left
        paragraph.lineBreakMode = .byWordWrapping
        // live text (answers, names): no one-word last line ("…without / approval" → "…actions / without approval");
        // Figma's own copy keeps its hand-set breaks
        if text != nil { paragraph.lineBreakStrategy = .standard }
        var attributes: [NSAttributedString.Key:Any] = [.font:font, .foregroundColor:override ?? color?.ui ?? UIColor(white: 0.067, alpha: 1), .paragraphStyle:paragraph]
        // Zero tracking must leave the font's built-in kerning enabled.
        if let spacing = letterSpacing, spacing != 0 { attributes[.kern] = spacing }
        let result = NSMutableAttributedString(string: text ?? characters ?? "", attributes: attributes)
        if text == nil && override == nil {
            for run in runs ?? [] where run.start < result.length {
                if let color = run.color { result.addAttribute(.foregroundColor, value: color.ui, range: NSRange(location: run.start, length: min(run.end, result.length) - run.start)) }
            }
        }
        return result
    }
}
enum DesignLibrary {
    static let screens: [String:[DesignNode]] = {
        let url = Bundle.main.url(forResource: "FigmaScreens", withExtension: "json")!
        return try! JSONDecoder().decode([String:[DesignNode]].self, from: Data(contentsOf: url))
    }()
    static func nodes(_ screen: String) -> [DesignNode] { screens[screen]! }
}
private final class ExactDesignLabel: UIView {
    var overflow: CGFloat = 0
    var node: DesignNode?
    var attributed: NSAttributedString = NSAttributedString() { didSet { accessibilityLabel = attributed.string; setNeedsDisplay() } }
    override func draw(_ rect: CGRect) {
        guard let node, let cg = UIGraphicsGetCurrentContext() else { return }
        let attributes = NSMutableAttributedString(attributedString: attributed)
        attributes.removeAttribute(.paragraphStyle, range: NSRange(location: 0, length: attributes.length))
        attributed.enumerateAttribute(.foregroundColor, in: NSRange(location: 0, length: attributed.length)) { value, range, _ in
            if let color = value as? UIColor { attributes.addAttribute(NSAttributedString.Key(kCTForegroundColorAttributeName as String), value: color.cgColor, range: range) }
        }
        let typesetter = CTTypesetterCreateWithAttributedString(attributes)
        let lineHeight = node.lineHeight ?? node.font.lineHeight
        cg.saveGState(); cg.textMatrix = .identity
        cg.translateBy(x: 0, y: bounds.height); cg.scaleBy(x: 1, y: -1)
        var baseline = bounds.height - overflow - node.font.ascender - (lineHeight - node.font.lineHeight) / 2
        var start = 0
        while start < attributes.length {
            let count = CTTypesetterSuggestLineBreak(typesetter, start, Double(bounds.width))
            guard count > 0 else { break }
            let line = CTTypesetterCreateLine(typesetter, CFRange(location: start, length: count))
            let flush: CGFloat = node.align == "CENTER" ? 0.5 : node.align == "RIGHT" ? 1 : 0
            cg.textPosition = CGPoint(x: CTLineGetPenOffsetForFlush(line, flush, Double(bounds.width)), y: baseline)
            CTLineDraw(line, cg)
            start += count; baseline -= lineHeight
        }
        cg.restoreGState()
    }
}
struct DesignText: View {
    let node: DesignNode
    var text: String? = nil
    var color: UIColor? = nil
    var body: some View {
        let overflow = max(2, (node.font.lineHeight - (node.lineHeight ?? node.font.lineHeight)) / 2)
        GeometryReader { g in
            DesignLabel(node: node, text: text, color: color, overflow: overflow)
                .frame(width: g.size.width + 0.5, height: max(g.size.height, CGFloat((text ?? node.characters ?? "").components(separatedBy: "\n").count) * (node.lineHeight ?? node.font.lineHeight)) + overflow * 2)
                .offset(y: -overflow)
        }
    }
}
private struct DesignLabel: UIViewRepresentable {
    let node: DesignNode; var text: String?; var color: UIColor?; var overflow: CGFloat
    func makeUIView(context: Context) -> ExactDesignLabel {
        let label = ExactDesignLabel(); label.backgroundColor = .clear; label.isOpaque = false
        label.isUserInteractionEnabled = false; label.isAccessibilityElement = true; label.accessibilityTraits = .staticText
        return label
    }
    func updateUIView(_ uiView: ExactDesignLabel, context: Context) { uiView.node = node; uiView.overflow = overflow; uiView.attributed = node.attributed(text, color: color) }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: ExactDesignLabel, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? node.w, height: proposal.height ?? node.h)
    }
}
struct DesignShape: View {
    var node: DesignNode
    var color: Color? = nil
    var body: some View {
        RoundedRectangle(cornerRadius: node.radius ?? node.radii?.max() ?? 0)
            .fill(color ?? node.fill?.color ?? .clear)
            .overlay(RoundedRectangle(cornerRadius: node.radius ?? node.radii?.max() ?? 0).strokeBorder(node.stroke?.color ?? .clear, lineWidth: node.strokeWidth ?? 0))
    }
}
struct DesignImage: View {
    var node: DesignNode
    var resource: String
    var body: some View {
        let transform = node.paintsRaw?.first?.imageTransform
        let sx = transform?[0][0] ?? 1, sy = transform?[1][1] ?? 1
        let tx = transform?[0][2] ?? 0, ty = transform?[1][2] ?? 0
        Image(resource: resource).resizable()
            .frame(width: node.w / sx, height: node.h / sy)
            .offset(x: -tx * node.w / sx, y: -ty * node.h / sy)
            .frame(width: node.w, height: node.h, alignment: .topLeading).clipped()
    }
}
struct DesignPlacement: ViewModifier {
    let node: DesignNode; let width: CGFloat; let top: CGFloat; let stretch: CGFloat
    func body(content: Content) -> some View {
        let margin = 390 - node.x - node.w
        let flexible = (node.w >= 240 && margin >= 20 && node.x >= 20) || node.fontFamily == "KMU80 TTF" || (node.x == 0 && node.w == 390)
        let w = flexible ? max(1, width - node.x - (node.fontFamily == "KMU80 TTF" ? 31 : margin)) : node.w
        let x = node.x == 0 ? 0 : flexible ? node.x : (node.type == "text" && node.align != "CENTER") || (node.w < 20 && node.x < 50) ? node.x + (node.x > 300 ? width - 390 : 0) : node.x + (width - 390) / 2
        return content.frame(width: w, height: node.h)
            .position(x: x + w / 2, y: node.y + top + (node.y >= 384 ? stretch : 0) + node.h / 2)
    }
}
extension View {
    func designSlot(_ node: DesignNode, width: CGFloat, top: CGFloat = 0, stretch: CGFloat = 0) -> some View {
        modifier(DesignPlacement(node: node, width: width, top: top, stretch: stretch))
    }
}
