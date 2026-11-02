import SwiftUI

struct ReferenceWelcomeView: View {
    var action: () -> Void
    var referenceViewport = false
    var body: some View {
        GeometryReader { safe in
            GeometryReader { full in
                let size = referenceViewport ? CGSize(width: 390, height: 844) : full.size
                let shift = (size.height - 844) / 2
                Button(action: action) {
                    ZStack(alignment: .topLeading) {
                        Color("Canvas")
                        Image(resource: "brandmark").resizable().frame(width: 152, height: 70.9945).rotationEffect(.degrees(-14.05)).position(x: 193.3445 + (size.width - 390) / 2, y: 368.8885 + shift)
                        let label = DesignLibrary.nodes("welcome").first { $0.type == "text" }!
                        DesignText(node: label).designSlot(label, width: size.width, top: shift)
                    }.frame(width: size.width, height: size.height)
                }.buttonStyle(.plain).accessibilityLabel("Get started").accessibilityIdentifier("getStarted")
            }.ignoresSafeArea(.container)
        }
    }
}
struct ReferenceSignInView: View {
    @Bindable var model: AppState
    @State private var provider: String?
    @State private var legal: String?
    /// A02 Apple: the sheet is up / the server is answering.
    @State private var signingIn = false
    /// A02-E: "Couldn't reach Apple…" for 4 s; a cancel stays silent (board §1).
    @State private var signInFailed = false
    /// A02-M Continue with email (NEW · design check)
    @State private var emailSheet = false
    var referenceViewport = false
    var nodes: [DesignNode] { DesignLibrary.nodes("signIn") }
    var body: some View {
        GeometryReader { safe in
            GeometryReader { full in
                let size = referenceViewport ? CGSize(width: 390, height: 844) : full.size
                let top = referenceViewport ? 0 : safe.safeAreaInsets.top - 44
                let bottom = size.height - 844
                ZStack(alignment: .topLeading) {
                    Image(resource: "signin").resizable().frame(width: 757, height: 1009)
                        .offset(x: -172 + (size.width - 390) / 2, y: -168 + top)
                        .frame(width: size.width, height: size.height, alignment: .topLeading).clipped()
                    Image(resource: "logo").resizable().frame(width: 63.142, height: 22.626).position(x: 66.571, y: 78.823 + top)
                    ForEach(nodes.filter { $0.type == "text" && ($0.fontFamily == "KMU80 TTF" || $0.y == 199) }) { n in
                        DesignText(node: n).designSlot(n, width: size.width, top: top)
                    }
                    // the board's two buttons move up one row (61 pt) so "Continue with email" takes Google's old row; the legal line stays put
                    providerButton("Apple", width: size.width).frame(width: size.width - 77, height: 50).position(x: (size.width - 1) / 2, y: 537 + bottom)
                    providerButton("Google", width: size.width).frame(width: size.width - 77, height: 50).position(x: (size.width - 1) / 2, y: 598 + bottom)
                    emailButton.frame(width: size.width - 77, height: 50).position(x: (size.width - 1) / 2, y: 659 + bottom)
                    let node = nodes.first { $0.y == 734 && $0.type == "text" }!
                    DesignText(node: node).frame(width: node.w, height: node.h).position(x: size.width / 2, y: 751 + bottom)
                    Button { legal = "Terms" } label: { Color.clear.contentShape(Rectangle()) }.frame(width: 44, height: 24).position(x: size.width / 2 + 85, y: 743 + bottom).accessibilityLabel("Terms")
                    Button { legal = "Privacy Policy" } label: { Color.clear.contentShape(Rectangle()) }.frame(width: 85, height: 24).position(x: size.width / 2 + 54, y: 761 + bottom).accessibilityLabel("Privacy Policy")
                }.frame(width: size.width, height: size.height).clipped()
            }.ignoresSafeArea(.container)
        }.preferredColorScheme(.dark)
        .overlay(alignment: .top) {
            if signInFailed {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.circle").font(.system(size: 16, weight: .medium))
                    Text("Couldn’t reach Apple. Check your connection and try again.").font(TypeStyle.body(14, .medium))
                }.foregroundStyle(.white).padding(.horizontal, 16).padding(.vertical, 12)
                    .background(Color.black.opacity(0.84), in: RoundedRectangle(cornerRadius: 12)).padding(.horizontal, 16).padding(.top, 72)
                    .transition(.opacity).accessibilityAddTraits(.isStaticText).accessibilityIdentifier("signInFailed")
            }
        }
        .sheet(isPresented: $emailSheet) { emailSheetContent }
        .onAppear {
            #if DEBUG
            if ProcessInfo.processInfo.environment["GENITA_REVIEW_VARIANT"]?.hasPrefix("email") == true { emailSheet = true }
            #endif
        }
        .alert("\(provider ?? "") sign-in", isPresented: Binding(get: { provider != nil }, set: { if !$0 { provider = nil } })) {
            Button("Continue in demo") {
                #if DEBUG
                // Appetize preview: the demo path still goes through the consent screen (CS01)
                if BrowserPreview.isActive { model.signedIn(consented: false); provider = nil; return }
                #endif
                model.signedIn(); provider = nil
            }
            Button("Cancel", role: .cancel) { provider = nil }
        } message: { Text("Account sign-in is not connected yet. You can explore setup locally on this iPhone.") }
        .onChange(of: legal) { _, doc in
            // PRD v12 D16: Genita's own pages (live)
            guard let doc else { return }
            legal = nil
            if let url = URL(string: doc == "Terms" ? "https://bagel-labs-beni.github.io/genita-legal/terms/" : "https://bagel-labs-beni.github.io/genita-legal/privacy/") { UIApplication.shared.open(url) }
        }
    }
    func providerButton(_ name: String, width: CGFloat) -> some View {
        let label = nodes.first { $0.characters == "Continue with " + name }!
        return Button { if name == "Apple" { signInWithApple() } else { provider = name } } label: {
            ZStack {
                RoundedRectangle(cornerRadius: 12).fill(.white).overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(white: 0.9373), lineWidth: 2))
                Image(resource: name.lowercased()).resizable().frame(width: 20, height: name == "Apple" ? 22 : 20).position(x: name == "Apple" ? 76 : 70, y: name == "Apple" ? 23 : 24)
                DesignText(node: label).frame(width: label.w, height: label.h).position(x: (width - 390) / 2 + label.x - 38 + label.w / 2, y: name == "Apple" ? 24 : 24)
            }
        }.buttonStyle(.plain).disabled(signingIn).accessibilityLabel("Continue with " + name)
    }

    /// Same white button as Apple / Google; envelope glyph in the logo's slot.
    var emailButton: some View {
        Button {
            #if DEBUG
            // Appetize preview: no real e-mail sign-in (it would sign in to the live service), the local demo instead
            if BrowserPreview.isActive { provider = "Email"; return }
            #endif
            emailSheet = true
        } label: {
            ZStack {
                RoundedRectangle(cornerRadius: 12).fill(.white).overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(white: 0.9373), lineWidth: 2))
                HStack(spacing: 11) {
                    Image(systemName: "envelope").font(.system(size: 18, weight: .medium)).frame(width: 20, height: 20)
                    Text("Continue with email").font(TypeStyle.body(16, .medium))
                }.foregroundStyle(.black)
            }
        }.buttonStyle(.plain).disabled(signingIn).accessibilityLabel("Continue with email").accessibilityIdentifier("continueWithEmail")
    }

    @ViewBuilder var emailSheetContent: some View {
        #if DEBUG
        // review stage: GENITA_REVIEW_VARIANT=emailCode opens straight on the code step (screenshots without a server)
        if ProcessInfo.processInfo.environment["GENITA_REVIEW_VARIANT"] == "emailCode" {
            EmailSignInSheet(model: model, step: .code, email: "you@example.com")
        } else {
            EmailSignInSheet(model: model)
        }
        #else
        EmailSignInSheet(model: model)
        #endif
    }

    /// F1-L2: native Sign in with Apple → session JWT. First sign-in (or no consent yet) → CS01, else back in.
    func signInWithApple() {
        guard !signingIn else { return }
        #if DEBUG
        // Appetize preview: no Apple login in a simulator stream, offer the local demo instead
        if BrowserPreview.isActive { provider = "Apple"; return }
        #endif
        signingIn = true
        Task { @MainActor in
            defer { signingIn = false }
            do {
                let r = try await AppleSignInFlow().signIn()
                model.signedIn(userId: r.me.user.id, consented: r.me.consented)
                model.adopt(accountId: r.me.user.id)   // #163: the saved setup's style/companion belong to this account
            } catch GenitaAuthError.cancelled {
                // cancel stays quietly on A02
            } catch {
                withAnimation(.easeOut(duration: 0.2)) { signInFailed = true }
                try? await Task.sleep(for: .seconds(4))
                withAnimation(.easeOut(duration: 0.2)) { signInFailed = false }
            }
        }
    }
}
