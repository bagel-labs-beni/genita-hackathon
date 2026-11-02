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
    /// model.onboarding.auth (not a fresh GenitaAuthClient) so the --stub-signin UI-test session counts too
    private var signedIn: Bool { model.onboarding.auth.isSignedIn }
    static let labels = ["help": "Help with", "relationship": "Relationship", "challenge": "Challenge", "tempo": "Tempo", "initiative": "Reach out", "presenceDescription": "Presence"]
    static let scales = ["challenge": ["Gentle", "Direct"], "tempo": ["Reflective", "Quick"], "initiative": ["Only when asked", "Anticipate"]]
    static func label(for key: String) -> String { labels[key] ?? key.capitalized }
    static func display(_ key: String, _ value: String) -> String {
        guard let ends = scales[key], let step = Int(value) else { return value }
        return "\(ends[0]) \(step + 1)/5 \(ends[1])"
    }
    private var styleText: String {
        guard let rows = model.setup.styleRows, !rows.isEmpty else { return model.setup.response }
        return ImportedStyle(rows: rows, partial: false, toConfirm: [], profile: "", source: "").displayText
    }
    private var voiceName: String {
        model.setup.deviceVoice.flatMap { AVSpeechSynthesisVoice(identifier: $0)?.name } ?? "Not selected"
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
                    if !styleText.isEmpty { Text(styleText).font(.custom("PretendardVariable-Regular", fixedSize: 14)).textSelection(.enabled) }
                    LabeledContent("Setup", value: model.setup.depth.title)
                    ForEach(model.setup.answers.keys.sorted(), id: \.self) { key in LabeledContent(Self.label(for: key), value: Self.display(key, model.setup.answers[key] ?? "")) }
                }
                if signedIn {
                    // F1-L8: sign out and in-app account deletion (App Review 5.1.1(v))
                    Section("Account") {
                        Button("Sign out") { signOut() }.disabled(working).accessibilityIdentifier("signOut")
                        Button(working ? "Deleting…" : "Delete account", role: .destructive) { confirmDelete = true }.disabled(working).accessibilityIdentifier("deleteAccount")
                    }
                }
                Section {
                    Link("Privacy Policy", destination: URL(string: "https://bagel-labs-beni.github.io/genita-legal/privacy/")!)
                    Link("Terms", destination: URL(string: "https://bagel-labs-beni.github.io/genita-legal/terms/")!)
                }
            }.navigationTitle("Settings")
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
