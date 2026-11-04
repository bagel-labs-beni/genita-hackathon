import SwiftUI
import AVFoundation
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// M02 Settings (r01 C, 춘식이 prefs: short iOS list, About you on its own page). Hackathon build: no "What I keep" row (ST-1's toggles were only for the
/// cut Us photo / seen memory; general memory stays on), Privacy · Terms (D16), Sign out, Delete account.
struct SettingsView: View {
    @Bindable var model: AppState
    @Environment(\.dismiss) private var dismiss
    /// M02-D: delete confirmation; M02: account actions only when signed in.
    @State private var confirmDelete = false
    @State private var working = false
    @State private var accountError: String?
    /// M02 "Make a new companion" (11/4): the same confirm style as M02-D; the account and what Genita knows stay
    @State private var confirmReset = false
    @State private var resetting = false
    @State private var resetError: String?
    /// RP-1 (D37): Report on M02
    @State private var reportOpen = false
    /// model.onboarding.auth (not a fresh GenitaAuthClient) so the --stub-signin UI-test session counts too
    private var signedIn: Bool { model.onboarding.auth.isSignedIn }
    static let labels = ["help": "Help with", "relationship": "Relationship", "challenge": "Challenge", "tempo": "Tempo", "initiative": "Reach out", "presenceDescription": "Presence"]
    static let scales = ["challenge": ["Gentle", "Direct"], "tempo": ["Reflective", "Quick"], "initiative": ["Only when asked", "Anticipate"]]
    static func label(for key: String) -> String { labels[key] ?? key.capitalized }
    /// The five slider stops read as words, not "Gentle 3/5 Direct" (UI sweep 11/3).
    static let steps = ["challenge": ["Gentle", "Mostly gentle", "In between", "Mostly direct", "Direct"],
                        "tempo": ["Reflective", "Mostly reflective", "In between", "Mostly quick", "Quick"],
                        "initiative": ["Only when asked", "Now and then", "Sometimes", "Often", "Anticipate"]]
    static func display(_ key: String, _ value: String) -> String {
        guard let words = steps[key], let step = Int(value) else { return value }
        return words[min(max(step, 0), words.count - 1)]
    }
    /// "Communication style / • Warm, direct." → a quiet heading over its bullets; a line that isn't followed
    /// by a bullet (a pasted reply in another shape) stays body text.
    static func styleLines(_ text: String) -> [(text: String, heading: Bool)] {
        let lines = text.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        return lines.enumerated().map { i, line in
            let next = i + 1 < lines.count ? lines[i + 1] : ""
            return (line, !line.hasPrefix("•") && next.hasPrefix("•"))
        }
    }
    private var companionName: String { model.companionDisplayName }
    /// M02 r01 C first screen: companion card → About you → Account → Start over → legal links. Five groups, one screen.
    /// The account's voice: the V04 pick on this phone, else the companion's saved voice from the server (another
    /// phone, a reinstall: build 7 Appetize showed "Default" after picking Leah, 11/4).
    private var voiceName: String {
        model.setup.voiceName ?? CuratedVoices.name(model.setup.voiceId) ?? "Default"
    }
    /// "1.0 (14)": CFBundleShortVersionString and CFBundleVersion (build).
    static func versionText(_ info: [String: Any]? = Bundle.main.infoDictionary) -> String {
        let v = info?["CFBundleShortVersionString"] as? String ?? "?"
        let b = info?["CFBundleVersion"] as? String
        return b.map { "\(v) (\($0))" } ?? v
    }
    var body: some View {
        NavigationStack {
            SettingsPage {
                SettingsGroup {
                    NavigationLink { SettingsCompanionPage(model: model) } label: { companionCard }
                        .buttonStyle(SettingsRowStyle()).accessibilityIdentifier("settingsCompanion")
                }
                SettingsGroup(header: "About you") {
                    NavigationLink { aboutYouPage } label: { aboutYouRow }
                        .buttonStyle(SettingsRowStyle()).accessibilityIdentifier("settingsAboutYou")
                    SettingsSeparator()
                    NavigationLink { SettingsShowsUpPage(model: model) } label: {
                        SettingsRowLabel(title: "How \(companionName) shows up", value: showsUpValue, chevron: true)
                    }.buttonStyle(SettingsRowStyle()).accessibilityIdentifier("settingsShowsUp")
                }
                SettingsGroup(header: "Account") {
                    HStack(spacing: 12) {
                        Text("Your name").font(SettingsType.font(17)).foregroundStyle(SettingsInk.ink)
                        TextField("Name", text: $model.setup.name).font(SettingsType.font(17)).foregroundStyle(SettingsInk.value)
                            .multilineTextAlignment(.trailing).submitLabel(.done).accessibilityIdentifier("settingsName")
                    }.padding(.horizontal, 16).frame(minHeight: 52)
                    if signedIn {
                        SettingsSeparator()
                        Button { reportOpen = true } label: { SettingsRowLabel(title: "Report a problem") }
                            .buttonStyle(SettingsRowStyle()).accessibilityIdentifier("settingsReport")
                        SettingsSeparator()
                        Button { signOut() } label: { SettingsRowLabel(title: "Sign out") }
                            .buttonStyle(SettingsRowStyle()).disabled(working || resetting).accessibilityIdentifier("signOut")
                    }
                }
                if signedIn {
                    // F1-L8: in-app account deletion (App Review 5.1.1(v)); D97 Make a new companion. Destructive, last.
                    SettingsGroup(header: "Start over") {
                        Button { confirmReset = true } label: { SettingsRowLabel(title: resetting ? "Starting over…" : "Make a new companion") }
                            .buttonStyle(SettingsRowStyle()).disabled(resetting || working).accessibilityIdentifier("makeNewCompanion")
                        SettingsSeparator()
                        Button { confirmDelete = true } label: { SettingsRowLabel(title: working ? "Deleting…" : "Delete account", tint: SettingsInk.danger) }
                            .buttonStyle(SettingsRowStyle()).disabled(working || resetting).accessibilityIdentifier("deleteAccount")
                    }
                }
                SettingsGroup(header: "About") {
                    SettingsRowLabel(title: "Version", value: Self.versionText()).accessibilityElement(children: .combine).accessibilityIdentifier("settingsVersion")
                }
                HStack(spacing: 6) {
                    Link("Privacy Policy", destination: URL(string: "https://bagel-labs-beni.github.io/genita-legal/privacy/")!)
                    Text("·").accessibilityHidden(true)
                    Link("Terms", destination: URL(string: "https://bagel-labs-beni.github.io/genita-legal/terms/")!)
                }
                .font(SettingsType.font(13, relativeTo: .footnote)).foregroundStyle(SettingsInk.header).tint(SettingsInk.header)
                .frame(maxWidth: .infinity).padding(.top, 24)
            }
            .navigationTitle("Settings")
            #if os(iOS)
            // the About you row's preview and counts come from the insight report (GET /v1/profile/insights); read again
            // on every open — a call may have scrubbed it since ("forget that", That's not me: AU-94). The old one stays
            // on screen meanwhile.
            .task { await model.loadCompanionSince() }
            .task { if model.insightsEnabled { await model.loadInsights() } }
            #endif
            .reportFlow(isPresented: $reportOpen, surface: "settings", auth: model.onboarding.auth) { CallController.shared.lastReplyText }
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                // r01 C: the title in Pretendard SemiBold 17 (the bar keeps "Settings" as its name for VoiceOver and tests)
                ToolbarItem(placement: .principal) { Text("Settings").font(SettingsType.font(17, .semibold, relativeTo: .headline)).foregroundStyle(SettingsInk.ink).accessibilityAddTraits(.isHeader) }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.font(SettingsType.font(15, .semibold)) }
            }
            .confirmationDialog("Delete your account?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete account", role: .destructive) { deleteAccount() }
                Button("Cancel", role: .cancel) {}
            } message: { Text("This deletes your companion, your conversation, memories and Finds on your iPhone and Mac. It can’t be undone.") }
            .confirmationDialog("Start over with someone new?", isPresented: $confirmReset, titleVisibility: .visible) {
                Button("Start over", role: .destructive) { resetCompanion() }
                Button("Cancel", role: .cancel) {}
            } message: { Text(Self.resetMessage(model.setup.companionName)) }
            .alert("Couldn’t start over", isPresented: Binding(get: { resetError != nil }, set: { if !$0 { resetError = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(resetError ?? "") }
            .alert("Couldn’t delete your account", isPresented: Binding(get: { accountError != nil }, set: { if !$0 { accountError = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(accountError ?? "") }
        }
        #if os(iOS)
        .presentationDetents([.large])
        #else
        .frame(width: 390, height: 600)
        #endif
    }

    /// M02 r01 C (Chelsea OK 04:19): About you is the insight report R1 without its CTA; when the report can't be had
    /// (flag off, failed) the style card's own lines in the same groups.
    @ViewBuilder private var aboutYouPage: some View {
        #if os(iOS)
        if model.useInsightReport {
            InsightReportView(model: model, showsCTA: false)
                .settingsTitle("About you")
        } else {
            AboutYouPage(model: model)
        }
        #else
        AboutYouPage(model: model)
        #endif
    }
    /// C1 companion card: photo 56 (circle), name KMU80 22, "{voice} voice" 13 #737373 (D99).
    private var companionCard: some View {
        HStack(spacing: 14) {
            SettingsAvatar(imageData: model.setup.imageData, name: companionName, size: 56)
            VStack(alignment: .leading, spacing: 2) {
                Text(companionName).font(SettingsType.serif(22)).foregroundStyle(SettingsInk.ink).lineLimit(1)
                companionSubtitleView
            }
            Spacer(minLength: 8)
            SettingsChevron()
        }
        .padding(16).contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
    /// "{voice} voice" and, when there is one, "Together N days" / "Met today" / "Demo companion" (D99). One line when both fit
    /// ("{voice} voice · Together 12 days"); else two lines without the dot; a voice name that overflows alone is tail-truncated.
    @ViewBuilder private var companionSubtitleView: some View {
        let voice = voiceName + " voice"
        let extra = companionSubtitleExtra
        let font = SettingsType.font(13, relativeTo: .footnote)
        Group {
            if let extra {
                ViewThatFits(in: .horizontal) {
                    Text(voice + " · " + extra).lineLimit(1)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(voice).lineLimit(1).truncationMode(.tail)
                        Text(extra).lineLimit(1).truncationMode(.tail)
                    }
                }
            } else {
                Text(voice).lineLimit(1).truncationMode(.tail)
            }
        }
        .font(font).foregroundStyle(SettingsInk.secondary)
    }
    private var companionSubtitleExtra: String? {
        if model.setup.companionDemo == true { return "Demo companion" }
        // D99 "함께한 날": nothing when the date is unknown
        return CompanionTogether.label(createdAt: model.setup.companionSince)
    }
    /// C1 About you row: "What {name} knows about you", the report's headline (2 lines max), "{n} things · {m} still learning".
    private var aboutYouRow: some View {
        // the report when there is one; else the style card's own lines (the page behind the row shows those — QA)
        let summary = model.insightReport != nil ? AboutYouSummary(report: model.insightReport, companion: companionName)
            : AboutYouSummary(noticed: AboutYouPage.noticed(AboutYouPage.styleText(model.setup)), companion: companionName)
        return HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                Text("What \(companionName) knows about you").font(SettingsType.font(17, .semibold)).foregroundStyle(SettingsInk.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Text(summary.preview).font(SettingsType.font(15, relativeTo: .subheadline)).foregroundStyle(SettingsInk.body).lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                if let counts = summary.counts {
                    Text(counts).font(SettingsType.font(13, relativeTo: .footnote)).foregroundStyle(SettingsInk.header)
                }
            }
            Spacer(minLength: 4)
            SettingsChevron().padding(.top, 4)
        }
        .padding(.horizontal, 16).padding(.vertical, 14).contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
    /// The first screen shows the help answer ("Think with me"); the page holds the rest.
    private var showsUpValue: String? {
        model.setup.answers["help"].map { Self.display("help", $0) }
    }

    /// "{Name}, their face, voice and your chats together will be removed. What Genita knows about you stays."
    static func resetMessage(_ companionName: String?) -> String {
        let n = CompanionName.clean(companionName ?? "")
        return "\(n.isEmpty ? "Your companion" : n), their face, voice and your chats together will be removed. What Genita knows about you stays."
    }
    /// GET /v1/companion after a failed reset: nil = it's still there, else the error (404 = gone).
    private static func companionLookup(_ model: AppState) async -> GenitaAuthError? {
        do { _ = try await model.onboarding.companion(); return nil }
        catch { return (error as? GenitaAuthError) ?? .badResponse }
    }
    private func resetCompanion() {
        resetting = true
        // the account this was asked for: a late answer after a sign-out / another sign-in must not touch the new one (Codex P2)
        let asked = model.launchAuthSnapshot
        let resets = model.companionResets
        Task { @MainActor in
            defer { resetting = false }
            do {
                try await model.onboarding.resetCompanion()
                guard asked.accepts(model.launchAuthSnapshot) else { return }
                // the call's 4410 reset this phone already: the user may have picked a new photo or started a new
                // call since — this late answer touches nothing, not even the call (Codex #514 r2)
                guard model.companionResets == resets else { return }
                CallController.shared.end()
                dismiss()
                model.companionResetAnswered(since: resets)
            } catch GenitaAuthError.unauthorized where asked.generation == model.authGeneration {
                // this request's 401 cleared the token (same sign-in): A02, as everywhere else
                dismiss()
                model.signedOut()
            } catch _ where !asked.accepts(model.launchAuthSnapshot) {
                return
            } catch GenitaAuthError.server(status: 429, _, _) {
                resetError = "You’ve started over a lot today. Try again tomorrow."
            } catch {
                // a failure after the companion's rows went (its files, say) still started over (#514 Codex r3 P2):
                // ask the server what is there now instead of saying nothing was removed
                let now = await Self.companionLookup(model)
                if now == .unauthorized, asked.generation == model.authGeneration { dismiss(); model.signedOut(); return }
                if case GenitaAuthError.server(404, _, _)? = now {
                    guard asked.accepts(model.launchAuthSnapshot), model.companionResets == resets else { return }
                    CallController.shared.end()
                    dismiss()
                    model.companionResetAnswered(since: resets)
                    return
                }
                resetError = "Try again in a moment."
            }
        }
    }
    private func signOut() {
        working = true
        Task { @MainActor in
            defer { working = false }
            await model.onboarding.auth.logout()
            dismiss()
            model.signedOut()
        }
    }
    private func deleteAccount() {
        working = true
        // whose camera frames these are, read before the token goes away with the account
        let frameOwner = FindFrameStore.owner()
        Task { @MainActor in
            defer { working = false }
            // its finds' ids: frames saved before 11/4 sit loose, without an owner (Codex r2)
            let ids = ((try? await CallController.shared.findsAPI.list()) ?? []).map(\.id)
            do {
                _ = try await model.onboarding.auth.deleteAccount()
                // the fridge / outfit frames kept for reopened Finds are this account's camera pictures (AU-75)
                FindFrameStore.removeAll(owner: frameOwner, ids: ids)
                dismiss()
                model.accountDeleted()
            } catch GenitaAuthError.unauthorized {
                // the session expired (a 401 can't say the account went: only the server's 200 does). Sign in again,
                // like any expired session; nothing is wiped and there is no "deleted" notice. Signed in again, the
                // delete can be asked once more (Codex b10-3 P2).
                dismiss(); model.signedOut()
            } catch {
                // a failure may have removed part of it (the server deletes files before rows): never "nothing was
                // deleted", and never "deleted" without the server's answer
                accountError = "Couldn’t finish deleting your account. Try again."
            }
        }
    }
}

// MARK: - M02 r01 C components (this file is built into GenitaMac too, so the pieces live here, not in iOS-only files)

// M02 Settings r01 C (춘식이 prefs, build 8): grouped white cards on #F2F2F7, the same look on every settings page.
// Values: group sides 16, radius 20; header SemiBold 13/18 #6E6E73, 22 above, 8 below, 32 from the edge; cell min 52,
// sides 16, Regular 17/22 #111, value #8A8A8E, chevron 7 pt / 1.6 pt #C4C4C7; separators 0.5 pt #D9D9DE inset 16.

enum SettingsInk {
    static let page = Color(red: 242 / 255, green: 242 / 255, blue: 247 / 255)
    static let card = Color.white
    static let ink = Color(red: 17 / 255, green: 17 / 255, blue: 17 / 255)
    static let header = Color(red: 110 / 255, green: 110 / 255, blue: 115 / 255)
    /// C1 companion card secondary line: spec #737373 (D99; header stays #6E6E73).
    static let secondary = Color(red: 115 / 255, green: 115 / 255, blue: 115 / 255)
    static let value = Color(red: 138 / 255, green: 138 / 255, blue: 142 / 255)
    static let chevron = Color(red: 196 / 255, green: 196 / 255, blue: 199 / 255)
    static let line = Color(red: 217 / 255, green: 217 / 255, blue: 222 / 255)
    static let body = Color(red: 58 / 255, green: 58 / 255, blue: 58 / 255)
    static let danger = Color(red: 200 / 255, green: 40 / 255, blue: 30 / 255)
    static let pending = Color(red: 107 / 255, green: 107 / 255, blue: 107 / 255)
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
        .modifier(SettingsSolidBar())
    }
}

/// A settings sub-page's inline title, pinned to SettingsInk.ink in Pretendard SemiBold 17 like the root "Settings" (the
/// bar keeps the text as its name for VoiceOver and tests). The system title colour followed the colour scheme, so a dark
/// scheme left on the sheet drew it white on #F2F2F7 (UI QA b10, CI `preview-10b-about-you` / `10c-shows-up`).
extension View {
    func settingsTitle(_ title: String) -> some View {
        #if os(iOS)
        navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text(title).font(SettingsType.font(17, .semibold, relativeTo: .headline)).foregroundStyle(SettingsInk.ink).lineLimit(1).accessibilityAddTraits(.isHeader)
                }
            }
        #else
        navigationTitle(title)
        #endif
    }
}

