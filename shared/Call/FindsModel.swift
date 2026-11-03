import Foundation
import Observation

/// F10-U-SHEET · The result sheet's state during a call (r03 board, direction A, 19 states).
/// Platform-neutral: the iPhone sheet draws it, the Mac can later. Rules from the r03 state map:
///   searching 148 → rising (148→468, text first) → half 468 → full 728 · peek 148 · dismissed 0 (+Undo) · browser.
///   Face tap or the user starting to talk = collapse to peek (not while a finger is on the sheet or reading full).
///   X, or swiping down from peek = dismissed (it stays in Finds, Undo restores). A new result never takes the
///   card you're reading: a banner offers it instead.
enum SheetState: String, CaseIterable, Sendable {
    case idle, searching, rising, half, full, peek, dismissed

    /// Visible sheet height on a 390 × 844 screen (r03 `.sheet` translateY: 744/580/400/260/0 of 728).
    var height: CGFloat {
        switch self {
        case .idle, .dismissed: 0
        case .searching, .peek: 148
        case .rising: 328
        case .half: 468
        case .full: 728
        }
    }
}

struct FindEntry: Identifiable, Equatable {
    let id: String
    var kind: FindKind
    var utteranceId: Int
    var searchTitle: String
    var searchDetail: String
    var card: FindCard?
    var failed: ServerEvent.FindFailed?
    /// JPEG frames the app sent with the question (the server never keeps them). `card.camera.frame` indexes them.
    var frames: [Data] = []
    var checking = true
    var saved = false
    /// Opened from the Finds tab (F10-U-FINDS): the card shows "Talk about this on a call" and closing goes back to the list.
    var reopened = false
    /// The user's words that started this find (PF-1d Retry asks them again, not whatever was said since).
    var question: String?

    /// The collapsed failure line (PF-1d). A server message is "Title. Body" — split on the first ". ".
    /// "I can't see it" (unclear) keeps its fixed title and shows the whole message as the body.
    var failureLines: (title: String, body: String)? {
        guard let f = failed else { return nil }
        if f.reason == .unclear { return ("I can’t see it clearly", f.message) }
        if let r = f.message.range(of: ". ") {
            return (String(f.message[..<r.lowerBound]), String(f.message[r.upperBound...]))
        }
        return (f.message.hasSuffix(".") ? String(f.message.dropLast()) : f.message, "")
    }
    /// A failed search the user can ask again (not a stop, not "show me again" which needs a new camera look).
    /// Product searches only: a recipe or outfit retry would need the camera frames the server already used.
    /// IC-4: the camera could not make out the food. The call shows a dark card over a blurred picture, not the sheet.
    var isUnclear: Bool { failed?.reason == .unclear }
    var canRetry: Bool { kind == .product && question?.isEmpty == false && (failed?.reason == .searchFailed || failed?.reason == .error) }
}

@MainActor @Observable final class FindsModel {
    // DEBUG fixtures (FindsFixture state 25) set the pill/say on the shown card, so the setter is not private
    var entries: [FindEntry] = []
    var state: SheetState = .idle
    /// Index into `entries` of the card on screen.
    var page = 0
    /// Ingredient chip the user tapped (its camera box lights up; r03 #4/#5).
    var selectedItem: String?
    /// Motion card 6: +1 each time the user saves the shown card (not on unsave, not when a failed unsave restores it).
    private(set) var savePulse = 0
    /// Step marked done, per find.
    var doneSteps: [String: Set<Int>] = [:]
    /// r03 #11: a result arrived while the user reads another one.
    private(set) var newFind: String?
    /// Source opened inside the sheet (r03 #8).
    var browser: FindCard.Source?
    /// r03 #16: offline — the card stays, sources open when back.
    var offline = false
    /// A finger is on the sheet: don't collapse it under the user (r03 rule for "user starts talking").
    var touching = false
    /// Section to bring into view on the card ("ask", "how"): VoiceOver focus and fixture screenshots.
    var scrollTarget: String?
    /// Undo target after a close (r03 #17).
    private(set) var undoState: SheetState?
    /// Boxes on the live camera preview (F5-U-CAM, CAM-H).
    let boxes = CameraBoxes()
    /// FT-NOSEE: a small card on the camera says what the companion cannot see and asks to move the camera. Never a guess.
    private(set) var noSee: NoSeeCheck?
    @ObservationIgnored private var noSeeTask: Task<Void, Never>?
    @ObservationIgnored private var risingTask: Task<Void, Never>?
    @ObservationIgnored private var toastTask: Task<Void, Never>?

