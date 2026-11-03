import SwiftUI

/// Watch-together states on the Mac call window (390×844), values from the
/// full-flow board r01: MS-1 first share notice, sharing chip, MS-2 Reacting
/// cue, MS-3 black screen card, FT-SPK speaker chip (who is talking only —
/// never what they say).
struct WatchOverlays: View {
    @ObservedObject var sharing: ScreenSharingController
    var review: String = ""

    private var sharingOn: Bool { (sharing.isSharing && sharing.connectionMessage == nil) || ["sharing", "reacting", "black", "speaker"].contains(review) }
    private var source: String? { review.isEmpty ? sharing.sourceName : "Safari" }
    private var reacting: Bool { (sharingOn && sharing.reacting) || review == "reacting" }
    private var blank: Bool { (sharingOn && sharing.blank) || review == "black" }
    private var speaker: String? { review == "speaker" ? "the chef" : (sharing.isSharing ? sharing.speakerName : nil) }
    private var notice: Bool { sharing.noticeVisible || review == "share-notice" }

    var body: some View {
        ZStack(alignment: .topLeading) {
            // Mac v2: the sharing chip sits in the pill row under the menu button, like every other call pill
            if sharingOn { SharingChip(source: source).position(x: (MacDesignV2.enabled ? 24 : 83) + SharingChip.width(source) / 2, y: MacDesignV2.enabled ? 103 : 86) }
            if blank {
                BlackScreenCard { sharing.showPicker() }.frame(width: 342).position(x: 195, y: 124 + 76)
            } else if reacting {
                ReactingCue().position(x: 195, y: 142).transition(.opacity)
            } else if let speaker {
                SpeakerChip(name: speaker).frame(width: 342).position(x: 195, y: 124 + 34).transition(.opacity)
            }
            if notice {
                WatchPalette.dim.frame(width: 390, height: 844).allowsHitTesting(false)
                VStack(spacing: 0) {
                    Spacer(minLength: 0)
                    ShareNoticeSheet(choose: { sharing.acceptNotice() }, notNow: { sharing.noticeVisible = false })
                }.frame(width: 390, height: 844)
            }
        }
        .frame(width: 390, height: 844, alignment: .topLeading)
        .animation(.easeOut(duration: 0.2), value: reacting)
        .animation(.easeOut(duration: 0.2), value: speaker)
    }
}

enum WatchPalette {
    static let ink = Color(white: 17.0 / 255)
    static let sheet = Color(white: 254.0 / 255)
    static let onInk = Color(white: 253.0 / 255)
    static let onInkSoft = Color(white: 253.0 / 255).opacity(0.76)
    static let pill = Color(white: 17.0 / 255).opacity(0.84)
    static let dim = Color(white: 17.0 / 255).opacity(0.46)
    static let handle = Color(white: 219.0 / 255)
    static let rec = Color(red: 231.0 / 255, green: 32.0 / 255, blue: 12.0 / 255)
    static let blueOnInk = Color(red: 84.0 / 255, green: 193.0 / 255, blue: 1)
    static func sans(_ size: CGFloat, medium: Bool = false) -> Font { .custom(medium ? "PretendardVariable-Medium" : "PretendardVariable-Regular", size: size) }
    static func serif(_ size: CGFloat) -> Font { .custom("KMUTTF-SungkokSemiSerif", size: size) }
}

/// "● Sharing Safari" next to the menu button while a share is live.
struct SharingChip: View {
    var source: String?
    static func label(_ source: String?) -> String { source.map { "Sharing \($0)" } ?? "Sharing your screen" }
    static func width(_ source: String?) -> CGFloat {
        let text = label(source) as NSString
        let font = NSFont(name: "PretendardVariable-Medium", size: 14) ?? .systemFont(ofSize: 14, weight: .medium)
        return ceil(text.size(withAttributes: [.font: font]).width) + 12 + 8 + 8 + 12
    }
    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(WatchPalette.rec).frame(width: 8, height: 8)
            Text(Self.label(source)).font(WatchPalette.sans(14, medium: true)).lineLimit(1)
        }
        .foregroundStyle(WatchPalette.onInk).padding(.horizontal, 12).frame(height: 36)
        .background(WatchPalette.pill, in: Capsule())
        .accessibilityElement(children: .combine)
    }
}

/// MS-2: shown 1.5 s when the companion reacts first.
struct ReactingCue: View {
    var body: some View {
        HStack(spacing: 8) {
            SmileIcon().frame(width: 20, height: 20)
            Text("Reacting").font(WatchPalette.sans(14, medium: true))
        }
        .foregroundStyle(WatchPalette.onInk).padding(.vertical, 8).padding(.horizontal, 16).frame(minHeight: 36)
        .background(WatchPalette.pill, in: RoundedRectangle(cornerRadius: 18))
        .accessibilityElement(children: .combine).accessibilityAddTraits(.updatesFrequently)
    }
}

