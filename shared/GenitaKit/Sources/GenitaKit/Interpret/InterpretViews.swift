// F8-U-INT · Interpretation overlay for the call screen (iPhone INT-1~6, Mac INT-M0~M2).
// Layout and tokens follow design-flow r01 section 8: the companion's face stays on
// top, the language bar sits under the status bar, two-language bubbles fill the
// bottom, "Hold to talk" floats over them. The call screen owns the face, the
// glass controls and the More sheet (INT-0 row); this file draws only what
// interpretation adds, from an InterpretBoard.

import SwiftUI

enum InterpretInk {
    static let ink = Color(red: 17 / 255, green: 17 / 255, blue: 17 / 255)
    static let onInk = Color(red: 253 / 255, green: 253 / 255, blue: 253 / 255)
    static let onInkSoft = onInk.opacity(0.76)
    static let onInkFaint = onInk.opacity(0.28)
    static let pill = ink.opacity(0.84)
    static let dim = ink.opacity(0.46)
    static let glass = Color.black.opacity(0.42)
    static let glassLine = Color.white.opacity(0.34)
    static let blueOnInk = Color(red: 84 / 255, green: 193 / 255, blue: 255 / 255)
    static let mute = Color(red: 115 / 255, green: 115 / 255, blue: 115 / 255)
    static let field = Color(red: 241 / 255, green: 241 / 255, blue: 241 / 255)
    static let sheet = Color(red: 254 / 255, green: 254 / 255, blue: 254 / 255)
    static let handle = Color(red: 219 / 255, green: 219 / 255, blue: 219 / 255)

    static func sans(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        let face = weight == .medium ? "Medium" : weight == .semibold ? "SemiBold" : weight == .bold ? "Bold" : "Regular"
        return .custom("PretendardVariable-" + face, fixedSize: size)
    }
    static func serif(_ size: CGFloat) -> Font { .custom("KMUTTF-SungkokSemiSerif", fixedSize: size) }
}

// MARK: - Icons (20 pt, 1.8 stroke, from the board's inline SVGs)

struct InterpretIcon: View {
    enum Kind { case globe, close, mic }
    var kind: Kind
    var body: some View {
        Canvas { ctx, size in
            let s = size.width / 20
            var p = Path()
            switch kind {
            case .globe:
                p.addEllipse(in: CGRect(x: 2.5 * s, y: 2.5 * s, width: 15 * s, height: 15 * s))
                p.move(to: CGPoint(x: 2.5 * s, y: 10 * s)); p.addLine(to: CGPoint(x: 17.5 * s, y: 10 * s))
                p.move(to: CGPoint(x: 10 * s, y: 2.5 * s))
                p.addCurve(to: CGPoint(x: 10 * s, y: 17.5 * s), control1: CGPoint(x: 12.2 * s, y: 4.8 * s), control2: CGPoint(x: 12.2 * s, y: 15.2 * s))
                p.move(to: CGPoint(x: 10 * s, y: 2.5 * s))
                p.addCurve(to: CGPoint(x: 10 * s, y: 17.5 * s), control1: CGPoint(x: 7.8 * s, y: 4.8 * s), control2: CGPoint(x: 7.8 * s, y: 15.2 * s))
            case .close:
                p.move(to: CGPoint(x: 5 * s, y: 5 * s)); p.addLine(to: CGPoint(x: 15 * s, y: 15 * s))
                p.move(to: CGPoint(x: 15 * s, y: 5 * s)); p.addLine(to: CGPoint(x: 5 * s, y: 15 * s))
            case .mic:
                p.addRoundedRect(in: CGRect(x: 7 * s, y: 2.5 * s, width: 6 * s, height: 10 * s), cornerSize: CGSize(width: 3 * s, height: 3 * s))
                p.move(to: CGPoint(x: 4.5 * s, y: 9.5 * s))
                p.addArc(center: CGPoint(x: 10 * s, y: 9.5 * s), radius: 5.5 * s, startAngle: .degrees(180), endAngle: .degrees(0), clockwise: true)
                p.move(to: CGPoint(x: 10 * s, y: 15 * s)); p.addLine(to: CGPoint(x: 10 * s, y: 17.5 * s))
            }
            ctx.stroke(p, with: .foreground, style: StrokeStyle(lineWidth: 1.8 * s, lineCap: .round, lineJoin: .round))
        }
        .frame(width: 20, height: 20)
        .accessibilityHidden(true)
    }
}