    /// Interpretation is on: "Ask about this" would be translated to the other person, so asking is off.
    var interpreting = false
    var canAsk: Bool { !interpreting }

    /// Wired by CallController.
    @ObservationIgnored var send: (ClientMessage) -> Void = { _ in }
    /// The user's latest final words; copied onto the next find.started.
    @ObservationIgnored var latestQuestion: String?
    /// Wired by CallController: POST /v1/finds/:id/save. false = keep the old state.
    @ObservationIgnored var saveRemote: (String, Bool) async -> Bool = { _, _ in true }
    /// A card was made: keep the camera frames it came from on this phone (the server never stores them).
    @ObservationIgnored var persistFrames: (String, [Data]) -> Void = { _, _ in }
    /// Frames the controller sent with the latest question (base64 JPEG), attached to the next find.
    @ObservationIgnored var latestFrames: [String] = []

    var current: FindEntry? { entries.indices.contains(page) ? entries[page] : nil }
    var cardCount: Int { entries.filter { $0.card != nil }.count }

    // MARK: server events

    func apply(_ event: ServerEvent) {
        switch event {
        case let .findStarted(s):
            boxEpoch[s.findId] = boxes.epoch
            let frames = latestFrames.compactMap { Data(base64Encoded: $0) }
            entries.append(FindEntry(id: s.findId, kind: s.kind, utteranceId: s.utteranceId, searchTitle: s.title, searchDetail: s.detail, frames: frames, question: latestQuestion))
            if state == .idle || state == .dismissed || state == .searching {
                page = entries.count - 1
                state = .searching
                undoState = nil
            }
        case let .findProgress(p):
            update(p.findId) { $0.searchDetail = p.detail }
        case let .findItems(i):
            update(i.findId) { e in
                e.checking = i.checking
                guard var card = e.card else { e.card = nil; e.searchDetail = Self.detail(from: i.items, fallback: e.searchDetail); return }
                card.items = i.items
                if let s = i.subtitle { card.subtitle = s }
                if let s = i.status { card.status = s }
                if let p = i.pill { card.pill = p } // later item updates without a pill keep it
                e.card = card
            }
            pendingItems[i.findId] = i.items
        case let .findCreated(c):
            var card = c.card
            if let items = pendingItems.removeValue(forKey: c.findId), card.items.allSatisfy({ $0.tier == .checking }) { card.items = items }
            update(c.findId) { $0.card = card; $0.saved = card.saved ?? false }
            if let e = entries.first(where: { $0.id == c.findId }) { persistFrames(e.id, e.frames) }
            guard let index = entries.firstIndex(where: { $0.id == c.findId }) else { return }
            if state == .searching && page == index {
                state = .rising
                risingTask?.cancel()
                risingTask = Task { [weak self] in
                    try? await Task.sleep(for: .milliseconds(420))
                    guard let self, !Task.isCancelled, self.state == .rising else { return }
                    self.state = .half
                }
            } else if state == .half || state == .full || state == .peek {
                newFind = c.findId
            } else if state == .idle || state == .dismissed {
                page = index
                state = .peek
            }
        case let .observeBoxes(b):
            // a late batch from before the camera was flipped or turned off is not for this preview
            if let epoch = boxEpoch[b.findId], epoch != boxes.epoch { break }
            boxes.apply(b)
        case let .findImage(i):
            update(i.findId) { e in
                guard var card = e.card else { return }
                let image = FindImage(slot: i.slot, status: i.status == .ready ? .ready : .failed, url: i.url)
                if i.slot == "hero" { card.hero = image }
                if i.slot.hasPrefix("step-"), let n = Int(i.slot.dropFirst(5)), card.steps.indices.contains(n - 1) { card.steps[n - 1].image = image }
                if i.slot.hasPrefix("product-"), let n = Int(i.slot.dropFirst(8)), card.products?.indices.contains(n - 1) == true { card.products?[n - 1].image = image }
                e.card = card
            }
        case let .findFailed(f):
            update(f.findId) { $0.failed = f; $0.checking = false }
            if f.reason == .stopped, current?.id == f.findId, state == .searching { state = .idle }
        default:
            break
        }
    }

