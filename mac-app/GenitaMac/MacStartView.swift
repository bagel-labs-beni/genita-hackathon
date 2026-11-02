import SwiftUI
import AppKit

/// The Mac's first window (ships only Figma screens — Chelsea 11/3, DMG 101 opened the old dev window):
/// signed out → MAC-1 (86:2), signed in without consent → CS01, otherwise the MAC-2/3/4 home (87:2 / 88:2 / 89:2,
/// the P01 pairing code sits in MAC-3). While the account is first checked the window stays empty — no screen
/// flashes before the right one.
struct MacStartView: View {
    @ObservedObject private var call = MacCall.shared

    var body: some View {
        Group {
            switch call.account {
            case .checking: MacLaunchBlank()
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

/// The first moment after launch while `/me` answers: the window's own background, nothing else.
struct MacLaunchBlank: View {
    var body: some View {
        MacSheetInk.sheet.frame(width: 420, height: 296).accessibilityLabel("Genita").accessibilityIdentifier("macLaunch")
    }
}

/// MAC-1 · Mac, signed out (Figma 86:2): title, one line, Continue with Apple (ink), the second way in as the
/// white button, the browser/terms line, Terms · Privacy Policy. Figma's second button is Google, which the
/// server doesn't offer; it is Continue with email (#208) in the same white style. Judge access (D41) is the
/// small link under it.
struct MacSignInView: View {
    @ObservedObject private var call = MacCall.shared
    @State private var judge = false
    /// A02-M Continue with email (#208)
    @State private var email = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Genita").font(MacSheetInk.serif(28)).tracking(-0.28).foregroundStyle(MacSheetInk.ink).frame(height: 34, alignment: .leading)
                .accessibilityAddTraits(.isHeader)
            Text("Sign in with the account you use on your iPhone.")
                .font(MacSheetInk.sans(15)).foregroundStyle(MacSheetInk.ink).frame(height: 22, alignment: .leading)
            Button { call.signInWithApple() } label: {
                ZStack {
                    if call.account == .signingIn { ProgressView().controlSize(.small).tint(MacSheetInk.onInk) }
                    else { Text("Continue with Apple") }
                }.font(MacSheetInk.sans(16, .medium)).foregroundStyle(MacSheetInk.onInk)
                    .frame(maxWidth: .infinity).frame(height: 50).background(MacSheetInk.ink, in: RoundedRectangle(cornerRadius: 12))
            }.buttonStyle(.plain).disabled(call.account == .signingIn).accessibilityIdentifier("macSignIn")
            Button { email = true } label: {
                Text("Continue with email").font(MacSheetInk.sans(16, .medium)).foregroundStyle(MacSheetInk.ink)
                    .frame(maxWidth: .infinity).frame(height: 50).background(Color.white, in: RoundedRectangle(cornerRadius: 12))
            }.buttonStyle(.plain).disabled(call.account == .signingIn).accessibilityIdentifier("macContinueWithEmail")
            Text(call.account == .signingIn ? "Finish signing in in the browser window that opened."
                 : call.signInMessage ?? "Opens your browser. By continuing, you agree to our Terms and Privacy Policy.")
                .font(MacSheetInk.sans(14)).foregroundStyle(MacSheetInk.mute).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
                .frame(width: 356, alignment: .leading)
            HStack(spacing: 16) {
                MacLegalLinks()
                Spacer(minLength: 0)
                Button("Judge access") { judge = true }.buttonStyle(.plain).foregroundStyle(MacSheetInk.mute).accessibilityIdentifier("macJudgeAccess")
            }.font(MacSheetInk.sans(14)).foregroundStyle(MacSheetInk.ink).underline().frame(height: 44)
        }
        .padding(.horizontal, 32).padding(.top, 32).padding(.bottom, 28).frame(width: 420, alignment: .topLeading)
        .background(MacSheetInk.sheet)
        .sheet(isPresented: $judge) { MacJudgeCodeSheet() }
        .sheet(isPresented: $email) { MacEmailSheet() }
    }
}

/// A02-M · Continue with email (NEW · design check, no Figma frame): the iPhone sheet's two steps in the A02-J
/// Mac sheet's type, ink, field and buttons. Address → Send code → 6-digit code → signed in (CS01 for a new account).
struct MacEmailSheet: View {
    enum Step { case address, code }
    @Environment(\.dismiss) private var dismiss
    @State private var step: Step
    @State private var email: String
    /// the address the code went to (verify uses this, not whatever the field holds now)
    @State private var sentTo: String
    @State private var code = ""
    @State private var sending = false
    @State private var message: String?
    @State private var resendAt = Date.distantPast
    @State private var now = Date()
    @FocusState private var focused: Bool
    private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    /// non-default `step` / `email` only for the review renders (watch-shots harness)
    init(step: Step = .address, email: String = "", message: String? = nil) {
        _step = State(initialValue: step)
        _email = State(initialValue: email)
        _sentTo = State(initialValue: email)
        _message = State(initialValue: message)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(step == .address ? "Continue with email" : "Check your email").font(MacSheetInk.serif(28)).foregroundStyle(MacSheetInk.ink).accessibilityAddTraits(.isHeader)
            Text(step == .address ? "We’ll send a 6-digit code to sign you in. No Apple ID needed." : "Enter the 6-digit code we sent to \(sentTo).")
                .font(MacSheetInk.sans(16)).foregroundStyle(MacSheetInk.mute).padding(.top, 12).fixedSize(horizontal: false, vertical: true)
            Group {
                if step == .address {
                    TextField("Email address", text: $email).textContentType(.emailAddress).accessibilityIdentifier("macEmailField")
                } else {
                    TextField("6-digit code", text: $code).textContentType(.oneTimeCode)
                        .onChange(of: code) { _, v in
                            let digits = String(v.filter(\.isNumber).prefix(6))
                            if digits != v { code = digits }
                            if digits.count == 6 { verify() }
                        }
                        .accessibilityIdentifier("macEmailCodeField")
                }
            }
            .textFieldStyle(.plain).autocorrectionDisabled().focused($focused).disabled(sending)
            .font(MacSheetInk.sans(16)).foregroundStyle(MacSheetInk.ink)
            .padding(.horizontal, 16).frame(height: 50)
            .background(MacSheetInk.chip, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(message == nil ? .clear : MacSheetInk.ink, lineWidth: 1))
            .padding(.top, 24).onSubmit { step == .address ? sendCode() : verify() }
            if let message {
                Text(message).font(MacSheetInk.sans(14, .medium)).foregroundStyle(MacSheetInk.ink).padding(.top, 12)
                    .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("macEmailError")
            }
            Button { step == .address ? sendCode() : verify() } label: {
                ZStack {
                    if sending { ProgressView().controlSize(.small).tint(MacSheetInk.onInk) } else { Text(step == .address ? "Send code" : "Continue") }
                }.font(MacSheetInk.sans(16, .medium)).foregroundStyle(MacSheetInk.onInk)
                    .frame(maxWidth: .infinity).frame(height: 50)
                    .background(MacSheetInk.ink, in: RoundedRectangle(cornerRadius: 12))
            }.buttonStyle(.plain).disabled(sending || !canContinue).padding(.top, 24)
                .keyboardShortcut(.defaultAction).accessibilityIdentifier("macEmailContinue")
            if step == .code {
                HStack {
                    Button("Use a different email") { step = .address; code = ""; message = nil; focused = true }
                    Spacer()
                    Button(resendLeft > 0 ? "Resend in \(resendLeft)s" : "Resend code") { sendCode() }.disabled(sending || resendLeft > 0)
                }
                .buttonStyle(.plain).font(MacSheetInk.sans(14, .medium)).foregroundStyle(MacSheetInk.ink).frame(height: 44).padding(.top, 4)
            }
            Button("Cancel") { dismiss() }
                .buttonStyle(.plain).font(MacSheetInk.sans(16, .medium)).foregroundStyle(MacSheetInk.ink)
                .frame(maxWidth: .infinity).frame(height: 50).disabled(sending).keyboardShortcut(.cancelAction)
        }
        .padding(24).frame(width: 400)
        .background(MacSheetInk.sheet)
        .onAppear { focused = true }
        .onReceive(tick) { now = $0 }
    }

    private var canContinue: Bool { step == .address ? GenitaAuthClient.looksLikeEmail(email) : code.count == 6 }
    private var resendLeft: Int { max(0, Int(resendAt.timeIntervalSince(now).rounded(.up))) }

    private func sendCode() {
        let address = step == .code ? sentTo : email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sending, GenitaAuthClient.looksLikeEmail(address) else { return }
        sending = true
        message = nil
        Task { @MainActor in
            defer { sending = false }
            let r = await MacCall.shared.startEmailSignIn(address)
            if let m = r.message { message = m; return }
            sentTo = address
            resendAt = Date().addingTimeInterval(TimeInterval(r.resendAfterSec)); now = Date()
            code = ""
            step = .code
            focused = true
        }
    }

    private func verify() {
        guard !sending, code.count == 6 else { return }
        sending = true
        message = nil
        Task { @MainActor in
            defer { sending = false }
            if let failure = await MacCall.shared.signInWithEmail(sentTo, code: code) { message = failure; code = "" } else { dismiss() }
        }
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
                .textFieldStyle(.plain).autocorrectionDisabled().focused($focused).disabled(sending)
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
        // PRD v12 9.2 / D16: no "Never used to train AI models" line (hackathon-credit inputs may be used by Meta)
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Before we start.").font(MacSheetInk.serif(28)).tracking(-0.28).foregroundStyle(MacSheetInk.ink).frame(height: 34, alignment: .leading)
                .accessibilityAddTraits(.isHeader)
            Text("Genita uses AI services to make your companion and talk with you. Here’s what goes to them, and when.")
                .font(MacSheetInk.sans(15)).foregroundStyle(MacSheetInk.ink).lineSpacing(3).padding(.top, 12).fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 16) {
                ForEach(rows, id: \.0) { row in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(row.0).font(MacSheetInk.sans(16, .medium)).foregroundStyle(MacSheetInk.ink)
                        Text(row.1).font(MacSheetInk.sans(14)).foregroundStyle(MacSheetInk.mute).fixedSize(horizontal: false, vertical: true)
                    }.accessibilityElement(children: .combine)
                }
            }.padding(.top, 24)
            HStack(spacing: 16) { MacLegalLinks() }.font(MacSheetInk.sans(14)).foregroundStyle(MacSheetInk.ink).underline().padding(.top, 16).frame(minHeight: 44)
            Button { agree() } label: {
                ZStack {
                    if sending { ProgressView().controlSize(.small).tint(MacSheetInk.onInk) } else { Text("Agree and continue") }
                }.font(MacSheetInk.sans(16, .medium)).foregroundStyle(MacSheetInk.onInk)
                    .frame(maxWidth: .infinity).frame(height: 50).background(MacSheetInk.ink, in: RoundedRectangle(cornerRadius: 12))
            }.buttonStyle(.plain).disabled(sending).padding(.top, 12).accessibilityIdentifier("macConsentAgree")
            Button("Not now") { call.signOut() }
                .buttonStyle(.plain).font(MacSheetInk.sans(16, .medium)).foregroundStyle(MacSheetInk.ink)
                .frame(maxWidth: .infinity).frame(height: 50).disabled(sending).accessibilityIdentifier("macConsentNotNow")
        }
        // same window system as MAC-1~4: 32 sides and top, 28 bottom
        .padding(.horizontal, 32).padding(.top, 32).padding(.bottom, 20).frame(width: 420, alignment: .topLeading)
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

