import Foundation
import UIKit

/// F1–F4 on the server (PRD v12 B1): A02 → CS01 → A03 → I01 → I02 → I03 → I04 → V01 → V03 → V02 → V04 → NM01
/// → D01 → P → SUM → PREP-1 → S07 → S09. The screens stay where they are; this is what they call and where they go.
extension AppState {
    /// UI tests and screen review run without a server unless they point one at the app (GENITA_API_URL).
    var serverWired: Bool {
        #if DEBUG
        let env = ProcessInfo.processInfo.environment
        if env["GENITA_REVIEW_STAGE"] != nil && env["GENITA_API_URL"] == nil { return false }
        if ProcessInfo.processInfo.arguments.contains("--uitesting") && env["GENITA_API_URL"] == nil { return false }
        #endif
        return true
    }

    // MARK: launch (F1-L7 StartRouter, F12 reopen)

    /// On launch with a saved token: `/me` decides the first screen (new account → A01…, consent → CS01,
    /// no name → A03, no companion → I01 or the onboarding step the user left, companion → S07 → S09).
    /// Offline keeps the saved screen; a 401 clears the token and shows A02.
    func routeOnLaunch() async {
        guard serverWired, onboarding.auth.isSignedIn else { return }
        let state = await onboarding.auth.sessionState()
        var me: GenitaMe?
        if case .active(let m) = state { me = m; adopt(accountId: m.user.id) }
        let route = StartRouter.route(state, device: .iphone)
        // a companion on the server but not on this phone (reinstall, new phone, a judge's ready-made one):
        // bring its name, card and face back first
        if route == .connecting || route == .textWhilePreparing, setup.companionName == nil || me?.companionDemo == true { await restoreCompanion() }
        apply(route, me: me)
    }

    func restoreCompanion() async {
        guard let c = try? await onboarding.companion() else { return }
        setup.companionName = c.name
        setup.imageId = c.imageId
        setup.imageType = c.type
        setup.companionCreated = true
        setup.companionDemo = c.demo
        if let p = c.session?.persona { setup.serverPersona = p }
        if let profile = c.session?.user?.profile, !profile.isEmpty { setup.styleProfile = profile }
        prep = c.prep
        // the face on this phone: the companion's call scene (the original photo isn't downloadable)
        if setup.imageData == nil, let url = c.prep?.sceneURL, url.scheme == "https",
           let (data, res) = try? await URLSession.shared.data(from: url), (res as? HTTPURLResponse)?.statusCode == 200, UIImage(data: data) != nil {
            setup.imageData = data
        }
    }

    func apply(_ route: StartRoute, me: GenitaMe? = nil) {
        let onboardingStages: Set<Stage> = [.prompt, .paste, .preparing, .preferences, .image, .imageCheck, .voice, .companionName,
                                            .depth, .help, .relationship, .challenge, .tempo, .initiative, .boundaries, .presence, .summary,
                                            .skipTopics, .skipReplies, .skipAvoid, .bringing]
        if let given = me?.user.displayName, setup.name.isEmpty { setup.name = given }
        switch route {
        case .splash: if stage != .welcome { returnTo(.welcome) }
        case .signIn: if stage != .signIn { signedOut() }
        case .offline: break
        case .consent: if stage != .consent { go(.consent) }
        case .name: if !onboardingStages.contains(stage) || stage == .conversation { returnTo(.name) }
        case .importPrompt:
            // a companion isn't made yet: resume where this phone left off, else I01
            // (A03 stays: right after CS01 the user still confirms their name, B8)
            if setup.hasOnboarded || !(onboardingStages.contains(stage) || stage == .name) { setup.hasOnboarded = false; returnTo(.prompt) }
        case .connecting, .textWhilePreparing:
            // the companion exists: straight to the call (photo face until prep lands, D28)
            setup.companionCreated = true
            if !setup.hasOnboarded && onboardingStages.contains(stage) && stage != .bringing { return }
            // a returning account (or a new phone): no first-call wait, that's only right after onboarding (D21)
            if stage != .conversation { setup.hasOnboarded = true; complete() }
        case .macNoCompanion, .macConversationOnPhone, .macConversationHere: break
        }
    }

    // MARK: A03

    func saveDisplayName() {
        let name = setup.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard serverWired, !name.isEmpty else { return }
        Task { _ = try? await onboarding.auth.setName(name) }
    }

    // MARK: I01–I04 (F2)

    /// I02 "Use this response" → I03. Spark makes the six-row style (4–8 s); the pasted text isn't stored on the server.
    func startImport() {
        importTask?.cancel()
        importError = nil
        let text = setup.response
        guard serverWired else { importing = false; return }
        importing = true
        importTask = Task { [weak self] in
            guard let self else { return }
            do {
                let style = try await onboarding.importReply(text)
                if Task.isCancelled { return }
                applyStyle(style)
                importing = false
                if stage == .preparing { go(.preferences) }
            } catch {
                if Task.isCancelled { return }
                importing = false
                importError = Self.importErrorLine(error)
                if stage == .preparing { returnTo(.paste) }
                route(error)
            }
        }
    }