/// TF 331 (Chelsea 15:39): the inline "Settings" bar was see-through, so the first group slid under the title and the
/// Done pill as a blur once scrolled. The bar is the page colour, always shown, with a hard edge (iOS 26).
private struct SettingsSolidBar: ViewModifier {
    func body(content: Content) -> some View {
        #if os(iOS)
        let solid = content
            .toolbarBackground(SettingsInk.page, for: .navigationBar)
            .toolbarBackgroundVisibility(.visible, for: .navigationBar)
        if #available(iOS 26.0, *) { solid.scrollEdgeEffectStyle(.hard, for: .top) } else { solid }
        #else
        content
        #endif
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

// MARK: - pages

// M02 r01 C (춘식이 prefs, build 8): the pages the settings rows open.

/// The companion's photo in a circle; the first letter on a warm tint when there is none.
struct SettingsAvatar: View {
    let imageData: Data?
    let name: String
    var size: CGFloat = 56
    var body: some View {
        Group {
            if let image = imageData.flatMap(Self.image) {
                image.resizable().scaledToFill()
            } else {
                ZStack {
                    RadialGradient(colors: [Color(red: 0.89, green: 0.80, blue: 0.72), Color(red: 0.69, green: 0.55, blue: 0.45)], center: .topLeading, startRadius: 2, endRadius: size)
                    Text(String(name.prefix(1)).uppercased()).font(SettingsType.font(size * 0.4, .medium)).foregroundStyle(.white)
                }
            }
        }
        .frame(width: size, height: size).clipShape(Circle()).accessibilityHidden(true)
    }
    private static func image(_ data: Data) -> Image? {
        #if canImport(UIKit)
        UIImage(data: data).map { Image(uiImage: $0) }
        #else
        NSImage(data: data).map { Image(nsImage: $0) }
        #endif
    }
}

/// What the About you row says. The insight report (GET /v1/profile/insights) fills it once it is on the phone;
/// until then the row says the companion is still learning instead of listing blanks.
struct AboutYouSummary: Equatable {
    var preview: String
    /// "{n} things · {m} still learning"; nil when there is nothing to count yet
    var counts: String?

    init(preview: String, counts: String?) { self.preview = preview; self.counts = counts }
    /// No report: the first noticed line as the preview, "{n} things" from the style card's rows.
    init(noticed: [(category: String?, claims: [String])], companion: String) {
        let claims = noticed.flatMap(\.claims)
        self = Self.make(headline: claims.first, known: claims.count, learning: 0, companion: companion)
    }
    init(report: InsightReport?, companion: String) {
        self = Self.make(headline: report?.headline, known: report?.observations.count ?? 0, learning: report?.learning.count ?? 0, companion: companion)
    }
    /// The headline in curly quotes; the counts only when something is known.
    static func make(headline: String?, known: Int, learning: Int, companion: String) -> AboutYouSummary {
        guard let h = headline?.trimmingCharacters(in: .whitespacesAndNewlines), !h.isEmpty, known > 0 else {
            return AboutYouSummary(preview: "\(companion) is still getting to know you.", counts: nil)
        }
        let things = known == 1 ? "1 thing" : "\(known) things"
        // no one-word last line: the last space is unbreakable (insight R1's keepLast rule)
        let quoted = "“\(h)”"
        let kept = quoted.range(of: " ", options: .backwards).map { quoted.replacingCharacters(in: $0, with: "\u{00A0}") } ?? quoted
        return AboutYouSummary(preview: kept, counts: learning > 0 ? "\(things) · \(learning) still learning" : things)
    }
}

/// Name and voice of the companion; Voice opens the V04 list (iPhone, 11/4).
struct SettingsCompanionPage: View {
    @Bindable var model: AppState
    @State private var voiceOpen = false
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
                #if os(iOS)
                // 11/4: the V04 list as a sheet, so the voice can change after onboarding (iPhone; the Mac reads the saved voice)
                Button { voiceOpen = true } label: {
                    SettingsRowLabel(title: "Voice", value: model.setup.voiceName ?? CuratedVoices.name(model.setup.voiceId) ?? "Default", chevron: true)
                }.buttonStyle(SettingsRowStyle()).accessibilityIdentifier("settingsVoice")
                #else
                SettingsRowLabel(title: "Voice", value: model.setup.voiceName ?? CuratedVoices.name(model.setup.voiceId) ?? "Default")
                #endif
            }
        }
        .settingsTitle("Your companion")
        #if os(iOS)
        .sheet(isPresented: $voiceOpen) { VoiceSettingsSheet(model: model) }
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
        .settingsTitle("How \(model.companionDisplayName) shows up")
    }
    /// Help with first (it is what the first screen shows), then the onboarding order, then anything else.
    static func keys(_ answers: [String: String]) -> [String] {
        let order = ["help", "relationship", "challenge", "tempo", "initiative", "presenceDescription"]
        return order.filter { answers[$0] != nil } + answers.keys.filter { !order.contains($0) }.sorted()
    }
}

