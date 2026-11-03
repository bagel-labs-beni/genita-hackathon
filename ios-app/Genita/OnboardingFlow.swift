import Foundation
import UIKit

/// F1–F4 on the server (PRD v12 B1): A02 → CS01 → A03 → I01 → I02 → I03 → I04 → V01 → V03 → V02 → V04 → NM01
/// → D01 → P → SUM → PREP-1 → S07 → S09. The screens stay where they are; this is what they call and where they go.
extension AppState {
    /// UI tests and screen review run without a server unless they point one at the app (GENITA_API_URL).
    var serverWired: Bool {
        #if DEBUG
        if BrowserPreview.isActive { return false } // Appetize preview: no server
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
    /// `afterSignIn`: a returning account goes to its call even if A03's Next was already tapped.
    /// Token, authentication lifetime and cancellation are checked after each request.
    func routeOnLaunch(afterSignIn: Bool = false) async {
        let launchRequest = launchAuthSnapshot
        let request = onboardingSnapshot()
        // no session but the phone remembers a later screen (a cleared/expired token, a sign-out that didn't reach
        // here): A02 first, never A03 → N1–N3 and a bounce to A02 at the end (QA build 5; PRD A02 → CS01 → A03)
        if needsSignInFirst { signedOut(); return }
        guard serverWired, launchRequest.token != nil else { return }
        let state = await onboarding.auth.sessionState()
        // A current 401 clears its token in the auth client. It still routes to A02, but an old
        // request must never sign out a newer login or re-adopt a logged-out account's handoff.
        guard launchRequest.generation == authGeneration, !Task.isCancelled,
              ownsOnboardingResponse(request, allowingClearedSession: state == .expired) else { return }
        if case .expired = state {
            guard onboarding.auth.token == nil else { return }
            signedOut()
            return
        }
        guard launchRequest.accepts(launchAuthSnapshot) else { return }
        var me: GenitaMe?
        if case .active(let m) = state { me = m; adopt(accountId: m.user.id) }
        let route = StartRouter.route(state, device: .iphone)
        // a companion on the server but not on this phone (reinstall, new phone, a judge's ready-made one):
        // bring its name, card and face back first
        if route == .connecting || route == .textWhilePreparing, setup.companionName == nil || me?.companionDemo == true { await restoreCompanion(for: request) }
        guard launchRequest.accepts(launchAuthSnapshot), !Task.isCancelled,
              ownsOnboardingResponse(request) else {
            // The session expired while the companion came back: that request's 401 cleared this lifetime's token.
            // A02, as for an expired /me (a logout or another login bumps the generation and never lands here).
            if launchRequest.generation == authGeneration, !Task.isCancelled, onboarding.auth.token == nil,
               ownsOnboardingResponse(request, allowingClearedSession: true) { signedOut() }
            return
        }
        apply(route, me: me, afterSignIn: afterSignIn)
    }

    func restoreCompanion(for request: OnboardingSessionGeneration.Snapshot? = nil) async {
        let launchRequest = launchAuthSnapshot
        let request = request ?? onboardingSnapshot()
        guard let c = try? await onboarding.companion(), launchRequest.accepts(launchAuthSnapshot), !Task.isCancelled,
              ownsOnboardingResponse(request) else { return }
        setup.companionName = c.name
        setup.imageId = c.imageId
        setup.imageType = c.type
        setup.companionCreated = true
        setup.companionDemo = c.demo
        if let p = c.session?.persona { setup.serverPersona = p }
        if let profile = c.session?.user?.profile, !profile.isEmpty { setup.styleProfile = profile }
        prep = c.prep
        // the face on this phone: the companion's call scene (the original photo isn't downloadable)
        // (Meta-only `sceneUrl` is a token-protected server path, so it goes through the account client)
        if setup.imageData == nil, let url = c.prep?.sceneURL,
           let data = try? await onboarding.sceneImage(url), UIImage(data: data) != nil,
           launchRequest.accepts(launchAuthSnapshot), !Task.isCancelled, ownsOnboardingResponse(request) {
            setup.imageData = data
        }
    }

    /// PREP-1: the server's call scene once it exists; the screen crossfades the uploaded photo to it (400 ms).
    func loadScene() async {
        guard serverWired, sceneImageData == nil, let url = prep?.sceneURL, let key = sceneKey,
              let data = try? await onboarding.sceneImage(url), UIImage(data: data) != nil else { return }
        // the account or companion may have changed while the image was on its way
        if sceneKey == key { sceneImage = (key, data) }
    }

    func apply(_ route: StartRoute, me: GenitaMe? = nil, afterSignIn: Bool = false) {
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
            // (right after a sign-in nothing is in progress yet: the setup was just reset for this account)
            if !afterSignIn && !setup.hasOnboarded && onboardingStages.contains(stage) && stage != .bringing { return }
            // a returning account (or a new phone): no first-call wait, that's only right after onboarding (D21)
            if stage != .conversation { setup.hasOnboarded = true; complete() }
        case .macNoCompanion, .macConversationOnPhone, .macConversationHere: break
        }
    }