    @ObservationIgnored private var pendingItems: [String: [FindItem]] = [:]
    @ObservationIgnored private var boxEpoch: [String: Int] = [:]

    /// The save request failed: put the bookmark back.
    func revertSave(_ id: String, to saved: Bool) { update(id) { $0.saved = saved; $0.card?.saved = saved } }

    private func update(_ id: String, _ change: (inout FindEntry) -> Void) {
        guard let i = entries.firstIndex(where: { $0.id == id }) else { return }
        change(&entries[i])
    }

    private static func detail(from items: [FindItem], fallback: String) -> String {
        let names = items.prefix(4).map(\.name.capitalizedFirst)
        return names.isEmpty ? fallback : names.joined(separator: ", ") + " · recipes"
    }

    // MARK: gestures and buttons (r03 "접기냐 닫기냐")

    /// Drag on the handle ended. One step per gesture, however hard the flick.
    func dragEnded(translation: CGFloat, velocity: CGFloat) {
        let up = translation < -24 || velocity < -600
        let down = translation > 24 || velocity > 600
        switch state {
        case .half:
            if up { state = .full } else if down { if current?.reopened == true { close() } else { state = .peek } }
        case .full: if down { state = .half }
        case .peek: if up { state = .half } else if down { close() }
        case .searching: if down { stop() }
        default: break
        }
    }

    func tapPeek() { if state == .peek { state = .half } }
    /// Face tap in half: the user wants to see the companion, not lose the card.
    func faceTapped() -> Bool {
        guard state == .half || state == .full else { return false }
        state = state == .full ? .half : .peek
        return true
    }
    func pipTapped() { if state == .full { state = .half } }

    /// The user started talking. Conversation comes first; reading full or touching the sheet keeps it.
    func userStartedTalking() {
        guard state == .half, !touching else { return }
        state = .peek
    }