    func cancelImport() { importTask?.cancel(); importTask = nil; importing = false; returnTo(.paste) }

    /// N1–N3 Continue → I04-S (same rows, from the chips).
    func finishSkip() {
        guard serverWired else { go(.preferences); return }
        importing = true
        Task {
            defer { importing = false }
            do {
                applyStyle(try await onboarding.importSkip(interests: setup.skipInterests ?? [], replies: setup.skipReplies, avoid: setup.skipAvoid ?? []))
                go(.preferences)
            } catch { flowError = Self.errorLine(error); route(error) }
        }
    }

    func applyStyle(_ style: ImportedStyle) {
        setup.styleRows = style.rows
        setup.styleProfile = style.profile
        setup.stylePartial = style.partial
    }

    /// I04: the six rows as read-only text (I04-P rows say "Not enough information yet.").
    var styleText: String {
        guard let rows = setup.styleRows, !rows.isEmpty else { return setup.response }
        return ImportedStyle(rows: rows, partial: setup.stylePartial ?? false, toConfirm: [], profile: "", source: "").displayText
    }

    static func importErrorLine(_ error: Error) -> String {
        if case GenitaAuthError.server(let status, _) = error, status == 400 || status == 422 {
            return "I couldn’t read this one. Paste the whole reply, or try again."
        }
        return errorLine(error)
    }

    static func errorLine(_ error: Error) -> String {
        switch error as? GenitaAuthError {
        case .offline?: return "You’re offline. Check your connection and try again."
        case .unauthorized?: return "Please sign in again."
        case .consentRequired?: return "Agree to how Genita uses AI first."
        default: return "Something went wrong. Try again."
        }
    }

    /// 401 → A02, 403 consent_required → CS01 (same as the call's 4401/4403).
    func route(_ error: Error) {
        switch error as? GenitaAuthError {
        case .unauthorized?: signedOut()
        case .consentRequired?: if stage != .consent { go(.consent) }
        default: break
        }
    }

    // MARK: V01 → V03 → V02 (F3)

    /// ≤1024 px JPEG (PREP_API.md: 2–3 s faster check, the scene is 1024 px anyway).
    static func uploadJPEG(_ data: Data) -> Data? {
        guard let image = UIImage(data: data), let thumb = image.preparingThumbnail(of: CGSize(width: 1024, height: 1024)) else { return nil }
        return thumb.jpegData(compressionQuality: 0.8)
    }

    /// V01 "Use this image" → V03 → V02-T / V02-F.
    func checkImage() {
        // the face is fixed once the companion exists (B7): no second check, no new face
        if setup.companionCreated == true { go(.voice); return }
        guard let data = setup.imageData else { return }
        imageCheck = nil; imageCheckError = nil
        imageCheckTask?.cancel()
        let ticket = UUID(); imageCheckTicket = ticket
        go(.imageCheck)
        guard serverWired else {
            // screen review / UI tests without a server: V02-T as a passed person
            imageCheck = ImageCheck(imageId: "local", passed: true, type: "human",
                                    checks: .init(oneFaceFrontFacing: true, sharpAndLit: true, noText: true), reasons: [])
            return
        }
        checkingImage = true
        imageCheckTask = Task {
            defer { if imageCheckTicket == ticket { checkingImage = false } }
            do {
                guard let jpeg = Self.uploadJPEG(data) else { throw GenitaAuthError.badResponse }
                let r = try await onboarding.checkImage(jpeg: jpeg)
                // a late answer for an image the user already replaced doesn't count
                guard imageCheckTicket == ticket, !Task.isCancelled else { return }
                imageCheck = r
                if r.passed { setup.imageId = r.imageId; setup.imageType = r.type }
            } catch {
                guard imageCheckTicket == ticket, !Task.isCancelled else { return }
                imageCheckError = Self.errorLine(error); route(error)
            }
        }
    }

    /// V02-T "Use this image": the companion is made now and prep starts at once (D28); voice and name come next.
    func useCheckedImage() {
        go(.voice)
        guard serverWired, setup.companionCreated != true, let imageId = setup.imageId else { return }
        creatingCompanion = true
        companionTask = Task {
            defer { creatingCompanion = false }
            do {
                let c = try await onboarding.createCompanion(imageId: imageId)
                setup.companionCreated = true
                prep = c.prep
            } catch GenitaAuthError.server(409, _) {
                setup.companionCreated = true   // one companion per user; it already exists
            } catch { flowError = Self.errorLine(error); route(error) }
        }
        suggestName()
    }

