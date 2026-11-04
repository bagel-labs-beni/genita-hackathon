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
            if MacDesignV2.enabled {
                // MAC-0 "A · Eclipse" (11/4): the launch runs over the first screen and hands off to it
                MacLaunchHost(checking: call.account == .checking, signedIn: ![.signedOut, .signingIn].contains(call.account)) { screen }
            } else if call.account == .checking {
                MacLaunchBlank()
            } else {
                screen
            }
        }
        .task {
            _ = MacHandoff.shared // Connections start after /me verifies the signed-in account.
            await call.refreshAtLaunch()
        }
    }
    @ViewBuilder private var screen: some View {
        switch call.account {
        case .checking: MacLaunchBlank()
        case .signedOut, .signingIn: MacSignInView()
        case .needsConsent: MacConsentView()
        default: MacHandoffControls()
        }
    }
}

/// The first moment after launch while `/me` answers: the window's own background, nothing else.
struct MacLaunchBlank: View {
    var body: some View {
        if MacDesignV2.enabled { MacLaunchV2() } else {
            MacSheetInk.sheet.frame(width: 420, height: 296).accessibilityLabel("Genita").accessibilityIdentifier("macLaunch")
        }
    }
}

/// MAC-0 v2: the A′ "Corona calm" resting frame at the Mac window's size (launch colour #070707, white disc
/// in the mark's counter with the corona only behind it, the original mark and wordmark). The animated splash
/// is #191's `genitaSplash`; this is what shows while /me answers instead of an empty white window.
struct MacLaunchV2: View {
    var body: some View {
        ZStack {
            Color(white: 7.0 / 255)
            RadialGradient(colors: [Color(red: 1, green: 250.0 / 255, blue: 240.0 / 255).opacity(0.55), Color(red: 1, green: 240.0 / 255, blue: 220.0 / 255).opacity(0.18),
                                    Color(red: 1, green: 240.0 / 255, blue: 220.0 / 255).opacity(0.05), .clear], center: .center, startRadius: 0, endRadius: 110)
                .frame(width: 220, height: 220).position(x: 210, y: 104)
            Circle().fill(Color.white).frame(width: 34, height: 34)
                .overlay(Circle().strokeBorder(Color(red: 250.0 / 255, green: 238.0 / 255, blue: 221.0 / 255), lineWidth: 1))
                .shadow(color: Color(red: 1, green: 236.0 / 255, blue: 210.0 / 255).opacity(0.9), radius: 11)
                .position(x: 224, y: 104)
            resourceImage("brandmark").renderingMode(.template).resizable().foregroundStyle(MacSheetInk.ink)
                .frame(width: 108, height: 50.4).rotationEffect(.degrees(-14)).position(x: 210, y: 104)
            resourceImage("logo").renderingMode(.template).resizable().foregroundStyle(Color(red: 243.0 / 255, green: 234.0 / 255, blue: 223.0 / 255))
                .frame(width: 72, height: 25.8).position(x: 210, y: 185)
        }
        .frame(width: 420, height: 296)
        .accessibilityElement().accessibilityLabel("Genita").accessibilityIdentifier("macLaunch")
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
        if MacDesignV2.enabled { v2Body } else { v1Body }
    }

    /// MAC-1 v2 (Mac v2 r01): sentence title like every other window, one legal sentence with inline links,
    /// outlined second button, Judge access as a small mute link (D41).
    private var v2Body: some View {
        VStack(alignment: .leading, spacing: 0) {
            MacV2Title(text: "Sign in to Genita.")
            Text("Use the same account as on your iPhone.").font(MacSheetInk.sans(15)).foregroundStyle(MacSheetInk.ink)
                .frame(height: 22, alignment: .leading).padding(.top, 8)
            VStack(spacing: 12) {
                MacV2Button(label: "Continue with Apple", icon: Image(systemName: "apple.logo"), loading: call.account == .signingIn, id: "macSignIn") { call.signInWithApple() }
                MacV2Button(label: "Continue with email", style: .secondary, id: "macContinueWithEmail") { email = true }
            }.disabled(call.account == .signingIn).padding(.top, 24)
            if call.account == .signingIn || call.signInMessage != nil {
                Text(call.account == .signingIn ? "Finish signing in in the browser window that opened." : call.signInMessage ?? "")
                    .font(MacSheetInk.sans(13)).foregroundStyle(MacSheetInk.ink).lineSpacing(2).fixedSize(horizontal: false, vertical: true)
                    .frame(width: 356, alignment: .leading).padding(.top, 16).accessibilityIdentifier("macSignInMessage")
            }
            MacV2Legal().padding(.top, 16)
            Button("Judge access") { judge = true }.buttonStyle(.plain).font(MacSheetInk.sans(13)).foregroundStyle(MacSheetInk.mute).underline()
                .frame(height: 32).padding(.top, 2).accessibilityIdentifier("macJudgeAccess")
        }
        .padding(.horizontal, 32).padding(.top, 24).padding(.bottom, 22).frame(width: 420, alignment: .topLeading)
        .background(MacSheetInk.sheet)
        .sheet(isPresented: $judge) { MacJudgeCodeSheet() }
        .sheet(isPresented: $email) { MacEmailSheet() }
    }

