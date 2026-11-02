import SwiftUI

/// CS01 · AI data consent (design-flow r01 board §1, "Before we start."). Shown once after the first
/// sign-in, and whenever the server closes the call with 4403 (signed in, no AI-data consent yet).
/// Agree → POST /me/consent → back to where the user was going. Not now → sign out → A02.
struct ConsentView: View {
    @Bindable var model: AppState
    @State private var sending = false
    @State private var failed = false
    @State private var legal: String?

    private let rows: [(String, String)] = [
        ("What you say and type", "To answer you. Voice is turned into text first."),
        ("The image you choose", "To make their face, voice and video."),
        ("Camera and screen, only while on", "Nothing is seen until you turn it on. Video isn’t kept."),
        ("Never used to train AI models", "Delete your account any time in Settings."),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Before we start.").font(TypeStyle.title(35)).foregroundStyle(CallInk.ink).padding(.top, 54)
                .accessibilityAddTraits(.isHeader)
            Text("Genita uses AI services to make your companion and talk with you. Here’s what goes to them, and when.")
                .font(TypeStyle.body(16)).foregroundStyle(CallInk.mute).padding(.top, 16).fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 20) {
                ForEach(rows, id: \.0) { row in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(row.0).font(TypeStyle.body(16, .medium)).foregroundStyle(CallInk.ink)
                        Text(row.1).font(TypeStyle.body(14)).foregroundStyle(CallInk.mute).fixedSize(horizontal: false, vertical: true)
                    }.accessibilityElement(children: .combine)
                }
            }.padding(.top, 32)
            HStack(spacing: 16) {
                Button("Terms") { legal = "Terms" }
                Button("Privacy Policy") { legal = "Privacy Policy" }
            }.font(TypeStyle.body(14, .medium)).foregroundStyle(CallInk.ink).underline().padding(.top, 24).frame(minHeight: 44)
            Spacer(minLength: 24)
            Button { agree() } label: {
                ZStack {
                    if sending { ProgressView().tint(CallInk.onInk) } else { Text("Agree and continue") }
                }.font(TypeStyle.body(16, .medium)).foregroundStyle(CallInk.onInk)
                    .frame(maxWidth: .infinity).frame(height: 50).background(CallInk.ink, in: RoundedRectangle(cornerRadius: 12))
            }.buttonStyle(.plain).disabled(sending).accessibilityIdentifier("consentAgree")
            Button("Not now") { notNow() }
                .font(TypeStyle.body(16, .medium)).foregroundStyle(CallInk.ink).frame(maxWidth: .infinity).frame(height: 50)
                .disabled(sending).accessibilityIdentifier("consentNotNow")
                .padding(.bottom, 8)
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(CallInk.sheet.ignoresSafeArea())
        .alert("Couldn’t save that. Try again.", isPresented: $failed) { Button("OK", role: .cancel) {} }
        .alert(legal ?? "", isPresented: Binding(get: { legal != nil }, set: { if !$0 { legal = nil } })) { Button("OK") { legal = nil } }
    }

    private func agree() {
        sending = true
        Task { @MainActor in
            defer { sending = false }
            do {
                try await GenitaAuthClient().consent()
                model.consentAccepted()
            } catch {
                failed = true
            }
        }
    }

    private func notNow() {
        Task { @MainActor in
            await GenitaAuthClient().logout()
            model.returnTo(.signIn)
        }
    }
}
