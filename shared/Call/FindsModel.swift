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
}

@MainActor @Observable final class FindsModel {
    private(set) var entries: [FindEntry] = []
    var state: SheetState = .idle
    /// Index into `entries` of the card on screen.
    var page = 0
    /// Ingredient chip the user tapped (its camera box lights up; r03 #4/#5).
    var selectedItem: String?
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
    @ObservationIgnored private var risingTask: Task<Void, Never>?
    @ObservationIgnored private var toastTask: Task<Void, Never>?

    /// Wired by CallController.
    @ObservationIgnored var send: (ClientMessage) -> Void = { _ in }
    /// A card was made: keep the camera frames it came from on this phone (the server never stores them).
    @ObservationIgnored var persistFrames: (String, [Data]) -> Void = { _, _ in }
    /// The bookmark changed (POST /v1/finds/:id/save).
    @ObservationIgnored var saveChanged: (String, Bool) -> Void = { _, _ in }
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
            entries.append(FindEntry(id: s.findId, kind: s.kind, utteranceId: s.utteranceId, searchTitle: s.title, searchDetail: s.detail, frames: frames))
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
        update(f.id) { $0.saved.toggle() }
        saveChanged(f.id, !f.saved)
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
        guard let f = current else { return }
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

    func reset() {
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