    func close() {
        guard state != .idle, state != .dismissed else { return }
        if let i = entries.indices.contains(page) ? page : nil, entries[i].reopened {
            // Reopened from the Finds tab: back to the list, nothing to undo (it never left Finds).
            entries[i].reopened = false
            state = .idle
            selectedItem = nil; browser = nil
            return
        }
        undoState = state == .searching ? nil : state
        if state == .searching, let f = current { send(.findStop(findId: f.id)) }
        state = .dismissed
        toastTask?.cancel()
        toastTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            guard let self, !Task.isCancelled, self.state == .dismissed else { return }
            self.state = .idle
            self.undoState = nil
        }
    }

    func undo() {
        guard state == .dismissed, let back = undoState else { return }
        toastTask?.cancel()
        state = back == .full ? .half : back
        undoState = nil
    }

    func stop() {
        guard let f = current else { state = .idle; return }
        send(.findStop(findId: f.id))
        state = .idle
    }

    /// IC-4 "Look again": the card goes away; the camera is still on, the person shows the shelves again.
    /// Returns the words of the failed question so the call can ask again with a fresh camera frame.
    @discardableResult func lookAgain() -> String? {
        guard let f = current, f.isUnclear else { return nil }
        state = .idle
        return f.question
    }

    /// PF-1 status pill (Figma 179:4/68/494/921): what the sheet is doing, one line (server strings ≤ 28 chars).
    /// nil = the ordinary call cue. Product searches only.
    /// Fridge (recipe) cards use the server's short `pill` ("Egg, tofu +2"); the full sentence is only spoken.
    var pillText: String? {
        guard let f = current, f.kind == .product || f.kind == .recipe, state != .idle, state != .dismissed else { return nil }
        if f.failed != nil { return f.kind == .product ? "Nothing I’d pick for you." : f.failureLines?.title }
        if state == .searching || f.card == nil { return f.kind == .product ? "On it…" : "Let me take a look…" }
        if f.saved { return "Saved. They’re in Finds." }
        if let pill = f.card?.pill, !pill.isEmpty { return pill }
        if let say = f.card?.say, say.count <= 28 { return say }
        return nil
    }

    /// PF-1d Retry: drop the failed line and ask the same question again; the new find.started brings the searching sheet back.
    func retry() {
        guard canAsk, let f = current, f.canRetry, let text = f.question else { return }
        state = .idle
        send(.text(.init(text: text, frames: nil)))
    }

    func viewNewFind() {
        guard let id = newFind, let i = entries.firstIndex(where: { $0.id == id }) else { return }
        page = i
        newFind = nil
        selectedItem = nil
        boxes.highlight(nil)
        if state == .peek { state = .half }
    }

    func showPage(_ i: Int) {
        guard entries.indices.contains(i), entries[i].card != nil else { return }
        page = i
        selectedItem = nil
        boxes.highlight(nil)
        if newFind == entries[i].id { newFind = nil }
    }

    /// Reopen the latest card (More → Finds, or Finds tab "continue").
    func reopenLatest() {
        guard let i = entries.lastIndex(where: { $0.card != nil }) else { return }
        page = i
        state = .half
    }

    func toggleSave() {
        guard let f = current else { return }
        let id = f.id
        let want = !f.saved
        update(id) { $0.saved = want }
        if want { savePulse += 1 }
        Task { @MainActor in
            // server first-class: if the save didn't land, the bookmark goes back
            if !(await saveRemote(id, want)) { update(id) { $0.saved = !want } }
        }
    }

    /// F10-U-FINDS: a card from the Finds tab goes into the sheet at half height. A card made in this call keeps
    /// its entry (frames, done steps); an older one is added with the frames this phone kept for it.
    func openSaved(_ card: FindCard, frames: [Data]) {
        risingTask?.cancel(); toastTask?.cancel()
        if let i = entries.firstIndex(where: { $0.id == card.id }) {
            entries[i].reopened = true
            if let saved = card.saved { entries[i].saved = saved; entries[i].card?.saved = saved }
            if entries[i].frames.isEmpty { entries[i].frames = frames }
            page = i
        } else {
            entries.append(FindEntry(id: card.id, kind: card.kind, utteranceId: 0, searchTitle: card.title, searchDetail: "", card: card,
                                     frames: frames, checking: false, saved: card.saved ?? false, reopened: true))
            page = entries.count - 1
        }
        selectedItem = nil; browser = nil; newFind = nil; undoState = nil
        boxes.clear(stale: false)
        state = .half
    }

    /// "Talk about this on a call": the card stays up over the call, questions are about it from here on.
    func talkAboutThis() {
        guard entries.indices.contains(page) else { return }
        entries[page].reopened = false
    }

    func tapItem(_ item: FindItem) {
        selectedItem = selectedItem == item.id ? nil : item.id
        boxes.highlight(selectedItem == nil ? nil : item.name)
    }

    /// "맞아?" answer (IC-3).
    func confirm(_ item: FindItem, yes: Bool) {
        guard let f = current else { return }
        send(.findConfirm(.init(findId: f.id, itemId: item.id, yes: yes)))
        selectedItem = nil
        boxes.highlight(nil)
    }

    func toggleStep(_ index: Int) {
        guard let f = current else { return }
        var set = doneSteps[f.id] ?? []
        if set.contains(index) { set.remove(index) } else { set.insert(index) }
        doneSteps[f.id] = set
    }

    /// "Ask about this": the question goes out as the user's words, about this card.
    func ask(_ text: String) {
        guard canAsk, let f = current else { return }
        send(.text(.init(text: text, frames: nil, findId: f.id)))
    }

    func callEnded() {
        boxes.clear()
        risingTask?.cancel(); toastTask?.cancel()
        state = .idle
        browser = nil
        newFind = nil
        undoState = nil
    }

    /// FT-NOSEE: show the card; it leaves by itself after `hold` (nil = stays until tapped, for screenshots).
    func showNoSee(_ check: NoSeeCheck, hold: Duration? = .seconds(8)) {
        noSeeTask?.cancel()
        noSee = check
        guard let hold else { return }
        noSeeTask = Task { [weak self] in
            try? await Task.sleep(for: hold)
            guard !Task.isCancelled else { return }
            self?.noSee = nil
        }
    }
    func dismissNoSee() { noSeeTask?.cancel(); noSee = nil }

    func reset() {
        dismissNoSee()
        callEnded()
        entries = []
        page = 0
        selectedItem = nil
        doneSteps = [:]
        pendingItems = [:]
        latestFrames = []
    }

    // MARK: fixtures (screenshots of the 19 r03 states without a server)

    func load(recorded events: [ServerEvent], frames: [Data]) {
        reset()
        for e in events {
            if case .findStarted = e { latestFrames = frames.map { $0.base64EncodedString() } }
            apply(e)
        }
        risingTask?.cancel()
        if state == .rising { state = .half }
    }

    func force(_ s: SheetState, newFind id: String? = nil, undo: SheetState? = nil) {
        risingTask?.cancel()
        state = s
        newFind = id
        undoState = undo
    }
}