/// The call menu's Setting on the Mac: the account and the legal pages, in the Mac sheet's type and ink.
/// (The iPhone's preference form needs the iPhone's onboarding data, which the Mac doesn't have.)
struct MacSettingsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var call = MacCall.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Settings").font(MacSheetInk.serif(28)).tracking(-0.28).foregroundStyle(MacSheetInk.ink).frame(height: 34, alignment: .leading)
                .accessibilityAddTraits(.isHeader)
            if let name = call.companionName {
                Text("\(name) is set up on your iPhone. Change their name, voice and setup there.")
                    .font(MacSheetInk.sans(15)).foregroundStyle(MacSheetInk.ink).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 16) { MacLegalLinks() }.font(MacSheetInk.sans(14)).foregroundStyle(MacSheetInk.ink).underline().frame(height: 44)
            Button { dismiss(); call.signOut() } label: {
                Text("Sign out").font(MacSheetInk.sans(16, .medium)).foregroundStyle(MacSheetInk.ink)
                    .frame(maxWidth: .infinity).frame(height: 50).background(Color.white, in: RoundedRectangle(cornerRadius: 12))
            }.buttonStyle(.plain).accessibilityIdentifier("macSettingsSignOut")
            Button { dismiss() } label: {
                Text("Done").font(MacSheetInk.sans(16, .medium)).foregroundStyle(MacSheetInk.onInk)
                    .frame(maxWidth: .infinity).frame(height: 50).background(MacSheetInk.ink, in: RoundedRectangle(cornerRadius: 12))
            }.buttonStyle(.plain).keyboardShortcut(.defaultAction).accessibilityIdentifier("macSettingsDone")
        }
        .padding(.horizontal, 32).padding(.top, 32).padding(.bottom, 28).frame(width: 420, alignment: .topLeading)
        .background(MacSheetInk.sheet)
    }
}

/// Terms · Privacy Policy in the default browser (plain buttons, so the review renders draw them too).
struct MacLegalLinks: View {
    var body: some View {
        Button("Terms") { open("https://bagel-labs-beni.github.io/genita-legal/terms/") }.buttonStyle(.plain).accessibilityAddTraits(.isLink)
        Button("Privacy Policy") { open("https://bagel-labs-beni.github.io/genita-legal/privacy/") }.buttonStyle(.plain).accessibilityAddTraits(.isLink)
    }
    private func open(_ s: String) { if let u = URL(string: s) { NSWorkspace.shared.open(u) } }
}
