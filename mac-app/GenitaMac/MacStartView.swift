import SwiftUI

/// The Mac's first window. Signed out → A02 (Sign in with Apple on the web, or the small Judge access link →
/// A02-J code sheet, D41). Signed in without consent → CS01. Otherwise Dyno's control window, unchanged.
/// Same type and ink as the iPhone's A02 / CS01 / A02-J (no new design).
struct MacStartView: View {
    @ObservedObject private var call = MacCall.shared

    var body: some View {
        Group {
            switch call.account {
            case .signedOut, .signingIn: MacSignInView()
            case .needsConsent: MacConsentView()
            default: MacHandoffControls()
            }
        }
        .task {
            _ = MacHandoff.shared // the pairing link and presence start at launch, signed in or not (as before)
            if call.account == .checking { await call.refresh() }
        }
    }
}

/// A02 on the Mac.
struct MacSignInView: View {
    @ObservedObject private var call = MacCall.shared
    @State private var judge = false

    var body: some View {
        VStack(spacing: 0) {
            Text("Genita").font(MacSheetInk.serif(40)).foregroundStyle(MacSheetInk.ink).padding(.top, 44)
                .accessibilityAddTraits(.isHeader)
            Text("Sign in with the account you use on your iPhone.")
                .font(MacSheetInk.sans(16)).foregroundStyle(MacSheetInk.mute).multilineTextAlignment(.center).padding(.top, 12)
            Button { call.signInWithApple() } label: {
                ZStack {
                    if call.account == .signingIn { ProgressView().controlSize(.small).tint(MacSheetInk.onInk) }
                    else { Label("Sign in with Apple", systemImage: "apple.logo") }
                }.font(MacSheetInk.sans(16, .medium)).foregroundStyle(MacSheetInk.onInk)
                    .frame(width: 320, height: 50).background(MacSheetInk.ink, in: RoundedRectangle(cornerRadius: 12))
            }.buttonStyle(.plain).disabled(call.account == .signingIn).padding(.top, 32).accessibilityIdentifier("macSignIn")
            if call.account == .signingIn {
                Text("Finish signing in in the window that opened.").font(MacSheetInk.sans(14)).foregroundStyle(MacSheetInk.mute).padding(.top, 10)
            }
            Button("Judge access") { judge = true }
                .buttonStyle(.plain).font(MacSheetInk.sans(14, .medium)).foregroundStyle(MacSheetInk.mute).underline()
                .frame(minHeight: 44).padding(.top, 8).accessibilityIdentifier("macJudgeAccess")
            HStack(spacing: 16) {
                Link("Terms", destination: URL(string: "https://bagel-labs-beni.github.io/genita-legal/terms/")!)
                Link("Privacy Policy", destination: URL(string: "https://bagel-labs-beni.github.io/genita-legal/privacy/")!)
            }.font(MacSheetInk.sans(13)).foregroundStyle(MacSheetInk.mute).padding(.top, 20).padding(.bottom, 28)
        }
        .frame(width: 420)
        .background(MacSheetInk.sheet)
        .sheet(isPresented: $judge) { MacJudgeCodeSheet() }
    }
}

/// A02-J · the code sheet (consent sheet's type, ink and buttons).
struct MacJudgeCodeSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @State private var sending = false
    @State private var message: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Judge access").font(MacSheetInk.serif(28)).foregroundStyle(MacSheetInk.ink).accessibilityAddTraits(.isHeader)
            Text("Enter the code from the submission form. No Apple ID needed.")
                .font(MacSheetInk.sans(16)).foregroundStyle(MacSheetInk.mute).padding(.top, 12).fixedSize(horizontal: false, vertical: true)
            TextField("Access code", text: $code)
                .textFieldStyle(.plain).autocorrectionDisabled().focused($focused)
                .font(MacSheetInk.sans(16)).foregroundStyle(MacSheetInk.ink)
                .padding(.horizontal, 16).frame(height: 50)
                .background(MacSheetInk.chip, in: RoundedRectangle(cornerRadius: 12))
                .padding(.top, 24).onSubmit { submit() }
                .accessibilityIdentifier("macJudgeCodeField")
            if let message {
                Text(message).font(MacSheetInk.sans(14, .medium)).foregroundStyle(MacSheetInk.ink).padding(.top, 12)
                    .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("macJudgeCodeError")
            }
            Button { submit() } label: {
                ZStack {
                    if sending { ProgressView().controlSize(.small).tint(MacSheetInk.onInk) } else { Text("Continue") }
                }.font(MacSheetInk.sans(16, .medium)).foregroundStyle(MacSheetInk.onInk)
                    .frame(maxWidth: .infinity).frame(height: 50).background(MacSheetInk.ink, in: RoundedRectangle(cornerRadius: 12))
            }.buttonStyle(.plain).disabled(sending || code.trimmingCharacters(in: .whitespaces).isEmpty).padding(.top, 24)
                .keyboardShortcut(.defaultAction).accessibilityIdentifier("macJudgeCodeContinue")
            Button("Cancel") { dismiss() }
                .buttonStyle(.plain).font(MacSheetInk.sans(16, .medium)).foregroundStyle(MacSheetInk.ink)
                .frame(maxWidth: .infinity).frame(height: 50).disabled(sending).keyboardShortcut(.cancelAction)
        }
        .padding(24).frame(width: 400)
        .background(MacSheetInk.sheet)
        .onAppear { focused = true }
    }

    private func submit() {
        guard !sending, !code.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        sending = true
        message = nil
        Task { @MainActor in
            defer { sending = false }
            if let failure = await MacCall.shared.signInWithJudgeCode(code) { message = failure } else { dismiss() }
        }
    }
}