    // MARK: V04

    /// V04 Continue: the picked voice is saved on the companion. The companion already has the recommended
    /// voice from "Use this image", so an unreachable server (or no pick while the voice service wakes) just continues.
    func saveVoiceAndContinue() {
        if setup.deviceVoice == nil { setup.deviceVoice = VoicePlayer.deviceFallbackID }   // silent offline fallback, not a choice
        UserDefaults.standard.set(setup.deviceVoice, forKey: VoicePlayer.deviceFallbackKey)
        guard serverWired, let voiceId = setup.voiceId else { go(.companionName); return }
        savingVoice = true
        Task {
            defer { savingVoice = false }
            await companionTask?.value
            if setup.companionCreated == true { voiceUnsaved = (try? await onboarding.saveVoice(voiceId)) == nil }   // else NM01's create sends it
            go(.companionName)
        }
    }

    // MARK: NM01 (D21)

    /// Pre-fills NM01 from the server's suggestion (photo + imported style). The user's own edit wins.
    func suggestName() {
        guard serverWired, let imageId = setup.imageId, (setup.companionName ?? "").isEmpty else { return }
        suggestingName = true
        Task {
            defer { suggestingName = false }
            if let s = try? await onboarding.suggestName(imageId: imageId), (setup.companionName ?? "").isEmpty { setup.companionName = s.name }
        }
    }

    var validCompanionName: Bool { CompanionName.isValid(setup.companionName ?? "") }

    /// NM01 Continue: the name goes into the persona (PATCH), then D01.
    func saveCompanionName() {
        guard validCompanionName else { return }
        setup.companionName = CompanionName.clean(setup.companionName ?? "")
        guard serverWired else { go(.depth); return }
        savingName = true; nameError = nil
        Task {
            defer { savingName = false }
            await companionTask?.value
            do {
                if voiceUnsaved, let voiceId = setup.voiceId, (try? await onboarding.saveVoice(voiceId)) != nil { voiceUnsaved = false }
                if setup.companionCreated == true { try await onboarding.renameCompanion(setup.companionName ?? "") }
                else if let imageId = setup.imageId {
                    try await onboarding.createCompanion(imageId: imageId, voiceId: setup.voiceId, name: setup.companionName)
                    setup.companionCreated = true
                }
                go(.depth)
            } catch GenitaAuthError.server(400, _) {
                nameError = "Try a different name."
            } catch { nameError = Self.errorLine(error); route(error) }
        }
    }

    // MARK: SUM → PREP-1 (F4, D38)

    var prefsAnswers: [String: Any] {
        let sliders = ["challenge", "tempo", "initiative"].reduce(into: [String: Int]()) { $0[$1] = setup.answers[$1].flatMap(Int.init) }
        return SetupAnswersWire.answers(depth: setup.depth.rawValue, help: setup.answers["help"], relationship: setup.answers["relationship"],
                                        presence: setup.presence.sorted(), sliders: sliders, never: setup.boundaries.sorted())
    }

    /// SUM Continue: the persona card is written (2.6–3.3 s), then PREP-1. A failure still goes on (the server
    /// starts the call with the default card and rebuilds it, PRD F4).
    func saveSetupAndPrepare() {
        guard serverWired else { go(.bringing); return }
        savingPrefs = true
        Task {
            defer { savingPrefs = false }
            await companionTask?.value
            do {
                let r = try await onboarding.savePrefs(depth: setup.depth.rawValue, answers: prefsAnswers)
                setupSummary = r.summary
                if let p = r.session?.persona { setup.serverPersona = p }
            } catch { route(error) }
            if stage == .summary { go(.bringing) }
        }
    }

    /// PREP-1: poll `GET /v1/companion/prep` every 2 s while the screen is up (scene → expressions → mouth).
    func followPrep() async {
        guard serverWired else { return }
        while !Task.isCancelled {
            do {
                let p = try await onboarding.prep()
                prep = p
                if p.isReady { return }
            } catch GenitaAuthError.unauthorized {
                route(GenitaAuthError.unauthorized); return
            } catch GenitaAuthError.consentRequired {
                route(GenitaAuthError.consentRequired); return
            } catch {}
            try? await Task.sleep(for: .seconds(2))
        }
    }

    /// PREP-1 Continue (or everything ready): S07 → S09. Before ready the call starts with the photo face.
    func startFirstCall() { if stage == .bringing { go(.connecting) } }

    // MARK: call start

    /// `start.greetAfterMs` for the first call after onboarding (D21), then cleared.
    func takeFirstCallWait() -> Int? {
        guard setup.firstCallPending == true else { return nil }
        setup.firstCallPending = false
        return 2000
    }
}
