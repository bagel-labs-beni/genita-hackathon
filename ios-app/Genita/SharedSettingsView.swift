import SwiftUI
import AVFoundation

/// M02 Settings (iPhone + Mac). Hackathon build: no "What I keep" row (ST-1's toggles were only for the
/// cut Us photo / seen memory; general memory stays on), Privacy · Terms (D16), Sign out, Delete account.
struct SettingsView: View {
    @Bindable var model: AppState
    @Environment(\.dismiss) private var dismiss
    /// M02-D: delete confirmation; M02: account actions only when signed in.
    @State private var confirmDelete = false
    @State private var working = false
    @State private var accountError: String?
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
    private var styleText: String {
        guard let rows = model.setup.styleRows, !rows.isEmpty else { return model.setup.response }
        return ImportedStyle(rows: rows, partial: false, toConfirm: [], profile: "", source: "").displayText
    }
    private var voiceName: String {
        model.setup.voiceName ?? "Default"
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("Profile") { TextField("Name", text: $model.setup.name) }
                Section("Your companion") {
                    LabeledContent("Name", value: model.companionDisplayName)
                    if model.setup.companionDemo == true {
                        // judge accounts start with a ready-made companion (PR #178)
                        Text("Demo companion").font(.footnote).foregroundStyle(.secondary).accessibilityIdentifier("demoCompanionLabel")
                    }
                    LabeledContent("Voice", value: voiceName)
                }
                Section("Your preferences") {
                    if !styleText.isEmpty {
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(Array(Self.styleLines(styleText).enumerated()), id: \.offset) { i, line in
                                Text(line.text)
                                    .font(.custom(line.heading ? "PretendardVariable-Medium" : "PretendardVariable-Regular", fixedSize: line.heading ? 13 : 15))
                                    .foregroundStyle(line.heading ? .secondary : .primary)
                                    .padding(.top, line.heading && i > 0 ? 10 : 0)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }.padding(.vertical, 4).textSelection(.enabled).accessibilityElement(children: .combine)
                    }
                    LabeledContent("Setup", value: model.setup.depth.title)
                    ForEach(model.setup.answers.keys.sorted(), id: \.self) { key in LabeledContent(Self.label(for: key), value: Self.display(key, model.setup.answers[key] ?? "")) }
                }
                if signedIn {
                    // F1-L8: sign out and in-app account deletion (App Review 5.1.1(v))
                    Section("Account") {
                        Button("Report a problem") { reportOpen = true }.accessibilityIdentifier("settingsReport")
                        Button("Sign out") { signOut() }.disabled(working).accessibilityIdentifier("signOut")
                        Button(working ? "Deleting…" : "Delete account", role: .destructive) { confirmDelete = true }.disabled(working).accessibilityIdentifier("deleteAccount")
                    }
                }
                Section {
                    Link("Privacy Policy", destination: URL(string: "https://bagel-labs-beni.github.io/genita-legal/privacy/")!)
                    Link("Terms", destination: URL(string: "https://bagel-labs-beni.github.io/genita-legal/terms/")!)
                }
            }.navigationTitle("Settings")
            .reportFlow(isPresented: $reportOpen, surface: "settings", auth: model.onboarding.auth) { CallController.shared.lastReplyText }
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .confirmationDialog("Delete your account?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete account", role: .destructive) { deleteAccount() }
                Button("Cancel", role: .cancel) {}
            } message: { Text("This deletes your companion, your conversation, memories and Finds on your iPhone and Mac. It can’t be undone.") }
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