/// CS01 on the Mac: the iPhone's copy and rows. Not now = sign out (back to A02).
struct MacConsentView: View {
    @ObservedObject private var call = MacCall.shared
    @State private var sending = false
    @State private var failed = false

    private let rows: [(String, String)] = [
        ("What you say and type", "To answer you. Voice is turned into text first."),
        ("The image you choose", "To make their face, voice and video."),
        ("Camera and screen, only while on", "Nothing is seen until you turn it on. Video isn’t kept."),
        ("Never used to train AI models", "Delete your account any time in Settings."),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Before we start.").font(MacSheetInk.serif(35)).foregroundStyle(MacSheetInk.ink).padding(.top, 36)
                .accessibilityAddTraits(.isHeader)
            Text("Genita uses AI services to make your companion and talk with you. Here’s what goes to them, and when.")
                .font(MacSheetInk.sans(16)).foregroundStyle(MacSheetInk.mute).padding(.top, 16).fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 20) {
                ForEach(rows, id: \.0) { row in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(row.0).font(MacSheetInk.sans(16, .medium)).foregroundStyle(MacSheetInk.ink)
                        Text(row.1).font(MacSheetInk.sans(14)).foregroundStyle(MacSheetInk.mute).fixedSize(horizontal: false, vertical: true)
                    }.accessibilityElement(children: .combine)
                }
            }.padding(.top, 32)
            HStack(spacing: 16) {
                Link("Terms", destination: URL(string: "https://bagel-labs-beni.github.io/genita-legal/terms/")!)
                Link("Privacy Policy", destination: URL(string: "https://bagel-labs-beni.github.io/genita-legal/privacy/")!)
            }.font(MacSheetInk.sans(14, .medium)).foregroundStyle(MacSheetInk.ink).underline().padding(.top, 24).frame(minHeight: 44)
            Button { agree() } label: {
                ZStack {
                    if sending { ProgressView().controlSize(.small).tint(MacSheetInk.onInk) } else { Text("Agree and continue") }
                }.font(MacSheetInk.sans(16, .medium)).foregroundStyle(MacSheetInk.onInk)
                    .frame(maxWidth: .infinity).frame(height: 50).background(MacSheetInk.ink, in: RoundedRectangle(cornerRadius: 12))
            }.buttonStyle(.plain).disabled(sending).padding(.top, 24).accessibilityIdentifier("macConsentAgree")
            Button("Not now") { call.signOut() }
                .buttonStyle(.plain).font(MacSheetInk.sans(16, .medium)).foregroundStyle(MacSheetInk.ink)
                .frame(maxWidth: .infinity).frame(height: 50).disabled(sending).padding(.bottom, 20).accessibilityIdentifier("macConsentNotNow")
        }
        .padding(.horizontal, 28).frame(width: 420)
        .background(MacSheetInk.sheet)
        .alert("Couldn’t save that. Try again.", isPresented: $failed) { Button("OK", role: .cancel) {} }
    }

    private func agree() {
        guard !sending else { return }
        sending = true
        Task { @MainActor in
            defer { sending = false }
            if !(await call.consent()) { failed = true }
        }
    }
}
