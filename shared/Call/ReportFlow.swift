import SwiftUI

/// RP-1 (D37): the system action sheet (reason) → a one-line note → POST /me/report → "Thanks, noted".
/// No new design: confirmation dialog + alert with a text field, on iPhone and Mac.
struct ReportFlow: ViewModifier {
    @Binding var isPresented: Bool
    let surface: String
    let auth: GenitaAuthClient
    /// what is being reported (the companion's last reply), read when the report is sent
    var context: () -> String? = { nil }
    @State private var reason: GenitaReportReason?
    @State private var noteOpen = false
    @State private var note = ""
    @State private var result: String?

    func body(content: Content) -> some View {
        content
            .confirmationDialog("Report", isPresented: $isPresented, titleVisibility: .visible) {
                ForEach(GenitaReportReason.allCases, id: \.self) { r in
                    Button(r.title) { reason = r; note = ""; noteOpen = true }
                }
                Button("Cancel", role: .cancel) {}
            } message: { Text("What went wrong?") }
            .alert("Add a note", isPresented: $noteOpen) {
                TextField("Optional", text: $note).accessibilityIdentifier("reportNote")
                Button("Send") { send() }.accessibilityIdentifier("reportSend")
                Button("Cancel", role: .cancel) { reason = nil }
            } message: { Text("One line is enough.") }
            .alert(result ?? "", isPresented: Binding(get: { result != nil }, set: { if !$0 { result = nil } })) {
                Button("OK", role: .cancel) { result = nil }
            }
    }

    private func send() {
        guard let reason else { return }
        let text = context(), note = note
        Task { @MainActor in
            do {
                try await auth.report(reason, note: note, surface: surface, text: text)
                result = "Thanks, noted"
            } catch {
                result = "Couldn't send that. Try again."
            }
            self.reason = nil
        }
    }
}

extension View {
    func reportFlow(isPresented: Binding<Bool>, surface: String, auth: GenitaAuthClient, context: @escaping () -> String? = { nil }) -> some View {
        modifier(ReportFlow(isPresented: isPresented, surface: surface, auth: auth, context: context))
    }
}

extension CallController {
    /// the companion's last reply in this call (what a call report is usually about)
    var lastReplyText: String? { historySnapshot.last { $0.role == .assistant }?.text }
}
