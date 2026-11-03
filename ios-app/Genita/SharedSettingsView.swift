import SwiftUI
import AVFoundation

/// M02 Settings (iPhone + Mac). Hackathon build: no "What I keep" row (ST-1's toggles were only for the
/// cut Us photo / seen memory; general memory stays on), Privacy · Terms (D16), Sign out, Delete account.
struct SettingsView: View {
    @Bindable var model: AppState
    @Environment(\.dismiss) private var dismiss
    /// M02-D: delete confirmation; M02: account actions only when signed in.
    @State private var confirmDelete = false
    @State private var working = false
    @State private var accountError: String?
    /// M02 "Make a new companion" (11/4): the same confirm style as M02-D; the account and what Genita knows stay
    @State private var confirmReset = false
    @State private var resetting = false
    @State private var resetError: String?
    /// RP-1 (D37): Report on M02
    @State private var reportOpen = false
    /// model.onboarding.auth (not a fresh GenitaAuthClient) so the --stub-signin UI-test session counts too
    private var signedIn: Bool { model.onboarding.auth.isSignedIn }
    static let labels = ["help": "Help with", "relationship": "Relationship", "challenge": "Challenge", "tempo": "Tempo", "initiative": "Reach out", "presenceDescription": "Presence"]
    static let scales = ["challenge": ["Gentle", "Direct"], "tempo": ["Reflective", "Quick"], "initiative": ["Only when asked", "Anticipate"]]
    static func label(for key: String) -> String { labels[key] ?? key.capitalized }
    /// The five slider stops read as words, not "Gentle 3/5 Direct" (UI sweep 11/3).
    static let steps = ["challenge": ["Gentle", "Mostly gentle", "In between", "Mostly direct", "Direct"],
                        "tempo": ["Reflective", "Mostly reflective", "In between", "Mostly quick", "Quick"],
                        "initiative": ["Only when asked", "Now and then", "Sometimes", "Often", "Anticipate"]]
    static func display(_ key: String, _ value: String) -> String {
        guard let words = steps[key], let step = Int(value) else { return value }
        return words[min(max(step, 0), words.count - 1)]
    }
    /// "Communication style / • Warm, direct." → a quiet heading over its bullets; a line that isn't followed
    /// by a bullet (a pasted reply in another shape) stays body text.
    static func styleLines(_ text: String) -> [(text: String, heading: Bool)] {
        let lines = text.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        return lines.enumerated().map { i, line in
            let next = i + 1 < lines.count ? lines[i + 1] : ""
            return (line, !line.hasPrefix("•") && next.hasPrefix("•"))
        }
    }
    private var styleText: String {
        guard let rows = model.setup.styleRows, !rows.isEmpty else { return model.setup.response }
        return ImportedStyle(rows: rows, partial: false, toConfirm: [], profile: "", source: "").displayText
    }
    /// The account's voice: the V04 pick on this phone, else the companion's saved voice from the server (another
    /// phone, a reinstall: build 7 Appetize showed "Default" after picking Leah, 11/4).
    private var voiceName: String {
        model.setup.voiceName ?? CuratedVoices.name(model.setup.voiceId) ?? "Default"
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
                    if signedIn {
                        Button(resetting ? "Starting over…" : "Make a new companion") { confirmReset = true }
                            .disabled(resetting || working).accessibilityIdentifier("makeNewCompanion")
                    }
                }
                Section("Your preferences") {
                    if !styleText.isEmpty {
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(Array(Self.styleLines(styleText).enumerated()), id: \.offset) { i, line in
                                Text(line.text)
                                    .font(.custom(line.heading ? "PretendardVariable-Medium" : "PretendardVariable-Regular", size: line.heading ? 13 : 15, relativeTo: line.heading ? .footnote : .subheadline))
                                    .foregroundStyle(line.heading ? .secondary : .primary)
                                    .padding(.top, line.heading && i > 0 ? 10 : 0)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }.padding(.vertical, 4).textSelection(.enabled).accessibilityElement(children: .combine)
                    }
                    LabeledContent("Setup", value: model.setup.depth.title)
                    ForEach(model.setup.answers.keys.sorted(), id: \.self) { key in LabeledContent(Self.label(for: key), value: Self.display(key, model.setup.answers[key] ?? "")) }
                }
                if signedIn {
                    // F1-L8: sign out and in-app account deletion (App Review 5.1.1(v))
                    Section("Account") {
                        Button("Report a problem") { reportOpen = true }.accessibilityIdentifier("settingsReport")
                        Button("Sign out") { signOut() }.disabled(working || resetting).accessibilityIdentifier("signOut")
                        Button(working ? "Deleting…" : "Delete account", role: .destructive) { confirmDelete = true }.disabled(working || resetting).accessibilityIdentifier("deleteAccount")
                    }
                }
                Section {
                    Link("Privacy Policy", destination: URL(string: "https://bagel-labs-beni.github.io/genita-legal/privacy/")!)
                    Link("Terms", destination: URL(string: "https://bagel-labs-beni.github.io/genita-legal/terms/")!)
                }
            }.navigationTitle("Settings")
            .reportFlow(isPresented: $reportOpen, surface: "settings", auth: model.onboarding.auth) { CallController.shared.lastReplyText }
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .confirmationDialog("Delete your account?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete account", role: .destructive) { deleteAccount() }
                Button("Cancel", role: .cancel) {}
            } message: { Text("This deletes your companion, your conversation, memories and Finds on your iPhone and Mac. It can’t be undone.") }
            .confirmationDialog("Start over with someone new?", isPresented: $confirmReset, titleVisibility: .visible) {
                Button("Start over", role: .destructive) { resetCompanion() }
                Button("Cancel", role: .cancel) {}
            } message: { Text(Self.resetMessage(model.setup.companionName)) }
            .alert("Couldn’t start over", isPresented: Binding(get: { resetError != nil }, set: { if !$0 { resetError = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(resetError ?? "") }
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

    /// "{Name}, their face, voice and your chats together will be removed. What Genita knows about you stays."
    static func resetMessage(_ companionName: String?) -> String {
        let n = CompanionName.clean(companionName ?? "")
        return "\(n.isEmpty ? "Your companion" : n), their face, voice and your chats together will be removed. What Genita knows about you stays."
    }
    /// GET /v1/companion after a failed reset: nil = it's still there, else the error (404 = gone).
    private static func companionLookup(_ model: AppState) async -> GenitaAuthError? {
        do { _ = try await model.onboarding.companion(); return nil }
        catch { return (error as? GenitaAuthError) ?? .badResponse }
    }
    private func resetCompanion() {
        resetting = true
        // the account this was asked for: a late answer after a sign-out / another sign-in must not touch the new one (Codex P2)
        let asked = model.launchAuthSnapshot
        let resets = model.companionResets
        Task { @MainActor in
            defer { resetting = false }
            do {
                try await model.onboarding.resetCompanion()
                guard asked.accepts(model.launchAuthSnapshot) else { return }
                // the call's 4410 reset this phone already: the user may have picked a new photo or started a new
                // call since — this late answer touches nothing, not even the call (Codex #514 r2)
                guard model.companionResets == resets else { return }
                CallController.shared.end()
                dismiss()
                model.companionResetAnswered(since: resets)
            } catch GenitaAuthError.unauthorized where asked.generation == model.authGeneration {
                // this request's 401 cleared the token (same sign-in): A02, as everywhere else
                dismiss()
                model.signedOut()
            } catch _ where !asked.accepts(model.launchAuthSnapshot) {
                return
            } catch GenitaAuthError.server(status: 429, _, _) {
                resetError = "You’ve started over a lot today. Try again tomorrow."
            } catch {
                // a failure after the companion's rows went (its files, say) still started over (#514 Codex r3 P2):
                // ask the server what is there now instead of saying nothing was removed
                let now = await Self.companionLookup(model)
                if now == .unauthorized, asked.generation == model.authGeneration { dismiss(); model.signedOut(); return }
                if case GenitaAuthError.server(404, _, _)? = now {
                    guard asked.accepts(model.launchAuthSnapshot), model.companionResets == resets else { return }
                    CallController.shared.end()
                    dismiss()
                    model.companionResetAnswered(since: resets)
                    return
                }
                resetError = "Try again in a moment."
            }
        }
    }
    private func signOut() {
        working = true
        Task { @MainActor in
            defer { working = false }
            await model.onboarding.auth.logout()
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
                model.accountDeleted()
            } catch GenitaAuthError.unauthorized {
                // the session is gone: the account may have been deleted (an earlier try) or the session expired.
                // Either way A02, and this phone keeps nothing of an account its owner asked to delete; no "deleted"
                // notice, that needs the server's answer.
                dismiss(); model.leftAfterDeleteRequest()
            } catch {
                // AU-06: a slow answer (or a step that failed after the files went) may still have deleted the
                // account. A 401 on /me now means the session is gone (deleted or expired, the server can't say
                // which): as above. Otherwise the account is still there.
                if case .expired = await model.onboarding.auth.sessionState() { dismiss(); model.leftAfterDeleteRequest() }
                else { accountError = "Try again in a moment." }
            }
        }
    }
}

/// The four V04 voices' names by server id (genita-server src/prep/voices.ts DEFAULT_VOICES). Lives here, not in the
/// iOS-only OnboardingViews.swift, because the GenitaMac target compiles this file too.
enum CuratedVoices {
    static let names = ["72": "Tara", "9": "Leah", "19": "Leo", "26": "Dan"]
    static func name(_ id: String?) -> String? { id.flatMap { names[$0] } }
}
