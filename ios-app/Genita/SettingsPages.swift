import SwiftUI
import UIKit

// M02 r01 C (춘식이 prefs, build 8): the pages the settings rows open.

/// The companion's photo in a circle; the first letter on a warm tint when there is none.
struct SettingsAvatar: View {
    let imageData: Data?
    let name: String
    var size: CGFloat = 56
    var body: some View {
        Group {
            if let imageData, let image = UIImage(data: imageData) {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                ZStack {
                    RadialGradient(colors: [Color(red: 0.89, green: 0.80, blue: 0.72), Color(red: 0.69, green: 0.55, blue: 0.45)], center: .topLeading, startRadius: 2, endRadius: size)
                    Text(String(name.prefix(1)).uppercased()).font(SettingsType.font(size * 0.4, .medium)).foregroundStyle(.white)
                }
            }
        }
        .frame(width: size, height: size).clipShape(Circle()).accessibilityHidden(true)
    }
}

/// What the About you row says. The insight report (GET /v1/profile/insights) fills it once it is on the phone;
/// until then the row says the companion is still learning instead of listing blanks.
struct AboutYouSummary: Equatable {
    var preview: String
    /// "{n} things · {m} still learning"; nil when there is nothing to count yet
    var counts: String?

    init(preview: String, counts: String?) { self.preview = preview; self.counts = counts }
    init(model: AppState) {
        self = Self.make(headline: nil, known: 0, learning: 0, companion: model.companionDisplayName)
    }
    /// The headline in curly quotes; the counts only when something is known.
    static func make(headline: String?, known: Int, learning: Int, companion: String) -> AboutYouSummary {
        guard let h = headline?.trimmingCharacters(in: .whitespacesAndNewlines), !h.isEmpty, known > 0 else {
            return AboutYouSummary(preview: "\(companion) is still getting to know you.", counts: nil)
        }
        let things = known == 1 ? "1 thing" : "\(known) things"
        return AboutYouSummary(preview: "“\(h)”", counts: learning > 0 ? "\(things) · \(learning) still learning" : things)
    }
}

/// Name and voice of the companion (read-only today).
struct SettingsCompanionPage: View {
    @Bindable var model: AppState
    var body: some View {
        SettingsPage {
            VStack(spacing: 10) {
                SettingsAvatar(imageData: model.setup.imageData, name: model.companionDisplayName, size: 96)
                Text(model.companionDisplayName).font(SettingsType.serif(28, relativeTo: .title)).foregroundStyle(SettingsInk.ink)
                if model.setup.companionDemo == true {
                    // judge accounts start with a ready-made companion (PR #178)
                    Text("Demo companion").font(SettingsType.font(13, relativeTo: .footnote)).foregroundStyle(SettingsInk.header)
                        .accessibilityIdentifier("demoCompanionLabel")
                }
            }.frame(maxWidth: .infinity).padding(.top, 24)
            SettingsGroup {
                SettingsRowLabel(title: "Name", value: model.companionDisplayName)
                SettingsSeparator()
                SettingsRowLabel(title: "Voice", value: model.setup.voiceName ?? "Default")
            }
        }
        .navigationTitle("Your companion")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }
}

/// "How {name} shows up": the setup answers (Help with, Relationship, Challenge, Tempo, Reach out, Presence) as rows.
struct SettingsShowsUpPage: View {
    @Bindable var model: AppState
    var body: some View {
        SettingsPage {
            SettingsGroup {
                SettingsRowLabel(title: "Setup", value: model.setup.depth.title)
                ForEach(Self.keys(model.setup.answers), id: \.self) { key in
                    SettingsSeparator()
                    SettingsRowLabel(title: SettingsView.label(for: key), value: SettingsView.display(key, model.setup.answers[key] ?? ""))
                }
            }
        }
        .navigationTitle("How \(model.companionDisplayName) shows up")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }
    /// Help with first (it is what the first screen shows), then the onboarding order, then anything else.
    static func keys(_ answers: [String: String]) -> [String] {
        let order = ["help", "relationship", "challenge", "tempo", "initiative", "presenceDescription"]
        return order.filter { answers[$0] != nil } + answers.keys.filter { !order.contains($0) }.sorted()
    }
}
