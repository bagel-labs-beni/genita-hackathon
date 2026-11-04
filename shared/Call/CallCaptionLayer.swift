import SwiftUI

/// Live captions r01 on the call stage (iPhone ConversationView and the Mac call window): the scrim over the bottom
/// 400 pt and the caption block, bottom edge `bottom` (626 on 390 × 844), x 20, width 350, growing upward.
/// Colors and fonts come from the host's design tokens (iPhone: CallInk + TypeStyle, Mac: MacSheetInk + Pretendard).
struct CaptionStyle {
    var ink: Color
    var onInk: Color
    var blue: Color
    var font: (CGFloat, Font.Weight) -> Font
}

struct CallCaptionLayer: View {
    let style: CaptionStyle
    /// the call stage this layer covers (full screen / the 390 × 844 Mac window)
    let size: CGSize
    /// y of the block's bottom edge in that space
    let bottom: CGFloat
    /// connecting, interpreting, Finds tab, half/full sheet, unclear card, handoff sheet…
    let hidden: Bool
    /// mic off hides the user's row only (the companion's row still shows)
    let micOn: Bool
    let frame: () -> LiveCaptions.Frame
    let level: () -> Float
    /// Reduce Motion or review stills (CI shots): no bar motion, no fades
    var still = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        // keeps ticking while hidden: a reply that plays behind the Finds sheet still ends and clears on time
        TimelineView(.animation(minimumInterval: 1.0 / 30)) { _ in
            let f = frame()
            let you = hidden ? nil : LiveCaptions.visibleYou(f.you, micOn: micOn)
            let reply = hidden ? nil : f.reply
            let shown = you != nil || reply != nil
            ZStack(alignment: .bottomLeading) {
                // the soft ink fade behind the bottom 400 pt, only while captions show
                LinearGradient(stops: [.init(color: style.ink.opacity(0), location: 0), .init(color: style.ink.opacity(0.38), location: 0.42),
                                       .init(color: style.ink.opacity(0.62), location: 1)], startPoint: .top, endPoint: .bottom)
                    .frame(height: 400).frame(maxWidth: .infinity).opacity(shown ? 1 : 0)
                    .animation(.easeOut(duration: 0.2), value: shown)
                VStack(alignment: .leading, spacing: 8) {
                    if let you {
                        CaptionYouRow(row: you, style: style, level: level, still: reduceMotion || still)
                            .id("you")
                            .transition(enter)
                    }
                    if let reply {
                        CaptionReplyRow(row: reply, style: style, reduceMotion: reduceMotion)
                            .id("reply-\(reply.utteranceId)")
                            .transition(enter)
                    }
                }
                .frame(width: 350, alignment: .bottomLeading)
                .padding(.leading, 20)
                .padding(.bottom, max(0, size.height - bottom))
                .animation(reduceMotion ? .linear(duration: 0.12) : .spring(response: 0.18, dampingFraction: 1), value: you?.phase)
                .animation(.easeOut(duration: 0.2), value: you?.dim)
                .animation(f.isEmpty ? .easeOut(duration: 0.4) : .easeOut(duration: 0.16), value: reply?.utteranceId)
                .animation(.easeOut(duration: 0.4), value: shown)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.updatesFrequently)
                .accessibilityIdentifier("liveCaption")
                .accessibilityValue(you.map { "\($0.phase)" } ?? "none")
            }
            .frame(width: size.width, height: size.height, alignment: .bottomLeading)
            .opacity(hidden ? 0 : 1)
            .animation(.easeOut(duration: 0.2), value: hidden)
            .accessibilityHidden(hidden || !shown)
        }
        .allowsHitTesting(false)
    }

    private var enter: AnyTransition {
        reduceMotion ? .opacity : .opacity.combined(with: .offset(x: 0, y: 8))
    }
}

