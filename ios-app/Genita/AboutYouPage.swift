import SwiftUI

/// M02 r01 C "About you" (C2–C4): what the companion knows, in the insight report's words, each one fixable.
/// Until the insight report is on the phone it shows the imported style card's own lines in the same rows, and one
/// "Still learning" block instead of repeated "Not enough information yet." lines.
struct AboutYouPage: View {
    @Bindable var model: AppState
    private var name: String { model.companionDisplayName }
    private var styleText: String {
        guard let rows = model.setup.styleRows, !rows.isEmpty else { return model.setup.response }
        return ImportedStyle(rows: rows, partial: false, toConfirm: [], profile: "", source: "").displayText
    }
    var body: some View {
        let groups = Self.noticed(styleText)
        SettingsPage {
            if !groups.isEmpty {
                SettingsGroup(header: "What \(name) noticed") {
                    ForEach(Array(groups.enumerated()), id: \.offset) { i, g in
                        if i > 0 { SettingsSeparator() }
                        VStack(alignment: .leading, spacing: 4) {
                            if let category = g.category {
                                Text(category).font(SettingsType.font(12, .semibold, relativeTo: .caption)).foregroundStyle(SettingsInk.header)
                            }
                            ForEach(g.claims, id: \.self) { claim in
                                Text(claim).font(SettingsType.font(17, .semibold)).foregroundStyle(SettingsInk.ink).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.vertical, 14)
                        .accessibilityElement(children: .combine)
                    }
                }
            }
            SettingsGroup(header: "Still learning") {
                Text("I’ll pick these up as we talk.").font(SettingsType.font(15, relativeTo: .subheadline)).foregroundStyle(SettingsInk.body)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.vertical, 14)
            }
            SettingsGroup(header: "Where this comes from") {
                if !model.setup.response.isEmpty || model.setup.styleRows?.isEmpty == false {
                    SettingsRowLabel(title: "Your ChatGPT reply")
                    SettingsSeparator()
                }
                SettingsRowLabel(title: "Your answers", value: model.setup.depth.title)
            }
        }
        .navigationTitle("About you")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    /// The style card's text as observation rows: a heading becomes the row's category, its bullets the claims.
    /// "Not enough information yet." lines are dropped (they belong to the one Still learning block).
    static func noticed(_ text: String) -> [(category: String?, claims: [String])] {
        var out: [(category: String?, claims: [String])] = []
        for line in SettingsView.styleLines(text) {
            if line.heading { out.append((line.text, [])); continue }
            let claim = line.text.hasPrefix("•") ? String(line.text.dropFirst()).trimmingCharacters(in: .whitespaces) : line.text
            guard !claim.isEmpty, !claim.lowercased().hasPrefix("not enough information") else { continue }
            if out.isEmpty { out.append((nil, [])) }
            out[out.count - 1].claims.append(claim)
        }
        return out.filter { !$0.claims.isEmpty }
    }
}