    private var v1Body: some View {
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
    init(step: Step = .address, email: String = "", message: String? = nil, code: String = "") {
        _step = State(initialValue: step)
        _code = State(initialValue: code)
        _email = State(initialValue: email)
        _sentTo = State(initialValue: email)
        _message = State(initialValue: message)
    }

    var body: some View {
        if MacDesignV2.enabled { v2Body } else { v1Body }
    }

    /// MAC-1e / MAC-1c v2: the home window's title, outlined field, 50 pt buttons; the code is P01's six boxes.
    private var v2Body: some View {
        VStack(alignment: .leading, spacing: 0) {
            MacV2Title(text: step == .address ? "Continue with email." : "Check your email.")
            if step == .address {
                Text("We’ll send a six-digit code. No password.")
                    .font(MacSheetInk.sans(15)).foregroundStyle(MacSheetInk.ink).lineLimit(1).padding(.top, 8)
            } else {
                // QA 171: one middle-truncated line cut the sentence ("…we sent t…ae2207@…"). The address gets its own
                // line; only a very long address is shortened, in its middle.
                VStack(alignment: .leading, spacing: 2) {
                    Text("Enter the code we sent to")
                    Text(verbatim: sentTo + ".").lineLimit(1).truncationMode(.middle)
                }
                .font(MacSheetInk.sans(15)).foregroundStyle(MacSheetInk.ink).padding(.top, 8)
                .accessibilityElement(children: .combine)
            }
            if step == .address && MacDesignV2.reviewRender {
                // review renders: ImageRenderer can't draw the AppKit field, so draw its focused empty look
                Text(verbatim: "you@example.com").font(MacSheetInk.sans(16)).foregroundStyle(MacDesignV2.faint)
                    .padding(.horizontal, 16).frame(maxWidth: .infinity, alignment: .leading).frame(height: 50)
                    .background(Color.white, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(MacSheetInk.ink, lineWidth: 1.5)).padding(.top, 24)
            } else if step == .address {
                TextField("you@example.com", text: $email).textContentType(.emailAddress)
                    .textFieldStyle(.plain).autocorrectionDisabled().focused($focused).disabled(sending)
                    .font(MacSheetInk.sans(16)).foregroundStyle(MacSheetInk.ink)
                    .padding(.horizontal, 16).frame(height: 50)
                    .background(Color.white, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(focused || message != nil ? MacSheetInk.ink : MacDesignV2.outline, lineWidth: focused || message != nil ? 1.5 : 1))
                    .onSubmit { sendCode() }.padding(.top, 24).accessibilityIdentifier("macEmailField")
                    .macASCIIOnlyInput(focused: focused)
            } else {
                MacV2CodeField(code: $code, disabled: sending, id: "macEmailCodeField") { verify() }.padding(.top, 20)
            }
            if let message {
                Text(message).font(MacSheetInk.sans(14, .medium)).foregroundStyle(MacSheetInk.ink).padding(.top, 12)
                    .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("macEmailError")
            }
            MacV2Button(label: step == .address ? "Send code" : "Continue", loading: sending, id: "macEmailContinue") { step == .address ? sendCode() : verify() }
                .disabled(sending || !canContinue).keyboardShortcut(.defaultAction).padding(.top, step == .address ? 12 : 24)
            if step == .code {
                HStack(spacing: 0) {
                    MacV2Button(label: resendLeft > 0 ? "Resend in \(resendLeft)s" : "Resend code", style: .text, id: "macEmailResend") { sendCode() }.disabled(sending || resendLeft > 0)
                    MacV2Button(label: "Use another email", style: .text, id: "macEmailOther") { step = .address; code = ""; message = nil; focused = true }
                }.frame(maxWidth: .infinity).padding(.top, 4)
                Button("") { dismiss() }.keyboardShortcut(.cancelAction).opacity(0).frame(width: 0, height: 0)
            } else {
                MacV2Button(label: "Cancel", style: .text, id: "macEmailCancel") { dismiss() }.disabled(sending).keyboardShortcut(.cancelAction)
                    .frame(maxWidth: .infinity).padding(.top, 4)
            }
        }
        .padding(.horizontal, 32).padding(.top, 28).padding(.bottom, 20).frame(width: 420, alignment: .topLeading)
        .background(MacSheetInk.sheet)
        .onAppear { focused = true }
        .onReceive(tick) { now = $0 }
    }

    private var v1Body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(step == .address ? "Continue with email" : "Check your email").font(MacSheetInk.serif(28)).foregroundStyle(MacSheetInk.ink).accessibilityAddTraits(.isHeader)
            Text(step == .address ? "We’ll send a 6-digit code to sign you in. No Apple\u{00A0}ID\u{00A0}needed." : "Enter the 6-digit code we sent to \(sentTo).")
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
            .macASCIIOnlyInput(focused: focused)
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
        // A02-J in the email sheet's Mac v2 look (it still had the old one: filled field, 16 pt mute body,
        // 24 pt sides, a grey disabled block — the two sign-in sheets didn't match)
        VStack(alignment: .leading, spacing: 0) {
            MacV2Title(text: "Judge access")
            Text("Enter the code from the submission form. No Apple\u{00A0}ID\u{00A0}needed.")
                .font(MacSheetInk.sans(15)).foregroundStyle(MacSheetInk.ink).lineSpacing(3).padding(.top, 8).fixedSize(horizontal: false, vertical: true)
            TextField("Access code", text: $code)
                .textFieldStyle(.plain).autocorrectionDisabled().focused($focused).disabled(sending)
                .font(MacSheetInk.sans(16)).foregroundStyle(MacSheetInk.ink)
                .padding(.horizontal, 16).frame(height: 50)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(focused || message != nil ? MacSheetInk.ink : MacDesignV2.outline, lineWidth: focused || message != nil ? 1.5 : 1))
                .padding(.top, 24).onSubmit { submit() }
                .accessibilityIdentifier("macJudgeCodeField")
                .macASCIIOnlyInput(focused: focused)
            if let message {
                Text(message).font(MacSheetInk.sans(14, .medium)).foregroundStyle(MacSheetInk.ink).padding(.top, 12)
                    .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("macJudgeCodeError")
            }
            MacV2Button(label: "Continue", loading: sending, id: "macJudgeCodeContinue") { submit() }
                .disabled(sending || code.trimmingCharacters(in: .whitespaces).isEmpty).keyboardShortcut(.defaultAction).padding(.top, 12)
            MacV2Button(label: "Cancel", style: .text, id: "macJudgeCodeCancel") { dismiss() }.disabled(sending).keyboardShortcut(.cancelAction)
                .frame(maxWidth: .infinity).padding(.top, 4)
        }
        .padding(.horizontal, 32).padding(.top, 28).padding(.bottom, 20).frame(width: 420, alignment: .topLeading)
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
        if MacDesignV2.enabled { v2Body } else { v1Body }
    }

    /// CS01-M v2: iPhone CS01 copy; rows 15/14 like every other list; the links fold into one legal sentence.
    private var v2Body: some View {
        VStack(alignment: .leading, spacing: 0) {
            MacV2Title(text: "Before we start.")
            Text("Genita uses AI services to make your companion and talk with you. Here’s what goes to them, and\u{00A0}when.")
                .font(MacSheetInk.sans(15)).foregroundStyle(MacSheetInk.ink).lineSpacing(4).padding(.top, 8).fixedSize(horizontal: false, vertical: true)
                .frame(width: 356, alignment: .leading)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(rows, id: \.0) { row in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.0).font(MacSheetInk.sans(15, .medium)).foregroundStyle(MacSheetInk.ink)
                        Text(row.1).font(MacSheetInk.sans(14)).foregroundStyle(MacSheetInk.mute).fixedSize(horizontal: false, vertical: true)
                    }.padding(.vertical, 8).accessibilityElement(children: .combine)
                }
            }.padding(.top, 20)
            MacV2Legal(prefix: "Read the ").padding(.top, 16)
            MacV2Button(label: "Agree and continue", loading: sending, id: "macConsentAgree") { agree() }.disabled(sending).padding(.top, 20)
            MacV2Button(label: "Not now", style: .text, id: "macConsentNotNow") { call.signOut() }.disabled(sending).frame(maxWidth: .infinity).padding(.top, 4)
        }
        .padding(.horizontal, 32).padding(.top, 24).padding(.bottom, 20).frame(width: 420, alignment: .topLeading)
        .background(MacSheetInk.sheet)
        .alert("Couldn’t save that. Try again.", isPresented: $failed) { Button("OK", role: .cancel) {} }
    }

    private var v1Body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Before we start.").font(MacSheetInk.serif(28)).tracking(-0.28).foregroundStyle(MacSheetInk.ink).frame(height: 34, alignment: .leading)
                .accessibilityAddTraits(.isHeader)
            Text("Genita uses AI services to make your companion and talk with you. Here’s what goes to them, and\u{00A0}when.")
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
    @ObservedObject private var loginItem = MacLoginItem.shared
    /// The call window is the phone's physical size (~330–360 pt on a MacBook), narrower than the 420 home window:
    /// a 420-wide sheet there was cut off on both sides (Mac QA 11/3). The call passes `compact`.
    var compact = false
    /// RP-1 (D37): Report on the Mac
    @State private var reportOpen = false

    var body: some View {
        Group { if MacDesignV2.enabled { v2Body } else { v1Body } }
            .reportFlow(isPresented: $reportOpen, surface: "mac", auth: call.auth) { CallController.shared.lastReplyText }
    }
    private var reportRow: some View {
        Button { reportOpen = true } label: {
            HStack {
                Text("Report a problem").font(MacSheetInk.sans(15)).foregroundStyle(MacSheetInk.ink)
                Spacer()
                Image(systemName: "flag").font(.system(size: 11, weight: .medium)).foregroundStyle(MacSheetInk.mute)
            }.padding(.horizontal, 16).frame(height: 44).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityIdentifier("macReport")
    }

    /// MAC-SET v2: who is signed in and which build, the legal pages as rows, Sign out as a row, one Done button.
    private var v2Body: some View {
        VStack(alignment: .leading, spacing: 0) {
            MacV2Title(text: "Settings")
            VStack(spacing: 0) {
                row("Account", value: call.accountLabel ?? "Signed in", id: "macSettingsAccount")
                Divider().overlay(Color(white: 232.0 / 255))
                row("Version", value: Self.version, id: "macSettingsVersion")
                Divider().overlay(Color(white: 232.0 / 255))
                loginRow
                Divider().overlay(Color(white: 232.0 / 255))
                link("Terms", MacDesignV2.terms)
                Divider().overlay(Color(white: 232.0 / 255))
                link("Privacy Policy", MacDesignV2.privacy)
                Divider().overlay(Color(white: 232.0 / 255))
                reportRow
            }.overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(white: 232.0 / 255), lineWidth: 1)).padding(.top, 20)
            Button { dismiss(); call.signOut() } label: {
                Text("Sign out").font(MacSheetInk.sans(15, .medium)).foregroundStyle(MacSheetInk.ink)
                    .padding(.horizontal, 16).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
            }.buttonStyle(.plain).overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(white: 232.0 / 255), lineWidth: 1))
                .padding(.top, 12).accessibilityIdentifier("macSettingsSignOut")
            MacV2Button(label: "Done", id: "macSettingsDone") { dismiss() }.keyboardShortcut(.defaultAction).padding(.top, 24)
        }
        .padding(.horizontal, compact ? 20 : 32).padding(.top, 28).padding(.bottom, 24).frame(width: compact ? 320 : 420, alignment: .topLeading)
        .background(MacSheetInk.sheet)
    }

    /// Open at login (MacLoginItem): on by default, so bringing the iPhone close moves the call without opening
    /// Genita first. When macOS wants approval, one line under it opens System Settings ▸ Login Items.
    private var loginRow: some View {
        VStack(alignment: .leading, spacing: 0) {
            Toggle(isOn: Binding(get: { loginItem.isOn }, set: { loginItem.setOn($0) })) {
                Text("Open at login").font(MacSheetInk.sans(15)).foregroundStyle(MacSheetInk.ink)
            }
            .toggleStyle(MacInkSwitchStyle())
            .padding(.horizontal, 16).frame(height: 44)
            .accessibilityIdentifier("macSettingsOpenAtLogin")
            if loginItem.needsApproval {
                Button { loginItem.openLoginItemsSettings() } label: {
                    HStack(spacing: 4) {
                        Text("Approve in System Settings > Login Items").lineLimit(1).minimumScaleFactor(0.85)
                        Image(systemName: "arrow.up.right").font(.system(size: 10, weight: .medium))
                    }.font(MacSheetInk.sans(12)).foregroundStyle(MacSheetInk.mute)
                        .padding(.horizontal, 16).padding(.bottom, 12).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityAddTraits(.isLink).accessibilityIdentifier("macSettingsLoginApproval")
                    .padding(.top, -4)
            }
        }
        .onAppear { loginItem.refresh() }
    }

    static var version: String {
        let info = Bundle.main.infoDictionary
        let v = info?["CFBundleShortVersionString"] as? String ?? "–"
        let b = info?["CFBundleVersion"] as? String
        return b.map { "\(v) (\($0))" } ?? v
    }
    private func row(_ title: String, value: String, id: String) -> some View {
        HStack {
            Text(title).foregroundStyle(MacSheetInk.ink)
            Spacer(minLength: 12)
            Text(value).foregroundStyle(MacSheetInk.mute).lineLimit(1).truncationMode(.middle)
        }.font(MacSheetInk.sans(15)).padding(.horizontal, 16).frame(height: 44)
            .accessibilityElement(children: .combine).accessibilityIdentifier(id)
    }
    private func link(_ title: String, _ url: String) -> some View {
        Button { if let u = URL(string: url) { NSWorkspace.shared.open(u) } } label: {
            HStack {
                Text(title).font(MacSheetInk.sans(15)).foregroundStyle(MacSheetInk.ink)
                Spacer()
                Image(systemName: "arrow.up.right").font(.system(size: 11, weight: .medium)).foregroundStyle(MacSheetInk.mute)
            }.padding(.horizontal, 16).frame(height: 44).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityAddTraits(.isLink)
    }

    private var v1Body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Settings").font(MacSheetInk.serif(28)).tracking(-0.28).foregroundStyle(MacSheetInk.ink).frame(height: 34, alignment: .leading)
                .accessibilityAddTraits(.isHeader)
            if let name = call.companionName {
                Text("\(name) is set up on your iPhone. Change their name, voice and setup there.")
                    .font(MacSheetInk.sans(15)).foregroundStyle(MacSheetInk.ink).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 16) { MacLegalLinks() }.font(MacSheetInk.sans(14)).foregroundStyle(MacSheetInk.ink).underline().frame(height: 44)
            Button("Report a problem") { reportOpen = true }.buttonStyle(.link).font(MacSheetInk.sans(14)).accessibilityIdentifier("macReport")
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

/// The Settings switch in the sheet's ink: drawn in SwiftUI (the system switch is an AppKit control the review
/// renders can't draw). 36×20 capsule, ink when on, the line grey when off.
struct MacInkSwitchStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button { configuration.isOn.toggle() } label: {
            HStack {
                configuration.label
                Spacer(minLength: 12)
                ZStack(alignment: configuration.isOn ? .trailing : .leading) {
                    Capsule().fill(configuration.isOn ? MacSheetInk.ink : Color(white: 219.0 / 255))
                    Circle().fill(Color.white).padding(2).shadow(color: .black.opacity(0.12), radius: 1, y: 0.5)
                }
                .frame(width: 36, height: 20)
                .animation(.easeOut(duration: 0.15), value: configuration.isOn)
            }.contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isToggle)
        .accessibilityValue(configuration.isOn ? "On" : "Off")
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