/// Bars that follow the local mic → a check on the final transcript ("we heard you"). 15/22 at 72%, 2 lines, tail kept.
private struct CaptionYouRow: View {
    let row: LiveCaptions.Frame.YouRow
    let style: CaptionStyle
    let level: () -> Float
    let still: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            ZStack {
                switch row.phase {
                case .sound, .words: CaptionBars(level: still ? 0.4 : CGFloat(level()), color: style.blue).transition(.opacity)
                case .heard: CaptionCheck(color: style.blue, still: still).transition(.opacity)
                case .missed: Color.clear
                }
            }
            .frame(width: 16, height: 16).padding(.top, 3)
            .animation(.easeOut(duration: 0.1), value: row.phase)
            Text(row.text)
                .font(style.font(15, .regular)).lineSpacing(22 - 18)
                .foregroundStyle(style.onInk.opacity(row.dim || row.phase == .sound || row.phase == .missed ? 0.52 : 0.72))
                .lineLimit(row.dim ? 1 : 2).truncationMode(.tail)
                .shadow(color: style.ink.opacity(0.35), radius: 1, y: 1)
                // b16 (Appetize S09): a soft halo keeps white words readable over a light sweater or a bright wall
                .shadow(color: style.ink.opacity(0.45), radius: 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .mask(CaptionRollMask(rolled: row.rolled))
                .accessibilityIdentifier("liveCaptionYou")
        }
    }
}

/// The companion's words at the playhead: 17/24 Medium white, 3 lines rolling; dimmed when cut off.
private struct CaptionReplyRow: View {
    let row: LiveCaptions.Frame.ReplyRow
    let style: CaptionStyle
    let reduceMotion: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Color.clear.frame(width: 16, height: 16)
            Text(row.text)
                .font(style.font(17, .medium)).lineSpacing(24 - 20)
                .foregroundStyle(style.onInk.opacity(row.cut ? 0.52 : 1))
                .lineLimit(3).truncationMode(.head)
                .shadow(color: style.ink.opacity(0.35), radius: 1, y: 1)
                // b16 (Appetize S09): a soft halo keeps white words readable over a light sweater or a bright wall
                .shadow(color: style.ink.opacity(0.45), radius: 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .mask(CaptionRollMask(rolled: row.rolled))
                .contentTransition(reduceMotion ? .identity : .opacity)
                .animation(reduceMotion ? nil : .linear(duration: 0.12), value: row.words)
                .accessibilityIdentifier("liveCaptionReply")
        }
    }
}

/// Top 12 pt fade once older words rolled off.
private struct CaptionRollMask: View {
    let rolled: Bool
    var body: some View {
        VStack(spacing: 0) {
            LinearGradient(colors: [.black.opacity(rolled ? 0 : 1), .black], startPoint: .top, endPoint: .bottom).frame(height: 12)
            Color.black
        }
    }
}

/// 3 bars, 3 wide, 2 apart, 4…14 tall by level (× 0.6 / 1.0 / 0.75).
private struct CaptionBars: View {
    let level: CGFloat
    let color: Color
    var body: some View {
        HStack(spacing: 2) {
            ForEach([CGFloat(0.6), 1.0, 0.75], id: \.self) { m in
                RoundedRectangle(cornerRadius: 1.5).fill(color).frame(width: 3, height: 4 + 10 * min(1, max(0, level * m)))
            }
        }.frame(width: 16, height: 16)
    }
}

/// (3, 8.5) → (6.2, 11.5) → (13, 4.5) in a 16 box, stroke 2, round caps, drawn in once.
private struct CaptionCheck: View {
    let color: Color
    let still: Bool
    @State private var drawn: CGFloat = 0
    var body: some View {
        Path { p in
            p.move(to: CGPoint(x: 3, y: 8.5)); p.addLine(to: CGPoint(x: 6.2, y: 11.5)); p.addLine(to: CGPoint(x: 13, y: 4.5))
        }
        .trim(from: 0, to: drawn)
        .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
        .frame(width: 16, height: 16)
        .onAppear { withAnimation(still ? nil : .easeOut(duration: 0.2)) { drawn = 1 } }
    }
}