// MARK: - About you

/// M02 r01 C "About you" (C2–C4): what the companion knows, in the insight report's words, each one fixable.
/// Until the insight report is on the phone it shows the imported style card's own lines in the same rows, and one
/// "Still learning" block instead of repeated "Not enough information yet." lines.
struct AboutYouPage: View {
    @Bindable var model: AppState
    private var name: String { model.companionDisplayName }
    private var styleText: String { Self.styleText(model.setup) }
    static func styleText(_ setup: SavedSetup) -> String {
        guard let rows = setup.styleRows, !rows.isEmpty else { return setup.response }
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
            // C3: one Still learning block, r16, 14/16 — white on the #F2F2F7 page (lead 11/4: #F4F4F2 vanished on it)
            // Chelsea 11/4: only while something is still missing; a full card shows only what it knows
            if Self.hasGaps(styleText) {
            VStack(alignment: .leading, spacing: 0) {
                Text("Still learning").font(SettingsType.font(13, .semibold, relativeTo: .footnote)).foregroundStyle(SettingsInk.header)
                    .accessibilityAddTraits(.isHeader).padding(.horizontal, 16).padding(.top, 22).padding(.bottom, 8)
                // an empty slot, not an info card: the line in the secondary tone (춘식이 #6B6B6B)
                Text("I’ll pick these up as we talk.").font(SettingsType.font(15, relativeTo: .subheadline)).foregroundStyle(SettingsInk.pending)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.vertical, 14)
                    .background(SettingsInk.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            }.padding(.horizontal, 16)
            }
            SettingsGroup(header: "Where this comes from") {
                // the paste only: the skip path fills styleRows from the answers too (Codex P3)
                if !model.setup.response.isEmpty {
                    SettingsRowLabel(title: "Your ChatGPT reply")
                    SettingsSeparator()
                }
                SettingsRowLabel(title: "Your answers", value: model.setup.depth.title)
            }
        }
        .settingsTitle("About you")
    }

    /// Still learning shows only while the card has a gap: nothing noticed yet, a heading with no claims, or a
    /// "Not enough information yet." line.
    static func hasGaps(_ text: String) -> Bool {
        let groups = noticed(text)
        if groups.isEmpty || groups.contains(where: { $0.claims.isEmpty }) { return true }
        return SettingsView.styleLines(text).contains { line in
            let t = line.text.hasPrefix("•") ? String(line.text.dropFirst()).trimmingCharacters(in: .whitespaces) : line.text
            return t.lowercased().hasPrefix("not enough information")
        }
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

/// The four V04 voices' names by server id (genita-server src/prep/voices.ts DEFAULT_VOICES). Lives here, not in the
/// iOS-only OnboardingViews.swift, because the GenitaMac target compiles this file too.
enum CuratedVoices {
    static let names = ["72": "Tara", "9": "Leah", "19": "Leo", "26": "Dan"]
    static func name(_ id: String?) -> String? { id.flatMap { names[$0] } }
}
