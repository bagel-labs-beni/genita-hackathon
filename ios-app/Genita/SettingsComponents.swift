import SwiftUI

// M02 Settings r01 C (춘식이 prefs, build 8): grouped white cards on #F2F2F7, the same look on every settings page.
// Values: group sides 16, radius 20; header SemiBold 13/18 #6E6E73, 22 above, 8 below, 32 from the edge; cell min 52,
// sides 16, Regular 17/22 #111, value #8A8A8E, chevron 7 pt / 1.6 pt #C4C4C7; separators 0.5 pt #D9D9DE inset 16.

enum SettingsInk {
    static let page = Color(red: 242 / 255, green: 242 / 255, blue: 247 / 255)
    static let card = Color.white
    static let ink = Color(red: 17 / 255, green: 17 / 255, blue: 17 / 255)
    static let header = Color(red: 110 / 255, green: 110 / 255, blue: 115 / 255)
    static let value = Color(red: 138 / 255, green: 138 / 255, blue: 142 / 255)
    static let chevron = Color(red: 196 / 255, green: 196 / 255, blue: 199 / 255)
    static let line = Color(red: 217 / 255, green: 217 / 255, blue: 222 / 255)
    static let body = Color(red: 58 / 255, green: 58 / 255, blue: 58 / 255)
    static let danger = Color(red: 200 / 255, green: 40 / 255, blue: 30 / 255)
}

/// Pretendard that follows Dynamic Type (relative to the text style it stands in for).
enum SettingsType {
    static func font(_ size: CGFloat, _ weight: Font.Weight = .regular, relativeTo style: Font.TextStyle = .body) -> Font {
        let face = weight == .semibold ? "SemiBold" : weight == .medium ? "Medium" : weight == .bold ? "Bold" : "Regular"
        return .custom("PretendardVariable-" + face, size: size, relativeTo: style)
    }
    static func serif(_ size: CGFloat, relativeTo style: Font.TextStyle = .title2) -> Font {
        .custom("KMUTTF-SungkokSemiSerif", size: size, relativeTo: style)
    }
}

/// The scrolling page every settings screen sits on.
struct SettingsPage<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) { content }
                .padding(.bottom, 32)
        }
        .background(SettingsInk.page.ignoresSafeArea())
    }
}

/// A group: optional header (with an optional action on the right) over a white card of rows.
struct SettingsGroup<Content: View>: View {
    var header: String? = nil
    var action: (title: String, run: () -> Void)? = nil
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let header {
                HStack(alignment: .firstTextBaseline) {
                    Text(header).font(SettingsType.font(13, .semibold, relativeTo: .footnote)).foregroundStyle(SettingsInk.header)
                        .accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 8)
                    if let action {
                        Button(action.title, action: action.run).font(SettingsType.font(13, .medium, relativeTo: .footnote)).foregroundStyle(SettingsInk.ink)
                            .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 16).padding(.top, 22).padding(.bottom, 8)
            } else {
                Color.clear.frame(height: 22)
            }
            VStack(spacing: 0) { content }
                .background(SettingsInk.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
        .padding(.horizontal, 16)
    }
}

/// A 0.5 pt separator inset 16 from the left, between rows of one group.
struct SettingsSeparator: View {
    var body: some View { Rectangle().fill(SettingsInk.line).frame(height: 0.5).padding(.leading, 16) }
}

/// The 7 pt chevron of a row that opens a page.
struct SettingsChevron: View {
    var body: some View {
        Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(SettingsInk.chevron)
            .accessibilityHidden(true)
    }
}

/// Title on the left, value on the right, optional chevron. min 52 tall.
struct SettingsRowLabel: View {
    let title: String
    var value: String? = nil
    var chevron = false
    var tint: Color = SettingsInk.ink
    var body: some View {
        HStack(spacing: 8) {
            Text(title).font(SettingsType.font(17)).foregroundStyle(tint)
            Spacer(minLength: 12)
            if let value { Text(value).font(SettingsType.font(17)).foregroundStyle(SettingsInk.value).lineLimit(1).truncationMode(.tail) }
            if chevron { SettingsChevron() }
        }
        .padding(.horizontal, 16).frame(minHeight: 52).contentShape(Rectangle())
    }
}

/// A tappable row (button style without the system highlight colour; a light press tint instead).
struct SettingsRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.background(configuration.isPressed ? SettingsInk.line.opacity(0.5) : .clear)
    }
}