extension String {
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}

extension FindCard.Source {
    /// GenitaKit's Source has no public initializer (protocol types stay untouched); the wire shape builds one.
    static func make(title: String, url: String, domain: String) -> FindCard.Source? {
        let body = try? JSONSerialization.data(withJSONObject: ["title": title, "url": url, "domain": domain])
        return body.flatMap { try? JSONDecoder().decode(FindCard.Source.self, from: $0) }
    }
}

/// FT-NOSEE (Figma 59:2): "For kimchi fried rice · ✓ Eggs · ✓ Scallions · ✗ I don't see cooked rice · Move the camera if it's there."
/// The ✗ rows are only what the camera did not show; the card never says the thing is not there.
struct NoSeeCheck: Equatable {
    struct Row: Equatable, Identifiable {
        let name: String
        let seen: Bool
        var id: String { name }
    }
    var title: String
    var rows: [Row]
    var hint = "Move the camera if it’s there."

    /// Card height: padding 12 + title 16 + 8 + rows 20 (gap 4) + 8 + hint 16 + 12.
    var cardHeight: CGFloat { CGFloat(12 + 16 + 8 + 8 + 16 + 12 + 20 * rows.count + 4 * max(0, rows.count - 1)) }

    /// From a recipe card made with the camera on: `have` = in frame, `maybe`/`buy` = not seen. Nil when everything was seen.
    static func from(card: FindCard, maxRows: Int = 4) -> NoSeeCheck? {
        guard card.kind == .recipe else { return nil }
        let seen = card.items.filter { $0.tier == .have }
        let missing = card.items.filter { $0.tier == .maybe || $0.tier == .buy }
        guard !missing.isEmpty else { return nil }
        let missingShown = Array(missing.prefix(2))
        let seenShown = Array(seen.prefix(max(0, maxRows - missingShown.count)))
        let title = "For " + card.title.prefix(1).lowercased() + String(card.title.dropFirst())
        return NoSeeCheck(title: title, rows: seenShown.map { Row(name: $0.name.prefix(1).uppercased() + String($0.name.dropFirst()), seen: true) }
                          + missingShown.map { Row(name: $0.name, seen: false) })
    }
}
