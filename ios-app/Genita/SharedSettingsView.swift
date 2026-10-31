import SwiftUI

struct SettingsView: View {
    @Bindable var model: AppState
    @Environment(\.dismiss) private var dismiss
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
                Section { Text("Local hackathon demo · Account sign-in, Muse Spark and live conversation are not connected yet.").font(.footnote).foregroundStyle(.secondary) }
            }.navigationTitle("Settings")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        #if os(iOS)
        .presentationDetents([.large])
        #else
        .frame(width: 390, height: 600)
        #endif
    }
}