/// FT-SPK: one line, who is talking in the shared video. Hidden after 3 s of quiet (server).
struct SpeakerChip: View {
    var name: String
    var body: some View {
        HStack(spacing: 12) {
            WatchTalkWave().foregroundStyle(WatchPalette.blueOnInk).frame(width: 14, height: 20)
            VStack(alignment: .leading, spacing: 0) {
                Text("Talking on screen: \(name)").font(WatchPalette.sans(15, medium: true)).lineLimit(1)
                Text("From the shared screen’s sound").font(WatchPalette.sans(12)).foregroundStyle(WatchPalette.onInkSoft)
            }
            Spacer(minLength: 0)
        }
        .foregroundStyle(WatchPalette.onInk).padding(.vertical, 12).padding(.horizontal, 16)
        .background(WatchPalette.pill, in: RoundedRectangle(cornerRadius: 16))
        .accessibilityElement(children: .combine)
    }
}

/// MS-3: the shared window captures black. The companion also says it once.
struct BlackScreenCard: View {
    var shareAnother: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("This window shows up black to me.").font(WatchPalette.sans(15, medium: true))
            Text("Some apps block screen capture. I won’t guess what’s on it.").font(WatchPalette.sans(14)).foregroundStyle(WatchPalette.onInkSoft)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: shareAnother) {
                Text("Share another window").font(WatchPalette.sans(16, medium: true)).foregroundStyle(WatchPalette.ink)
                    .frame(maxWidth: .infinity).frame(height: 44).background(WatchPalette.onInk, in: RoundedRectangle(cornerRadius: 12))
            }.buttonStyle(.plain).padding(.top, 8).accessibilityIdentifier("watchShareAnother")
        }
        .foregroundStyle(WatchPalette.onInk).padding(16)
        .background(WatchPalette.pill, in: RoundedRectangle(cornerRadius: 16))
        .accessibilityElement(children: .contain)
    }
}

/// MS-1: first time Share is pressed. Choose → system picker (Genita left out) → C05 if no permission.
struct ShareNoticeSheet: View {
    var choose: () -> Void
    var notNow: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Capsule().fill(WatchPalette.handle).frame(width: 47, height: 5).frame(maxWidth: .infinity).padding(.bottom, 24)
            // Mac v2: break by meaning, never "what / you share."
            Text(MacDesignV2.enabled ? "I only see\nwhat you share." : "I only see what you share.").font(WatchPalette.serif(28)).tracking(-0.28).lineSpacing(6)
            // MS-1 (157:74): three even lines, one per sentence
            Text("Pick a window or your whole screen.\nI look while it’s shared and don’t keep it.\nGenita’s window is left out.")
                .font(WatchPalette.sans(15)).lineSpacing(9).padding(.top, 16).fixedSize(horizontal: false, vertical: true)
            Button(action: choose) {
                Text("Choose what to share").font(WatchPalette.sans(16, medium: true)).foregroundStyle(WatchPalette.onInk)
                    .frame(maxWidth: .infinity).frame(height: 50).background(WatchPalette.ink, in: RoundedRectangle(cornerRadius: 12))
            }.buttonStyle(.plain).padding(.top, 32).accessibilityIdentifier("watchChooseShare")
            Button(action: notNow) {
                Text("Not now").font(WatchPalette.sans(15, medium: true)).frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
            }.buttonStyle(.plain).padding(.top, 4)
        }
        .foregroundStyle(WatchPalette.ink)
        .padding(.top, 28).padding(.horizontal, 38).padding(.bottom, 48)
        .frame(width: 390, alignment: .leading)
        .background(WatchPalette.sheet, in: UnevenRoundedRectangle(topLeadingRadius: 30, topTrailingRadius: 30))
        .shadow(color: .black.opacity(0.06), radius: 12)
        .accessibilityIdentifier("watchShareNotice")
    }
}

private struct SmileIcon: View {
    var body: some View {
        Canvas { ctx, size in
            let s = size.width / 20
            let style = StrokeStyle(lineWidth: 1.8 * s, lineCap: .round, lineJoin: .round)
            ctx.stroke(Path(ellipseIn: CGRect(x: 2.5 * s, y: 2.5 * s, width: 15 * s, height: 15 * s)), with: .foreground, style: style)
            var mouth = Path()
            mouth.move(to: CGPoint(x: 7 * s, y: 11.5 * s))
            mouth.addCurve(to: CGPoint(x: 13 * s, y: 11.5 * s), control1: CGPoint(x: 8.6 * s, y: 13.3 * s), control2: CGPoint(x: 11.4 * s, y: 13.3 * s))
            ctx.stroke(mouth, with: .foreground, style: style)
            for x in [7.5, 12.5] {
                var eye = Path(); eye.move(to: CGPoint(x: x * s, y: 7.5 * s)); eye.addLine(to: CGPoint(x: x * s, y: 7.6 * s))
                ctx.stroke(eye, with: .foreground, style: style)
            }
        }
    }
}

private struct WatchTalkWave: View {
    var body: some View {
        HStack(spacing: 2) {
            ForEach(Array([8.0, 12, 9, 12].enumerated()), id: \.offset) { _, h in Capsule().frame(width: 2, height: h) }
        }
    }
}
