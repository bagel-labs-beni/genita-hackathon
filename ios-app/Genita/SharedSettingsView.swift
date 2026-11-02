import SwiftUI

struct SettingsView: View {
    @Bindable var model: AppState
    @Environment(\.dismiss) private var dismiss
    /// M02-D: delete confirmation; M02: account actions only when signed in.
    @State private var confirmDelete = false
    @State private var working = false
    @State private var accountError: String?
    private var signedIn: Bool { GenitaAuthClient().isSignedIn }
    static let labels = ["help": "Help with", "relationship": "Relationship", "challenge": "Challenge", "tempo": "Tempo", "initiative": "Reach out", "presenceDescription": "Presence"]
    static let scales = ["challenge": ["Gentle", "Direct"], "tempo": ["Reflective", "Quick"], "initiative": ["Only when asked", "Anticipate"]]
    static func label(for key: String) -> String { labels[key] ?? key.capitalized }
    static func display(_ key: String, _ value: String) -> String {
        guard let ends = scales[key], let step = Int(value) else { return value }
        return "\(ends[0]) \(step + 1)/5 \(ends[1])"
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("Profile") { TextField("Name", text: $model.setup.name) }
                Section("Your preferences") {
                    Text(model.setup.response).font(.custom("PretendardVariable-Regular", fixedSize: 14)).textSelection(.enabled)
                    LabeledContent("Setup", value: model.setup.depth.title)
                    LabeledContent("Voice", value: model.setup.voice.map { "Mira \($0 + 1)" } ?? "Not selected")
                    ForEach(model.setup.answers.keys.sorted(), id: \.self) { key in LabeledContent(Self.label(for: key), value: Self.display(key, model.setup.answers[key] ?? "")) }
                }
                if signedIn {
                    // F1-L8: sign out and in-app account deletion (App Review 5.1.1(v))
                    Section("Account") {
                        Button("Sign out") { signOut() }.disabled(working)
                        Button(working ? "Deleting…" : "Delete account", role: .destructive) { confirmDelete = true }.disabled(working)
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
            await GenitaAuthClient().logout()
            dismiss()
            model.signedOut()
        }
    }
    private func deleteAccount() {
        working = true
        Task { @MainActor in
            defer { working = false }
            do {
                _ = try await GenitaAuthClient().deleteAccount()
                dismiss()
                model.accountDeleted()
            } catch {
                accountError = "Try again in a moment. Nothing was deleted."
            }
        }
    }
}
