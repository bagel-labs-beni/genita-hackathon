import SwiftUI

/// A02-M · Continue with email (NEW · design check: no Figma frame yet). Two steps in one light sheet over A02,
/// in the A02-J / consent sheet's type, ink, field and buttons: the address → "Send code", then the 6-digit code
/// → the same session as Apple (`/auth/email/verify`), then the usual CS01 for a new account.
struct EmailSignInSheet: View {
    @Bindable var model: AppState
    @Environment(\.dismiss) private var dismiss
    enum Step: Equatable { case address, code }
    @State private var step: Step
    @State private var email: String
    /// the address the code went to (verify uses this, not whatever the field holds now)
    @State private var sentTo: String
    @State private var code = ""
    @State private var sending = false
    @State private var message: String?
    /// "Resend code" waits until this moment (server: one code per 60 s per address)
    @State private var resendAt = Date.distantPast
    @State private var now = Date()
    @FocusState private var focused: Bool
    private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    /// `step`/`email` other than the defaults only for the DEBUG review stage (screenshots of the code step).
    init(model: AppState, step: Step = .address, email: String = "") {
        self.model = model
        _step = State(initialValue: step)
        _email = State(initialValue: email)
        _sentTo = State(initialValue: email)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(step == .address ? "Continue with email" : "Check your email").font(TypeStyle.title(28)).foregroundStyle(CallInk.ink).padding(.top, 32)
                .accessibilityAddTraits(.isHeader).accessibilityIdentifier("emailSheetTitle")
            Text(step == .address ? "We’ll send a 6-digit code to sign you in. No Apple\u{00A0}ID\u{00A0}needed." : "Enter the 6-digit code we sent to \(sentTo).")
                .font(TypeStyle.text(16)).foregroundStyle(CallInk.mute).padding(.top, 12).fixedSize(horizontal: false, vertical: true)
            Group {
                if step == .address {
                    TextField("Email address", text: $email)
                        // `.username`, not `.emailAddress`: a code sign-in wants the person's own address, and
                        // `.emailAddress` raised the system "Hide My Email" callout (QA build 5)
                        .keyboardType(.emailAddress).textContentType(.username).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .submitLabel(.send).accessibilityIdentifier("emailField")
                } else {
                    TextField("6-digit code", text: $code)
                        .keyboardType(.numberPad).textContentType(.oneTimeCode)
                        .onChange(of: code) { _, v in
                            let digits = String(v.filter(\.isNumber).prefix(6))
                            if digits != v { code = digits }
                            if digits.count == 6 { verify() }
                        }
                        .accessibilityIdentifier("emailCodeField")
                }
            }
            .focused($focused).disabled(sending).font(TypeStyle.text(16)).foregroundStyle(CallInk.ink)
            .padding(.horizontal, 16).frame(minHeight: 50)
            .background(CallInk.field, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(message == nil ? .clear : CallInk.ink, lineWidth: 1))
            .padding(.top, 24).onSubmit { step == .address ? sendCode() : verify() }
            if let message {
                Text(message).font(TypeStyle.text(14, .medium)).foregroundStyle(CallInk.ink).padding(.top, 12)
                    .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("emailError")
            }
            Spacer(minLength: 24)
            Button { step == .address ? sendCode() : verify() } label: {
                ZStack {
                    if sending { ProgressView().tint(CallInk.onInk) } else { Text(step == .address ? "Send code" : "Continue") }
                }.font(TypeStyle.text(16, .medium)).foregroundStyle(CallInk.onInk)
                    .frame(maxWidth: .infinity).frame(minHeight: 50)
                    .background(GlassCTA(color: CallInk.ink))
            }.buttonStyle(.plain).disabled(sending || !canContinue).accessibilityIdentifier("emailContinue")
            if step == .code {
                HStack {
                    Button("Use a different email") { back() }.accessibilityIdentifier("emailChange")
                    Spacer()
                    Button(resendLeft > 0 ? "Resend in \(resendLeft)s" : "Resend code") { sendCode() }
                        .disabled(sending || resendLeft > 0).accessibilityIdentifier("emailResend")
                }
                .font(TypeStyle.text(14, .medium)).foregroundStyle(CallInk.ink).frame(minHeight: 44).padding(.top, 4)
            } else {
                Button("Cancel") { close() }
                    .font(TypeStyle.text(16, .medium)).foregroundStyle(CallInk.ink).frame(maxWidth: .infinity).frame(minHeight: 50)
                    .disabled(sending).accessibilityIdentifier("emailCancel")
            }
            Spacer().frame(height: 8)
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(CallInk.sheet.ignoresSafeArea())
        .dynamicTypeSize(TextScale.sheet)
        .preferredColorScheme(.light)
        .presentationDetents([.medium, .large])
        // a request in flight finishes on this sheet: a late answer must not sign in after it closed
        .interactiveDismissDisabled(sending)
        .onAppear { focused = true }
        // the field lets go when the sheet goes, however it goes (QA build 5: the "Hide My Email" callout stayed on
        // CS01 → A03 → I01 → N3 → V01 because the email field was still first responder)
        .onDisappear { releaseKeyboard() }
        .onReceive(tick) { now = $0 }
    }

    private var canContinue: Bool { step == .address ? GenitaAuthClient.looksLikeEmail(email) : code.count == 6 }
    private var resendLeft: Int { max(0, Int(resendAt.timeIntervalSince(now).rounded(.up))) }

    private func releaseKeyboard() {
        focused = false
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
    private func close() {
        releaseKeyboard()
        dismiss()
    }

    private func back() {
        step = .address; code = ""; message = nil; focused = true
    }

    private func sendCode() {
        let address = step == .code ? sentTo : email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sending, GenitaAuthClient.looksLikeEmail(address) else { return }
        sending = true
        message = nil
        Task { @MainActor in
            defer { sending = false }
            do {
                let r = try await GenitaAuthClient().startEmailSignIn(email: address)
                sentTo = address
                resendAt = Date().addingTimeInterval(TimeInterval(r.resendAfterSec)); now = Date()
                code = ""
                step = .code
                focused = true
            } catch {
                message = EmailSignInCopy.message(for: error, sendingCode: true)
            }
        }
    }

    private func verify() {
        guard !sending, code.count == 6 else { return }
        sending = true
        message = nil
        Task { @MainActor in
            defer { sending = false }
            do {
                let r = try await GenitaAuthClient().signInWithEmailCode(email: sentTo, code: code)
                close()
                model.signedIn(userId: r.me.user.id, consented: r.me.consented, qaSamplePhotos: r.me.qaSamplePhotos == true)
            } catch {
                message = EmailSignInCopy.message(for: error, sendingCode: false)
                code = ""
            }
        }
    }
}
