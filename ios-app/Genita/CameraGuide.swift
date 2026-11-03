import SwiftUI

// F5 CAM-1 (Figma 57:2) · first camera notice. Shown once, when the user first taps the camera button: the call dims
// (rgba(17,17,17,.46)) and a 333 pt sheet rises: handle, serif 28/34 title, two 16/24 lines, black "Turn on camera",
// text "Not now". "Turn on camera" starts the camera (and so the system permission prompt) and the guide is not shown again.
// FT-NOSEE (Figma 59:2) is below: the small card on the camera that says what the companion cannot see.

enum CameraGuide {
    private static let key = "genita.cameraGuideSeen"
    static var seen: Bool {
        get {
            #if DEBUG
            if ProcessInfo.processInfo.environment["GENITA_CAM1"] == "fresh" { return false }
            #endif
            return UserDefaults.standard.bool(forKey: key)
        }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }
}

struct CameraGuideSheet: View {
    let bottomInset: CGFloat
    var turnOn: () -> Void
    var notNow: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        ZStack(alignment: .bottom) {
            CallInk.dim.ignoresSafeArea().onTapGesture(perform: notNow).accessibilityHidden(true)
            VStack(spacing: 0) {
                Capsule().fill(CallInk.handle).frame(width: 47, height: 5).accessibilityHidden(true)
                Text("I only see when it’s on.").font(TypeStyle.title(28)).tracking(-0.28).foregroundStyle(CallInk.ink)
                    .frame(maxWidth: .infinity, minHeight: 34, alignment: .leading).padding(.top, 24).accessibilityAddTraits(.isHeader)
                Group {
                    if dynamicTypeSize > .large {
                        // larger text: one paragraph that wraps on its own (two fixed lines left "me things." alone)
                        Text("Turn on the camera to show me things. I look while it’s on and don’t keep the video.")
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        VStack(alignment: .leading, spacing: 0) {
                            Text("Turn on the camera to show me things.")
                            Text("I look while it’s on and don’t keep the video.")
                        }
                    }
                }.font(TypeStyle.text(16)).foregroundStyle(CallInk.ink).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 16)
                Button(action: turnOn) {
                    Text("Turn on camera").font(TypeStyle.text(16, .medium)).foregroundStyle(CallInk.onInk)
                        .frame(maxWidth: .infinity).frame(minHeight: 50).background(GlassCTA(color: CallInk.ink))
                }.buttonStyle(PressScale()).padding(.top, 32).accessibilityIdentifier("cameraGuideTurnOn")
                Button(action: notNow) {
                    Text("Not now").font(TypeStyle.text(15, .medium)).foregroundStyle(CallInk.ink).frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                }.buttonStyle(PressScale()).padding(.top, 4).accessibilityIdentifier("cameraGuideNotNow")
            }
            .padding(.horizontal, 38).padding(.top, 28).padding(.bottom, 48 + bottomInset)
            .frame(maxWidth: .infinity)
            .background(UnevenRoundedRectangle(topLeadingRadius: 30, topTrailingRadius: 30).fill(CallInk.sheet)
                .shadow(color: CallInk.ink.opacity(0.18), radius: 12).ignoresSafeArea(edges: .bottom))
            .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal).accessibilityIdentifier("cameraGuide")
        }
        .dynamicTypeSize(TextScale.sheet)
    }
}

/// FT-NOSEE · "For kimchi fried rice / ✓ Eggs / ✓ Scallions / ✗ I don't see cooked rice / Move the camera if it's there."
/// 220 wide at (24, 124), rgba(17,17,17,.84) radius 16, padding 16 × 12. Tap to put it away.
struct NoSeeCard: View {
    let check: NoSeeCheck
    var dismiss: () -> Void

    var body: some View {
        Button(action: dismiss) {
            VStack(alignment: .leading, spacing: 0) {
                Text(check.title).font(TypeStyle.body(12, .medium)).foregroundStyle(CallInk.onInk.opacity(0.76)).frame(height: 16)
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(check.rows) { row in
                        HStack(spacing: 8) {
                            Image(systemName: row.seen ? "checkmark" : "xmark").font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(row.seen ? CallInk.blueOnInk : CallInk.onInk).frame(width: 20, height: 20)
                            Text(row.seen ? row.name : "I don’t see \(row.name)").font(TypeStyle.body(15)).foregroundStyle(CallInk.onInk)
                                .lineLimit(1).minimumScaleFactor(0.9)
                        }.frame(height: 20)
                    }
                }.padding(.top, 8)
                Text(check.hint).font(TypeStyle.body(12)).foregroundStyle(CallInk.onInk.opacity(0.76)).frame(height: 16).padding(.top, 8)
            }
            .padding(.horizontal, 16).padding(.vertical, 12).frame(width: 220, alignment: .leading)
            .background(CallInk.pill, in: RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(([check.title] + check.rows.map { $0.seen ? "\($0.name), in view" : "I don’t see \($0.name)" } + [check.hint]).joined(separator: ". "))
        .accessibilityHint("Double tap to put it away")
        .accessibilityIdentifier("noSeeCard")
    }
}