    // MARK: A03

    /// Screens that work without an account: A01 and A02. Everything after needs a session on a wired build.
    static let beforeSignIn: Set<Stage> = [.welcome, .signIn]
    var needsSignInFirst: Bool { serverWired && onboarding.auth.token == nil && !Self.beforeSignIn.contains(stage) }

    /// A03 "Not you? Sign out": back to A02 to use another account.
    func signOutFromName() async {
        await onboarding.auth.logout()
        signedOut()
    }

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
        story = nil; storyChanged = [:]; storyFailed = false; hisyPage = 0
        guard serverWired else { importing = false; return }
        let request = onboardingSnapshot()
        importing = true
        importTask = Task { [weak self] in
            guard let self else { return }
            do {
                let style = try await onboarding.importReply(text)
                guard !Task.isCancelled, ownsOnboardingResponse(request) else { return }
                applyStyle(style)
                importing = false
                if stage == .preparing { go(.preferences) }
            } catch {
                let expiredCurrentSession = (error as? GenitaAuthError) == .unauthorized
                guard !Task.isCancelled,
                      ownsOnboardingResponse(request, allowingClearedSession: expiredCurrentSession) else { return }
                importing = false
                importError = Self.importErrorLine(error)
                if stage == .preparing { returnTo(.paste) }
                route(error)
            }
        }
    }

    func cancelImport() { importTask?.cancel(); importTask = nil; importing = false; returnTo(.paste) }

    /// What N1–N3 send (`POST /v1/import/skip`): the N1 topics as interests and the taste picker as
    /// `n3.{clothes,food,chats}.{like,no}` (each chip is off, liked or "no").
    static func skipAnswers(_ s: SavedSetup) -> (interests: [String], n3: [String: [String: [String]]]) {
        let like = Set(s.skipLikes ?? []), no = Set(s.skipAvoid ?? [])
        func group(_ items: [String]) -> [String: [String]] { ["like": items.filter { like.contains($0) }, "no": items.filter { no.contains($0) }] }
        return (Array((s.skipInterests ?? []).prefix(8)),
                ["clothes": group(SkipImportView.clothes), "food": group(SkipImportView.foods), "chats": group(SkipImportView.chats)])
    }

    /// N1–N3 Continue → I04-S (same rows, from the chips).
    func finishSkip() {
        guard serverWired else { go(.preferences); return }
        importing = true
        Task {
            defer { importing = false }
            do {
                let answers = Self.skipAnswers(setup)
                applyStyle(try await onboarding.importSkip(interests: answers.interests, replies: setup.skipReplies, n3: answers.n3))
                go(.preferences)
            } catch { flowError = Self.errorLine(error); route(error) }
        }
    }

    func applyStyle(_ style: ImportedStyle) {
        setup.styleRows = style.rows
        setup.styleProfile = style.profile
        setup.stylePartial = style.partial
        // a new import / N1–N3 answers: the old cards are gone (nil → HISY reads the new story), back to the opener
        story = style.story?.isEmpty == false ? style.story : nil
        storySource = style.source
        storyChanged = [:]; storyFailed = false; hisyPage = 0
    }

    // MARK: HISY "How I see you" (D47 v2)

    /// The story when the import didn't bring it (N1–N3, or written late): the server holds each ask up to 8 s
    /// while it writes; `processing` asks again (3 tries). Nothing → HISY-0 "Show me" goes to HISY-7.
    func loadStory() async {
        guard serverWired, story == nil, !storyLoading, !importing else { return }
        storyLoading = true; storyFailed = false
        defer { storyLoading = false }
        for _ in 0..<3 {
            do {
                let r = try await onboarding.story(wait: 8)
                if story != nil { return }   // the import landed meanwhile
                if r.status == .ready, !r.cards.isEmpty { story = r.cards; storySource = r.source ?? storySource; return }
                if r.status == .none { break }
            } catch {
                route(error); break
            }
        }
        if story == nil { storyFailed = true }
    }

    /// C1 Save: the marked texts and/or what's right. The card comes back rewritten (C3: the new texts get the blue
    /// border) or nil when the correction emptied it (it leaves the deck); the six I04 rows and the call's profile
    /// text follow. Returns the error line to show in the sheet (nil = done).
    func correctStory(cardId: String, items: [String], text: String?) async -> String? {
        do {
            let r = try await onboarding.correct(cardId: cardId, items: items, text: text)
            if var cards = story, let i = cards.firstIndex(where: { $0.id == cardId }) {
                if let card = r.card { cards[i] = card } else { cards.remove(at: i); hisyPage = min(hisyPage, cards.count + 1) }
                story = cards
            }
            storyChanged[cardId] = r.changed
            if !r.rows.isEmpty { setup.styleRows = r.rows; setup.stylePartial = r.rows.contains { $0.items.isEmpty } }
            setup.styleProfile = r.profile   // "" too: the last line was taken out, the call mustn't bring it back
            return nil
        } catch {
            route(error)
            return Self.errorLine(error)
        }
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
        guard let data = setup.imageData, rightsAcked else { return }
        imageCheck = nil; imageCheckError = nil
        polished = nil; polishedImage = nil; polishError = nil; polishing = false; polishRetriesLeft = 0; polishAttempts = 0
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
                // photo polish: V03 keeps waiting while the server polishes; V02-T then confirms the polished picture
                if r.polish == true {
                    polishRetriesLeft = 2
                    await polish(source: r.imageId, ticket: ticket)
                } else if r.passed { setup.imageId = r.imageId; setup.imageType = r.type }
            } catch {
                guard imageCheckTicket == ticket, !Task.isCancelled else { return }
                imageCheckError = Self.imageErrorLine(error); route(error)
            }
        }
    }

    /// One polish of the uploaded photo (server: Muse Image edit + the same check on the result), then its bytes.
    private func polish(source: String, ticket: UUID) async {
        polishing = true; polishError = nil
        defer { if imageCheckTicket == ticket { polishing = false } }
        do {
            polishAttempts += 1
            let p = try await onboarding.polishImage(imageId: source)
            guard imageCheckTicket == ticket, !Task.isCancelled else { return }
            // kept before the download: a failed download only reloads the picture, it never costs a polish
            polished = p; polishedImage = nil; polishRetriesLeft = p.retriesLeft
            setup.imageId = p.passed ? p.imageId : nil
            if p.passed { setup.imageType = p.type }
            await loadPolishedImage(ticket: ticket)
        } catch {
            guard imageCheckTicket == ticket, !Task.isCancelled else { return }
            switch error as? GenitaAuthError {
            // a refusal comes back the same for this photo: choose another one
            case .server(422, _)?: polishError = "This photo can't be used. Choose another photo."; polishRetriesLeft = 0
            case .server(429, "polish_limit")?: polishRetriesLeft = 0; if polished == nil { polishError = "Choose another photo." }
            // the failed attempt counts on the server too: three per upload
            case .server(502, _)?: polishError = "Couldn't polish this photo."; polishRetriesLeft = max(0, 3 - polishAttempts)
            default: polishError = Self.errorLine(error); route(error)
            }
        }
    }

    private func loadPolishedImage(ticket: UUID) async {
        guard let p = polished else { return }
        do {
            let bytes = try await onboarding.imageBytes(imageId: p.imageId)
            guard imageCheckTicket == ticket, !Task.isCancelled else { return }
            polishedImage = bytes; polishError = nil
        } catch {
            guard imageCheckTicket == ticket, !Task.isCancelled else { return }
            polishError = "Couldn't load the picture."; route(error)
        }
    }

    /// The polished picture can still be changed: no companion yet, none being made (the face is fixed after, B7).
    var canRetryPolish: Bool { setup.companionCreated != true && !creatingCompanion && !polishing }

    /// V02-T "Try again": reload a picture whose download failed, else polish the same upload once more (two at most).
    func retryPolish() {
        guard canRetryPolish, let source = imageCheck?.imageId else { return }
        let ticket = UUID(); imageCheckTicket = ticket
        if polished != nil, polishedImage == nil {
            imageCheckTask = Task { polishing = true; defer { if imageCheckTicket == ticket { polishing = false } }; await loadPolishedImage(ticket: ticket) }
            return
        }
        guard polishRetriesLeft > 0 else { return }
        imageCheckTask = Task { await polish(source: source, ticket: ticket) }
    }

    /// V02-F copy for upload errors: an unreadable photo is "choose another", not "try again".
    static func imageErrorLine(_ error: Error) -> String {
        if case GenitaAuthError.server(422, "unreadable_image")? = error as? GenitaAuthError { return "We couldn't read this image. Choose another photo." }
        return errorLine(error)
    }

    /// V02-T "Use this image": the companion is made now and prep starts at once (D28); voice and name come next.
    func useCheckedImage() {
        // photo polish: the confirmed polished picture is the companion's face from now on (the call scene too)
        if let p = polished, p.passed, setup.imageId == p.imageId, let bytes = polishedImage { setup.imageData = bytes }
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
            guard let s = try? await onboarding.suggestName(imageId: imageId) else { return }
            if CompanionName.isValid(s.name) { suggestedCompanionName = CompanionName.clean(s.name) }
            if (setup.companionName ?? "").isEmpty { setup.companionName = s.name }
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

    /// PREP-1 (every 2 s) and the call (S09-PREP, every 5 s): poll `GET /v1/companion/prep` while the screen is up
    /// (scene → expressions → mouth). Stops at ready or failed (PREP-1e Try again starts it again).
    func followPrep(every seconds: Double = 2) async {
        guard serverWired else { return }
        if prep?.isReady == true { return }
        while !Task.isCancelled {
            do {
                let p = try await onboarding.prep()
                prep = p
                if p.isReady || p.isFailed { return }
            } catch GenitaAuthError.unauthorized {
                route(GenitaAuthError.unauthorized); return
            } catch GenitaAuthError.consentRequired {
                route(GenitaAuthError.consentRequired); return
            } catch GenitaAuthError.server(404, _) {
                return   // no companion (deleted, or a judge's demo removed): nothing is being made
            } catch {}
            try? await Task.sleep(for: .seconds(seconds))
        }
    }

    /// PREP-1e Try again: the server redoes only what didn't finish; the screen polls again (its task is keyed on
    /// `prep.status`).
    func retryPrep() {
        guard serverWired, !retryingPrep else { return }
        retryingPrep = true; prepError = nil
        Task {
            defer { retryingPrep = false }
            do { prep = try await onboarding.retryPrep() } catch { prepError = Self.errorLine(error); route(error) }
        }
    }

    /// S09-PREP: the stage still being made while the call is up ("Getting the mouth ready"), nil when ready/failed.
    var callPrepIndicator: String? { PrepScreen.callIndicator(prep) }

    /// PREP-1 Start talking / Continue with the photo (or everything ready): S07 → S09. Before ready the call starts
    /// with the photo face (S09-P); after a failure it stays the photo (S09-PF).
    func startFirstCall() { if stage == .bringing { go(.connecting) } }

    // MARK: call start

    /// `start.greetAfterMs` for the first call after onboarding (D21), then cleared.
    func takeFirstCallWait() -> Int? {
        guard setup.firstCallPending == true else { return nil }
        setup.firstCallPending = false
        return 2000
    }
}
