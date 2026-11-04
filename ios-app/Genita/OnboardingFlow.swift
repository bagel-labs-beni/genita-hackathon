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
        // what this phone knew when /me was asked: a companion made while it was on its way is not "missed" (Codex P2)
        let companionWhenAsked = setup.companionCreated == true && !creatingCompanion
        // no session but the phone remembers a later screen (a cleared/expired token, a sign-out that didn't reach
        // here): A02 first, never A03 → N1–N3 and a bounce to A02 at the end (QA build 5; PRD A02 → CS01 → A03)
        if needsSignInFirst { signedOut(); return }
        guard serverWired, launchRequest.token != nil else { return }
        var state = await onboarding.auth.sessionState()
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
        if case .active(var m) = state {
            // AU-05 (LG-03): A03's name never reached the server (offline at Next) but this account already has its
            // companion: send the name this phone kept again and go on to the call, never back to A03
            let kept = setup.name.trimmingCharacters(in: .whitespacesAndNewlines)
            if (m.user.displayName ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, m.hasCompanion, !kept.isEmpty {
                if let saved = try? await onboarding.auth.setName(kept) { m = saved } else { m.user.displayName = kept }
                // another sign-in (or sign-out) happened meanwhile: this answer is for an account that's gone (Codex P2);
                // the PATCH's own 401 cleared this lifetime's token: A02, as for an expired /me (Codex re-review P2)
                guard launchRequest.accepts(launchAuthSnapshot), !Task.isCancelled, ownsOnboardingResponse(request) else {
                    if launchRequest.generation == authGeneration, !Task.isCancelled, onboarding.auth.token == nil,
                       ownsOnboardingResponse(request, allowingClearedSession: true) { signedOut() }
                    return
                }
                state = .active(m)
            }
            me = m; adopt(accountId: m.user.id); qaSamplePhotos = m.qaSamplePhotos == true
        }
        let route = StartRouter.route(state, device: .iphone)
        // a companion on the server but not on this phone (reinstall, new phone, a judge's ready-made one):
        // bring its name, card and face back first
        // Every launch into a call asks which companion the account has: another phone may have replaced it, and its
        // cached scene / photo must not open this call (handover b9-6). Not on this phone yet, or another one now →
        // bring it back in full; the same one → only confirm it (inputs on this phone stay, Codex P2).
        if route == .connecting || route == .textWhilePreparing {
            if setup.companionName == nil || me?.companionDemo == true { await restoreCompanion(for: request) }
            else { await confirmCompanion(for: request) }
        }
        guard launchRequest.accepts(launchAuthSnapshot), !Task.isCancelled,
              ownsOnboardingResponse(request) else {
            // The session expired while the companion came back: that request's 401 cleared this lifetime's token.
            // A02, as for an expired /me (a logout or another login bumps the generation and never lands here).
            if launchRequest.generation == authGeneration, !Task.isCancelled, onboarding.auth.token == nil,
               ownsOnboardingResponse(request, allowingClearedSession: true) { signedOut() }
            return
        }
        apply(route, me: me, afterSignIn: afterSignIn, companionWhenAsked: companionWhenAsked)
    }

    /// CS01 "Agree and continue", after the server recorded the consent.
    /// AU-03 (JG-01): right after a sign-in, `/me` picks the next screen while CS01's button spins. A judge's
    /// ready-made companion goes straight to the call, never through an empty A03 whose Next would start the
    /// onboarding instead. A new account gets A03 as before; no answer (offline) moves on to A03 too.
    func consentAgreed() async {
        let returning = history.contains(.conversation) || setup.hasOnboarded
        guard serverWired, !returning else {
            consentAccepted()
            // a returning account (4403 mid-call) is back in its call; /me still checks where it stands
            if serverWired { await routeOnLaunch() }
            return
        }
        consentRecorded()
        await routeOnLaunch(afterSignIn: true)
        if stage == .consent { consentAccepted() }
    }

    /// The server's companion vs the one this phone remembers: a different one (replaced or deleted on another
    /// device) drops this phone's scene and picture before anything draws them; the same one confirms the cache.
    func adoptServerCompanion(imageId: String?) {
        if let mine = setup.imageId, mine != imageId {
            // a scene downloaded in this launch is already the server's current one; a cached one isn't
            if !sceneFresh { sceneImage = nil }
            setup.imageData = nil
        }
        sceneCompanionConfirmed = true
    }

    /// The companion on this phone is the server's one → confirmed; another one → restored in full.
    func confirmCompanion(for request: OnboardingSessionGeneration.Snapshot? = nil) async {
        let launchRequest = launchAuthSnapshot
        let request = request ?? onboardingSnapshot()
        guard let c = try? await onboarding.companion(), launchRequest.accepts(launchAuthSnapshot), !Task.isCancelled,
              ownsOnboardingResponse(request) else { return }
        if c.imageId == setup.imageId { adoptServerCompanion(imageId: c.imageId); return }
        await applyServerCompanion(c, launchRequest: launchRequest, request: request)
    }

    func restoreCompanion(for request: OnboardingSessionGeneration.Snapshot? = nil) async {
        let launchRequest = launchAuthSnapshot
        let request = request ?? onboardingSnapshot()
        guard let c = try? await onboarding.companion(), launchRequest.accepts(launchAuthSnapshot), !Task.isCancelled,
              ownsOnboardingResponse(request) else { return }
        await applyServerCompanion(c, launchRequest: launchRequest, request: request)
    }

    private func applyServerCompanion(_ c: CompanionInfo, launchRequest: LaunchAuthSnapshot, request: OnboardingSessionGeneration.Snapshot) async {
        adoptServerCompanion(imageId: c.imageId)
        setup.companionName = c.name
        setup.imageId = c.imageId
        setup.imageType = c.type
        setup.companionCreated = true
        setup.companionDemo = c.demo
        // the saved voice (Settings → Voice); the name comes from this phone's pick or the curated list
        if let v = c.voiceId, v != setup.voiceId { setup.voiceId = v; setup.voiceName = VoicePlayer.name(forVoiceId: v) }
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
    /// The companion's face wherever it's drawn after V02 (call, PiP, NM01, PREP-1, the Mac via the handoff hello):
    /// the generated scene, else nothing (the caller draws a neutral placeholder). The upload photo is never drawn
    /// after V02 (Chelsea 11/4). Unwired builds (UI tests, Appetize preview) keep their bundled fixture.
    var companionFaceData: Data? {
        if let scene = sceneImageData { return scene }
        return serverWired ? nil : setup.imageData
    }

    /// `upcoming` = a prep answer not shown yet: its scene is fetched first so the screen never says ready over the
    /// uploaded photo.
    func loadScene(for upcoming: PrepProgress? = nil) async {
        let p = upcoming ?? prep
        guard serverWired, let url = p?.sceneURL else { return }
        // same key format as `sceneKey` (Codex P1); a cached copy under the same key is reused only once trusted
        let owner = sceneOwner, key = "\(owner)\(url.absoluteString)"
        guard !(sceneImage?.key == key && sceneTrusted), let data = try? await onboarding.sceneImage(url), UIImage(data: data) != nil,
              !Task.isCancelled else { return }
        // the account or companion may have changed while the image was on its way: keep it only for the same
        // account, and never over a newer scene already loaded for the prep on screen (an `upcoming` answer is
        // applied by the caller right after this, so its scene always wins)
        guard sceneOwner == owner, upcoming != nil || prep?.sceneURL == url || sceneImageData == nil else { return }
        sceneImage = (key, data)
        sceneFresh = true
    }

    /// `loadScene`, given up after `seconds` (a slow or hanging image download never holds a screen).
    func loadScene(for upcoming: PrepProgress? = nil, within seconds: Double) async {
        guard seconds > 0 else { return }
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.loadScene(for: upcoming) }
            group.addTask { try? await Task.sleep(for: .seconds(seconds)) }
            await group.next()
            group.cancelAll()
        }
    }

    static let sceneWaitSeconds: Double = 4

    /// PREP-1 ready: hold S07 until the call scene is on screen, at most `sceneWaitSeconds` in all (download
    /// included), then go on with what there is. No scene URL (photo face) = nothing to wait for.
    func waitForScene() async {
        guard serverWired, prep?.sceneURL != nil else { return }
        let deadline = Date().addingTimeInterval(Self.sceneWaitSeconds)
        while sceneImageData == nil, !Task.isCancelled, deadline.timeIntervalSinceNow > 0 {
            await loadScene(within: deadline.timeIntervalSinceNow)
            let left = deadline.timeIntervalSinceNow
            if sceneImageData == nil, left > 0 { try? await Task.sleep(for: .seconds(min(0.5, left))) }
        }
    }

    func apply(_ route: StartRoute, me: GenitaMe? = nil, afterSignIn: Bool = false, companionWhenAsked: Bool = false) {
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
            // the server has no companion but this phone remembers one: a Start over finished while the app was gone
            // (killed right after the reset, #514 Codex r3 P1). Drop it here too and pick a new photo (V01).
            if companionWhenAsked, setup.companionCreated == true, !creatingCompanion { companionReset(); return }
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
        story = nil; storyChanged = [:]; storyFailed = false; hisyPage = 0; insightReport = nil; insightUnavailable = false; insightAnswersSent = nil
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
                if stage == .preparing {
                    // I03 at 100 %: the bar fills and the orb pulses once, then I04/HISY (Chelsea 11/4)
                    readingDone = true
                    try? await Task.sleep(for: .milliseconds(Self.readingPulseMs))
                    readingDone = false
                    if !Task.isCancelled, ownsOnboardingResponse(request), stage == .preparing { go(.preferences) }
                }
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
        let ownerBefore = setup.skipOwner
        Task {
            defer { importing = false }
            do {
                let answers = Self.skipAnswers(setup)
                // marked as this account's before they go (saved on disk): if the app dies mid-send they never move to
                // another account; a sure "not saved" below takes the mark back (Codex #516 AU-20 r2)
                setup.skipOwner = setup.accountId ?? "unknown"
                let style = try await onboarding.importSkip(interests: answers.interests, replies: setup.skipReplies, n3: answers.n3)
                // only a saved send makes them this account's (AU-20): a 401 / offline / 400 leaves them unsent, so the
                // next N3 tap keeps N1/N2 and signing in again carries them (the case #516 is for)
                setup.skipSent = true
                applyStyle(style)
                go(.preferences)
            } catch {
                // the server may have saved them (no answer, or a 5xx): they stay this account's, never carried to
                // another sign-in; a 401 / 403 / 4xx is a sure "not saved" (Codex #516 AU-20 r1)
                if !Self.maybeSaved(error) { setup.skipOwner = ownerBefore }
                flowError = Self.errorLine(error); route(error)
            }
        }
    }

    /// A failed send whose outcome is unknown: no answer at all (`offline` includes timeouts and dropped
    /// connections), a 5xx, or an unreadable answer. A 401 / consent / 4xx answer means nothing was saved.
    static func maybeSaved(_ error: Error) -> Bool {
        switch error as? GenitaAuthError {
        case .unauthorized?, .consentRequired?, .cancelled?: return false
        case .server(let status, _, _)?: return status >= 500
        default: return true
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
        if case GenitaAuthError.server(let status, _, _) = error, status == 400 || status == 422 {
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
        if setup.companionCreated == true || creatingCompanion { go(.voice); return }   // AU-37: also while it's made
        guard let data = setup.imageData, rightsAcked else { return }
        imageCheck = nil; imageCheckError = nil; imageCheckRetryable = false
        polished = nil; polishedImage = nil; polishError = nil; polishing = false; polishRetriesLeft = 0; polishAttempts = 0
        imageCheckTask?.cancel()
        let ticket = UUID(); imageCheckTicket = ticket
        if stage != .imageCheck { go(.imageCheck) }   // V02-F "Try again" (AU-26) checks again in place
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
                imageCheckError = Self.imageErrorLine(error)
                imageCheckRetryable = Self.isTransient(error)
                route(error)
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
            // AU-32: a Try again that fails its re-check never takes away a polished picture that already passed;
            // V02-T keeps it (Use this image still works) with the new attempt's reason on one line
            if !p.passed, let kept = polished, kept.passed, polishedImage != nil, setup.imageId == kept.imageId {
                polishRetriesLeft = p.retriesLeft
                polishError = p.reasons.first?.label ?? "Couldn't polish this photo."
                return
            }
            // kept before the download: a failed download only reloads the picture, it never costs a polish
            polished = p; polishedImage = nil; polishRetriesLeft = p.retriesLeft
            setup.imageId = p.passed ? p.imageId : nil
            if p.passed { setup.imageType = p.type }
            await loadPolishedImage(ticket: ticket)
        } catch {
            guard imageCheckTicket == ticket, !Task.isCancelled else { return }
            switch error as? GenitaAuthError {
            // a refusal comes back the same for this photo: choose another one
            case .server(422, _, _)?: polishError = "This photo can't be used. Choose another photo."; polishRetriesLeft = 0
            case .server(429, "polish_limit", _)?: polishRetriesLeft = 0; if polished == nil { polishError = "Choose another photo." }
            // the failed attempt counts on the server too: three per upload
            case .server(502, _, _)?: polishError = "Couldn't polish this photo."; polishRetriesLeft = max(0, 3 - polishAttempts)
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

    /// The request failed on the way, not on the photo: offline, a timeout or a server error (AU-26).
    static func isTransient(_ error: Error) -> Bool {
        switch error as? GenitaAuthError {
        case .offline?: return true
        case let .server(status, _, _)?: return status >= 500
        default: return false
        }
    }

    /// V02-F copy for upload errors: an unreadable photo is "choose another", not "try again".
    static func imageErrorLine(_ error: Error) -> String {
        if case GenitaAuthError.server(422, "unreadable_image", _)? = error as? GenitaAuthError { return "We couldn't read this image. Choose another photo." }
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
                let c = try await createCompanionAfterReset(imageId: imageId)
                setup.companionCreated = true
                prep = c.prep
            } catch GenitaAuthError.server(409, "reset_in_progress", _) {
                // still starting over after the retries: nothing exists yet, NM01 Continue creates it (#514)
            } catch is CancellationError {
                // another account now: nothing of this one's create applies
            } catch GenitaAuthError.server(409, _, _) {
                setup.companionCreated = true   // one companion per user; it already exists
            } catch { flowError = Self.errorLine(error); route(error) }
        }
        suggestName()
    }

    /// The server's own words for `409 reset_in_progress` (prep/routes.ts, #514).
    static let resetBusyLine = "Starting over. Try again in a moment."

    /// POST /v1/companion. `409 reset_in_progress` (#514: a Start over on this account is still erasing) means
    /// nothing exists yet, not "already made": wait a moment and ask again, a few times (handover b9-6).
    @discardableResult
    func createCompanionAfterReset(imageId: String, voiceId: String? = nil, name: String? = nil) async throws -> CompanionInfo {
        // another sign-in (or sign-out) meanwhile: never send this account's photo and name under the next one's
        // token, and never apply the answer to it (Codex P2)
        let generation = authGeneration
        func stillOurs() throws { if authGeneration != generation || Task.isCancelled { throw CancellationError() } }
        var tries = 0
        while true {
            try stillOurs()
            do {
                let c = try await onboarding.createCompanion(imageId: imageId, voiceId: voiceId, name: name)
                try stillOurs()
                return c
            } catch {
                // an error for the account before (its 401, say) is not this account's: no A02 bounce (Codex r2 P2)
                try stillOurs()
                guard case .server(409, "reset_in_progress"?, _)? = error as? GenitaAuthError, tries < resetRetries else { throw error }
                tries += 1
                try await Task.sleep(for: resetRetryDelay)
            }
        }
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
                    try await createCompanionAfterReset(imageId: imageId, voiceId: setup.voiceId, name: setup.companionName)
                    setup.companionCreated = true
                }
                go(.depth)
            } catch GenitaAuthError.server(400, _, _) {
                nameError = "Try a different name."
            } catch GenitaAuthError.server(409, "reset_in_progress", _) {
                nameError = Self.resetBusyLine
            } catch is CancellationError {
                // another account now: this NM01's answer doesn't belong to it
            } catch { nameError = Self.errorLine(error); route(error) }
        }
    }

    // MARK: SUM insight report (Chelsea 11/4, 춘식이 r02 R1)

    /// Server flag (app-config `insightReport`, default on): off = SUM keeps the old four lines.
    var insightsEnabled: Bool { GenitaAppConfigStore.shared.config.flag("insightReport", default: true) }

    /// SUM draws the report (or its loading state) unless it is off or couldn't be had.
    var useInsightReport: Bool { insightsEnabled && !insightUnavailable && (serverWired || insightReport != nil) }

    /// P-last (and SUM) opens: the answers so far go to the server, which rewrites the report in the background.
    /// Recorded as sent only after the server took them (a failed POST is sent again next time).
    func sendInsightAnswers() {
        guard serverWired, insightsEnabled else { return }
        let answers = prefsAnswers
        let key = (try? JSONSerialization.data(withJSONObject: answers, options: [.sortedKeys])).map { String(decoding: $0, as: UTF8.self) }
        guard key != insightAnswersSent else { return }
        insightUnavailable = false
        let request = onboardingSnapshot()
        let previous = insightAnswersTask
        insightAnswersTask = Task {
            await previous?.value
            // the account may have changed while it waited: never send A's answers with B's session (settings lane Codex P1)
            guard !Task.isCancelled, ownsOnboardingResponse(request) else { return }
            do {
                try await onboarding.insightAnswers(answers)
                if ownsOnboardingResponse(request) { insightAnswersSent = key }
            } catch {}
        }
    }

    /// SUM: the report; the server holds each ask up to 6 s while it writes (`pending` may carry the earlier one,
    /// shown meanwhile). Waits for the answers POST first. Three tries; nothing → the old SUM.
    func loadInsights() async {
        guard serverWired, insightsEnabled, !insightLoading else { return }
        insightLoading = true
        defer { insightLoading = false }
        await insightAnswersTask?.value
        let request = onboardingSnapshot()
        for _ in 0..<3 {
            do {
                let r = try await onboarding.insights(wait: 6)
                guard ownsOnboardingResponse(request), !Task.isCancelled else { return }
                if let report = r.report, insightVerdictTask == nil { insightReport = report }
                if r.status == .ready { return }
                if r.status == .none || r.status == .failed { break }
            } catch {
                if ownsOnboardingResponse(request) { route(error) }
                break
            }
        }
        if insightReport == nil, ownsOnboardingResponse(request) { insightUnavailable = true }
    }

    /// "That's me" (right) / "Not quite" Save or Remove (not_me), one after another. right is shown at once and
    /// undone if the server didn't take it; not_me takes the server's report (the trait and what was built on it go).
    /// Returns an error line (nil = done).
    @discardableResult
    func insightVerdict(id: String, verdict: String, correction: String? = nil) async -> String? {
        let before = insightReport?.observations.first { $0.id == id }
        if verdict == "right", var r = insightReport, let i = r.observations.firstIndex(where: { $0.id == id }) {
            r.observations[i].verdict = "right"; r.observations[i].confidence = "high"; insightReport = r
        }
        guard serverWired else {
            if verdict == "not_me", var r = insightReport { r.observations.removeAll { $0.id == id }; insightReport = r }
            return nil
        }
        let request = onboardingSnapshot()
        let previous = insightVerdictTask
        let task = Task<String?, Never> {
            _ = await previous?.value
            // queued behind an earlier verdict: the account may have changed meanwhile (settings lane Codex P1)
            guard !Task.isCancelled, ownsOnboardingResponse(request) else { return nil }
            do {
                let r = try await onboarding.insightVerdict(id: id, verdict: verdict, correction: correction)
                if ownsOnboardingResponse(request) { insightReport = r }
                return nil
            } catch {
                guard ownsOnboardingResponse(request) else { return nil }
                route(error)
                // undo the optimistic "That's me"
                if verdict == "right", let before, var r = insightReport, let i = r.observations.firstIndex(where: { $0.id == id }) {
                    r.observations[i] = before; insightReport = r
                }
                return Self.errorLine(error)
            }
        }
        insightVerdictTask = task
        let out = await task.value
        if insightVerdictTask == task { insightVerdictTask = nil }
        return out
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
            // PREP-1 opens on the real state: a prep that is already ready draws "ready" from the first frame
            // (no 0.5 s of empty "Bringing … to life" rows), with its scene already in
            if let p = try? await onboarding.prep() {
                if p.isReady { await loadScene(for: p, within: Self.sceneWaitSeconds) }
                prep = p
            }
            if stage == .summary { go(.bringing) }
        }
    }

    /// SUM Cancel (PRD F4): back to the first question (P1, after D01), every answer kept.
    func cancelSummary() {
        guard stage == .summary, !savingPrefs else { return }
        // back through the history (P1's Back goes to D01, not to SUM)
        returnTo(setup.depth.path.first { $0 != .depth } ?? .help)
    }

    /// PREP-1 (every 2 s) and the call (S09-PREP, every 5 s): poll `GET /v1/companion/prep` while the screen is up
    /// (scene → expressions → mouth). Stops at ready or failed (PREP-1e Try again starts it again).
    func followPrep(every seconds: Double = 2) async {
        guard serverWired else { return }
        if prep?.isReady == true { return }
        while !Task.isCancelled {
            do {
                let p = try await onboarding.prep()
                // ready is shown with the made face already in place, never over the uploaded photo
                if p.isReady { await loadScene(for: p, within: Self.sceneWaitSeconds) }
                prep = p
                if p.isReady || p.isFailed { return }
            } catch GenitaAuthError.unauthorized {
                route(GenitaAuthError.unauthorized); return
            } catch GenitaAuthError.consentRequired {
                route(GenitaAuthError.consentRequired); return
            } catch GenitaAuthError.server(404, _, _) {
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