/// Four bars that bounce while someone talks (static when `live` is false or motion is reduced).
struct TalkWave: View {
    var live: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: !live || reduceMotion)) { t in
            HStack(spacing: 2) {
                ForEach(0..<4, id: \.self) { i in
                    let phase = t.date.timeIntervalSinceReferenceDate / 0.9 + [0, 0.22, 0.5, 0.72][i]
                    let h = live && !reduceMotion ? 6 + 6 * abs(sin(phase * .pi)) : [8, 12, 10, 6][i]
                    RoundedRectangle(cornerRadius: 1).frame(width: 2, height: h)
                }
            }
            .frame(height: 20)
        }
        .accessibilityHidden(true)
    }
}

// MARK: - Bar (INT-1 … INT-6, INT-M1/M2)

public struct InterpretBarView: View {
    var board: InterpretBoard
    var onClose: () -> Void
    public init(board: InterpretBoard, onClose: @escaping () -> Void) {
        self.board = board
        self.onClose = onClose
    }
    public var body: some View {
        let bar = board.bar
        HStack(spacing: 12) {
            HStack(spacing: 12) {
                InterpretIcon(kind: .globe)
                VStack(alignment: .leading, spacing: 0) {
                    Text(bar.title).font(InterpretInk.sans(14, .medium)).lineSpacing(6).lineLimit(1).minimumScaleFactor(0.85)
                    Text(bar.subtitle).font(InterpretInk.sans(12)).foregroundStyle(InterpretInk.onInkSoft).lineLimit(2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.updatesFrequently)
            .accessibilityIdentifier("interpretBar")
            Button(action: onClose) {
                InterpretIcon(kind: .close).frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Stop interpreting")
            .accessibilityIdentifier("interpretStop")
        }
        .foregroundStyle(InterpretInk.onInk)
        .padding(.leading, 16).padding(.trailing, 8).padding(.vertical, 8)
        .frame(minHeight: 56)
        .background(InterpretInk.pill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            if bar.warn { RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(InterpretInk.blueOnInk, lineWidth: 1) }
        }
    }
}

// MARK: - Bubbles

struct InterpretBubbleView: View {
    var bubble: InterpretBoard.Bubble
    var faint: Bool
    var body: some View {
        let me = bubble.speaker == .me
        let original = bubble.status == .unknown ? "I couldn’t make this one out." : bubble.original.text
        VStack(alignment: .leading, spacing: 4) {
            Text(original).font(InterpretInk.sans(17)).lineSpacing(7)
                .foregroundStyle(me ? InterpretInk.ink : InterpretInk.onInk)
            if let t = bubble.translation, !t.text.isEmpty {
                Text(t.text).font(InterpretInk.sans(15)).lineSpacing(7)
                    .foregroundStyle(me ? InterpretInk.mute : InterpretInk.onInkSoft)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, 16).padding(.vertical, 12)
        .frame(maxWidth: 320, alignment: .leading)
        .background(me ? InterpretInk.onInk : InterpretInk.pill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay { if !me { RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(InterpretInk.onInkFaint, lineWidth: 1) } }
        .opacity(faint ? 0.6 : 1)
        .frame(maxWidth: .infinity, alignment: me ? .trailing : .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibility(original))
        .accessibilityIdentifier("interpretBubble")
    }
    private func accessibility(_ original: String) -> String {
        let who = bubble.speaker == .me ? "You" : "Them"
        guard let t = bubble.translation, !t.text.isEmpty else { return "\(who): \(original)" }
        return "\(who): \(original). \(t.lang ?? "Translation"): \(t.text)"
    }
}

struct InterpretSpeakerLineView: View {
    var line: InterpretBoard.SpeakerLine
    var body: some View {
        HStack(spacing: 8) {
            if line.live { TalkWave(live: true).foregroundStyle(InterpretInk.blueOnInk) }
            Text(line.name).font(InterpretInk.sans(14, .medium)).foregroundStyle(line.live && line.who == .them ? InterpretInk.blueOnInk : InterpretInk.onInk)
            Text(line.detail).font(InterpretInk.sans(14)).foregroundStyle(InterpretInk.onInkSoft)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(line.name), \(line.detail)")
        .accessibilityIdentifier("interpretSpeaker")
    }
}

/// Bottom panel: INT-1 intro, or the newest bubbles with the "who is talking" line.
public struct InterpretPanelView: View {
    var board: InterpretBoard
    public init(board: InterpretBoard) { self.board = board }
    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Spacer(minLength: 0)
            if board.showsIntro {
                // hand-broken: the natural wrap leaves "on." alone on the last line at 390 pt
                Text("Talk the way you normally would.\nWhen I hear a second language,\nI’ll start passing it on.")
                    .font(InterpretInk.sans(17)).lineSpacing(7).foregroundStyle(InterpretInk.onInk)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                let shown = board.visible
                ForEach(shown, id: \.bubbleId) { b in
                    if b.bubbleId == shown.last?.bubbleId, let line = board.speakerLine, line.who != .companion {
                        InterpretSpeakerLineView(line: line)
                    }
                    InterpretBubbleView(bubble: b, faint: board.isFaint(b))
                    if b.bubbleId == shown.last?.bubbleId, let line = board.speakerLine, line.who == .companion {
                        InterpretSpeakerLineView(line: line)
                    }
                }
            }
        }
        .padding(.horizontal, 24)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("interpretPanel")
    }
}

// MARK: - Hold to talk (INT-4) / Hold to reply (INT-M2)

public struct InterpretHoldButton: View {
    var board: InterpretBoard
    var onHold: (Bool) -> Void
    /// Card 9: the user's mic level 0…1 for the bars over the button while it is held (nil: a calm low sway).
    var level: (() -> Float)?
    @State private var down = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    public init(board: InterpretBoard, level: (() -> Float)? = nil, onHold: @escaping (Bool) -> Void) {
        self.board = board
        self.level = level
        self.onHold = onHold
    }
    public var body: some View {
        let held = board.holding || down
        // motion details card 9 (flag `motionDetails`): off → the INT-4 look switches at once as before
        let details = MotionDetails.enabled
        let live = MotionDetails.live(reduceMotion: reduceMotion)
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                InterpretIcon(kind: .mic)
                Text(board.holdTitle).font(InterpretInk.sans(16, .medium))
            }
            .foregroundStyle(held ? InterpretInk.ink : InterpretInk.onInk)
            .frame(maxWidth: .infinity, minHeight: 56)
            .background {
                if details {
                    // resting glass stays underneath; the INT-4 held fill sweeps in from the left (fades under Reduce Motion)
                    Capsule().fill(.ultraThinMaterial.opacity(0.6))
                    Capsule().fill(InterpretInk.glass)
                    GeometryReader { g in
                        Rectangle().fill(InterpretInk.onInk)
                            .frame(width: held || !live ? g.size.width : 0)
                            .opacity(held ? 1 : 0)
                    }
                    .clipShape(Capsule())
                } else {
                    Capsule().fill(held ? AnyShapeStyle(InterpretInk.onInk) : AnyShapeStyle(.ultraThinMaterial.opacity(0.6)))
                    Capsule().fill(held ? Color.clear : InterpretInk.glass)
                }
            }
            .overlay { Capsule().strokeBorder(held ? Color.clear : InterpretInk.glassLine, lineWidth: 1) }
            .overlay(alignment: .top) {
                if details {
                    // your voice, floating over the button while it is held
                    MotionLevelBars(active: held, level: level, color: InterpretInk.onInk)
                        .opacity(held ? 1 : 0)
                        .offset(y: -30)
                        .allowsHitTesting(false)
                }
            }
            .scaleEffect(live && down ? MotionOnboarding.holdScale : 1)
            .animation(details && !GenitaMotion.reviewStill ? (held ? MotionOnboarding.holdFill : MotionOnboarding.holdDrain) : nil, value: held)
            .animation(details && !GenitaMotion.reviewStill ? MotionOnboarding.holdFill : nil, value: down)
            .sensoryFeedback(trigger: down) { _, pressed in
                // soft on press, rigid when the release sends it
                guard details else { return nil }
                return pressed ? .impact(flexibility: .soft) : .impact(flexibility: .rigid)
            }
            .contentShape(Capsule())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        guard !down else { return }
                        down = true
                        onHold(true)
                    }
                    .onEnded { _ in
                        down = false
                        onHold(false)
                    }
            )
            .accessibilityElement()
            .accessibilityLabel(board.holdTitle)
            .accessibilityHint(board.holdNote)
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { onHold(!held) }
            .accessibilityIdentifier("interpretHold")
            Text(board.holdNote).font(InterpretInk.sans(12)).foregroundStyle(InterpretInk.onInkSoft).multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

// MARK: - Whole overlay

/// Everything interpretation draws over the call screen, placed like the 390×844 board frames.
/// `top` shifts the bar and panel down when the device's top inset is taller than the board's (47 pt).
public struct InterpretOverlay: View {
    var board: InterpretBoard
    var top: CGFloat
    var onClose: () -> Void
    var onHold: (Bool) -> Void
    /// Card 9: the user's mic level 0…1 for the Hold to talk bars (nil: a calm low sway while held).
    var level: (() -> Float)?
    public init(board: InterpretBoard, top: CGFloat = 0, level: (() -> Float)? = nil, onClose: @escaping () -> Void, onHold: @escaping (Bool) -> Void) {
        self.board = board
        self.top = top
        self.level = level
        self.onClose = onClose
        self.onHold = onHold
    }
    public var body: some View {
        GeometryReader { geo in
            let h = geo.size.height
            let panelTop = 280 + top
            ZStack(alignment: .top) {
                // ipanel: from 280 down, gradient to ink, content bottom-aligned above the hold button
                LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: InterpretInk.dim, location: 120 / max(1, h - panelTop)), .init(color: InterpretInk.ink, location: min(1, 260 / max(1, h - panelTop)))], startPoint: .top, endPoint: .bottom)
                    .frame(height: max(0, h - panelTop)).offset(y: panelTop).allowsHitTesting(false)
                InterpretPanelView(board: board)
                    .frame(height: max(0, h - panelTop - 120 - 168), alignment: .bottom).offset(y: panelTop + 120)
                InterpretBarView(board: board, onClose: onClose)
                    .padding(.horizontal, 24).offset(y: 124 + top)
                InterpretHoldButton(board: board, level: level, onHold: onHold)
                    .padding(.horizontal, 38).frame(maxHeight: .infinity, alignment: .bottom).padding(.bottom, 64)
            }
            .frame(width: geo.size.width, height: h, alignment: .top)
        }
    }
}

