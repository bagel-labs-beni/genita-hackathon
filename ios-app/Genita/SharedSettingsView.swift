import SwiftUI
import AVFoundation

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
    var body: some View {
        NavigationStack {
            SettingsPage {
                SettingsGroup {
                    NavigationLink { SettingsCompanionPage(model: model) } label: { companionCard }
                        .buttonStyle(SettingsRowStyle()).accessibilityIdentifier("settingsCompanion")
                }
                SettingsGroup(header: "About you") {
                    NavigationLink { AboutYouPage(model: model) } label: { aboutYouRow }
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
                HStack(spacing: 6) {
                    Link("Privacy Policy", destination: URL(string: "https://bagel-labs-beni.github.io/genita-legal/privacy/")!)
                    Text("·").accessibilityHidden(true)
                    Link("Terms", destination: URL(string: "https://bagel-labs-beni.github.io/genita-legal/terms/")!)
                }
                .font(SettingsType.font(13, relativeTo: .footnote)).foregroundStyle(SettingsInk.header).tint(SettingsInk.header)
                .frame(maxWidth: .infinity).padding(.top, 24)
            }
            .navigationTitle("Settings")
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

    /// C1 companion card: photo 56 (circle), name KMU80 22, "{voice} voice" 13 #6E6E73.
    private var companionCard: some View {
        HStack(spacing: 14) {
            SettingsAvatar(imageData: model.setup.imageData, name: companionName, size: 56)
            VStack(alignment: .leading, spacing: 2) {
                Text(companionName).font(SettingsType.serif(22)).foregroundStyle(SettingsInk.ink).lineLimit(1)
                Text(companionSubtitle).font(SettingsType.font(13, relativeTo: .footnote)).foregroundStyle(SettingsInk.header).lineLimit(2)
            }
            Spacer(minLength: 8)
            SettingsChevron()
        }
        .padding(16).contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
    private var companionSubtitle: String {
        let voice = model.setup.voiceName.map { "\($0) voice" } ?? "Default voice"
        return model.setup.companionDemo == true ? voice + " · Demo companion" : voice
    }
    /// C1 About you row: "What {name} knows about you", the report's headline (2 lines max), "{n} things · {m} still learning".
    private var aboutYouRow: some View {
        let summary = AboutYouSummary(model: model)
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
    private func resetCompanion() {
        resetting = true
        // the account this was asked for: a late answer after a sign-out / another sign-in must not touch the new one (Codex P2)
        let asked = model.launchAuthSnapshot
        Task { @MainActor in
            defer { resetting = false }
            do {
                try await model.onboarding.resetCompanion()
                guard asked.accepts(model.launchAuthSnapshot) else { return }
                CallController.shared.end()
                dismiss()
                model.companionReset()
            } catch GenitaAuthError.unauthorized where asked.generation == model.authGeneration {
                // this request's 401 cleared the token (same sign-in): A02, as everywhere else
                dismiss()
                model.signedOut()
            } catch _ where !asked.accepts(model.launchAuthSnapshot) {
                return
            } catch GenitaAuthError.server(status: 429, _) {
                resetError = "You’ve started over a lot today. Try again tomorrow."
            } catch {
                resetError = "Try again in a moment. Nothing was removed."
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
        Task { @MainActor in
            defer { working = false }
            do {
                _ = try await model.onboarding.auth.deleteAccount()
                dismiss()
                model.accountDeleted()
            } catch {
                accountError = "Try again in a moment. Nothing was deleted."
            }
        }
    }
}
