import SwiftUI
import AVFoundation

/// M02 Settings (iPhone + Mac). Hackathon build: no "What I keep" row (ST-1's toggles were only for the
/// cut Us photo / seen memory; general memory stays on), Privacy · Terms (D16), Sign out, Delete account.
struct SettingsView: View {
    @Bindable var model: AppState
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var confirmDelete = false
    @State private var working = false
    @State private var failed = false
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
                Section {
                    Button("Privacy Policy") { if let u = URL(string: "https://thebeni.ai/genita/privacy") { openURL(u) } }
                    Button("Terms") { if let u = URL(string: "https://thebeni.ai/genita/terms") { openURL(u) } }
                }
                Section {
                    // M02: sign out without a confirm; delete asks once (M02-D) and says it's done (M02-X)
                    Button("Sign out") { signOut() }.disabled(working).accessibilityIdentifier("signOut")
                    Button("Delete account", role: .destructive) { confirmDelete = true }.disabled(working).accessibilityIdentifier("deleteAccount")
                }
            }.navigationTitle("Settings")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .confirmationDialog("Delete your account?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete account", role: .destructive) { deleteAccount() }
                Button("Cancel", role: .cancel) {}
            } message: { Text("Your companion, conversations and memories are deleted. This can't be undone.") }
            .alert("Couldn’t do that. Try again.", isPresented: $failed) { Button("OK", role: .cancel) {} }
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
            await model.onboarding.auth.logout()
            working = false
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
                model.setup = SavedSetup()
                model.signedOut()
            } catch { failed = true }
        }
    }
}