// MARK: - Mac INT-M0 · pick the call app

public struct MacInterpretCallSheet: View {
    public enum CallApp: String, CaseIterable, Sendable { case faceTime = "FaceTime", zoom = "Zoom" }
    @Binding var app: CallApp
    var warning: String?
    var onStart: () -> Void
    public init(app: Binding<CallApp>, warning: String? = nil, onStart: @escaping () -> Void) {
        self._app = app
        self.warning = warning
        self.onStart = onStart
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Capsule().fill(InterpretInk.handle).frame(width: 47, height: 5).frame(maxWidth: .infinity).padding(.bottom, 24)
            Text("Interpret a call.").font(InterpretInk.serif(28)).foregroundStyle(InterpretInk.ink).padding(.bottom, 12)
            Text("I listen to the call’s sound, whisper the translation to you, and say your reply in their language.")
                .font(InterpretInk.sans(15)).lineSpacing(7).foregroundStyle(InterpretInk.ink).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                ForEach(CallApp.allCases, id: \.self) { a in
                    Button { app = a } label: {
                        HStack(spacing: 8) {
                            Image(systemName: a == .faceTime ? "video.fill" : "video.bubble.fill").font(.system(size: 15, weight: .medium))
                            Text(a.rawValue).font(InterpretInk.sans(15, .medium))
                        }
                        .padding(.horizontal, 16).frame(height: 48)
                        .foregroundStyle(app == a ? InterpretInk.onInk : InterpretInk.ink)
                        .background(app == a ? InterpretInk.ink : InterpretInk.field, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(app == a ? .isSelected : [])
                    .accessibilityIdentifier("interpretApp\(a.rawValue)")
                }
            }
            .padding(.top, 20)
            Text(warning ?? "Wear headphones so my whispers stay with you.")
                .font(InterpretInk.sans(14)).foregroundStyle(warning == nil ? InterpretInk.mute : Color(red: 0, green: 99 / 255, blue: 159 / 255))
                .fixedSize(horizontal: false, vertical: true).padding(.top, 16)
            Button(action: onStart) {
                Text("Start interpreting").font(InterpretInk.sans(16, .medium)).foregroundStyle(InterpretInk.onInk)
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .background(InterpretInk.ink, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
            .padding(.top, 32)
            .accessibilityIdentifier("interpretCallStart")
        }
        .padding(.horizontal, 38).padding(.top, 28).padding(.bottom, 48)
        .frame(maxWidth: .infinity)
        .background {
            UnevenRoundedRectangle(topLeadingRadius: 30, topTrailingRadius: 30, style: .continuous)
                .fill(InterpretInk.sheet).shadow(color: InterpretInk.ink.opacity(0.18), radius: 12)
        }
    }
}
