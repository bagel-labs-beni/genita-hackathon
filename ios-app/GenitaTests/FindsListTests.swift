import XCTest
@testable import Genita

/// F10-U-FINDS · The Finds tab's list model: grouping and row text as the r03 board draws them, delete + Undo, pinning.
@MainActor final class FindsListTests: XCTestCase {
    private let utc: Calendar = { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "UTC")!; return c }()
    private let now = ISO8601DateFormatter().date(from: "2026-11-02T12:00:00Z")!

    private func card(_ id: String, _ kind: FindKind = .recipe, title: String = "Kimchi fried rice", at: String = "2026-11-02T09:00:00Z", saved: Bool? = nil,
                      items: [FindItem] = [], options: [FindCard.Option] = [], opened: Bool? = nil, status: String? = nil) -> FindCard {
        FindCard(id: id, kind: kind, createdAt: at, eyebrow: "From your fridge", title: title, subtitle: "", status: status, say: nil, hero: nil, camera: nil, items: items,
                 steps: [], options: options, why: [], ask: [], sources: [], how: [], page: opened.map { .init(url: "https://example.com", opened: $0) }, saved: saved)
    }
    private func item(_ name: String, _ tier: FindTier, optional: Bool? = nil) -> FindItem { FindItem(id: name, name: name, tier: tier, from: .recipe, optional: optional) }

    func testSectionsSavedFirstThenDaysNewestFirst() {
        let cards = [
            card("yesterday-1", title: "Late ramen", at: "2026-11-01T20:00:00Z"),
            card("today-old", title: "Outfit", at: "2026-11-02T08:00:00Z"),
            card("pinned", title: "Pinned rice", at: "2026-10-20T08:00:00Z", saved: true),
            card("today-new", title: "Link", at: "2026-11-02T11:00:00Z"),
            card("older", title: "Old", at: "2026-10-30T11:00:00Z"),
        ]
        let sections = FindsListModel.sections(cards, now: now, calendar: utc)
        XCTAssertEqual(sections.map(\.title), ["Saved", "From today’s call", "Yesterday", "Oct 30"])
        XCTAssertEqual(sections[0].rows.map(\.id), ["pinned"], "a saved card is not repeated under its day")
        XCTAssertEqual(sections[1].rows.map(\.id), ["today-new", "today-old"], "newest first inside a day")
    }

    func testEmptyListHasNoSections() {
        XCTAssertTrue(FindsListModel.sections([], now: now, calendar: utc).isEmpty)
    }

    func testRowSubtitles() {
        XCTAssertEqual(FindsRow(card: card("a", items: [item("rice", .buy), item("egg", .have)])).subtitle, "Recipe · Needed rice")
        XCTAssertEqual(FindsRow(card: card("a", items: [item("rice", .buy), item("oil", .buy), item("salt", .buy)])).subtitle, "Recipe · Missing 3")
        XCTAssertEqual(FindsRow(card: card("a", items: [item("rice", .buy, optional: true)], status: "You have it all")).subtitle, "Recipe · You have it all", "optional items are not 'needed'")
        let opts = [FindCard.Option(label: "A", frame: 0, picked: true, box: nil), .init(label: "B", frame: 1, picked: false, box: nil)]
        XCTAssertEqual(FindsRow(card: card("b", .outfit, options: opts)).subtitle, "Outfit · 2 frames")
        XCTAssertEqual(FindsRow(card: card("b", .outfit, options: [opts[0]])).subtitle, "Outfit · 1 frame")
        XCTAssertEqual(FindsRow(card: card("c", .link, opened: false)).subtitle, "Your link · couldn’t open")
        XCTAssertEqual(FindsRow(card: card("c", .link, opened: true, status: "3 takeaways")).subtitle, "Your link · 3 takeaways")
    }

    func testDayTitles() {
        let day = { (s: String) in self.utc.startOfDay(for: ISO8601DateFormatter().date(from: s)!) }
        XCTAssertEqual(FindsListModel.dayTitle(day("2026-11-02T01:00:00Z"), now: now, calendar: utc), "Today")
        XCTAssertEqual(FindsListModel.dayTitle(day("2026-11-01T23:00:00Z"), now: now, calendar: utc), "Yesterday")
        XCTAssertEqual(FindsListModel.dayTitle(day("2025-12-24T10:00:00Z"), now: now, calendar: utc), "Dec 24, 2025")
    }

    // MARK: model with a fake server

    final class FakeAPI: FindsAPI, @unchecked Sendable {
        var cards: [FindCard] = []
        var failList = false, failDelete = false, failSave = false
        var log: [String] = []
        func list() async throws -> [FindCard] { if failList { throw URLError(.notConnectedToInternet) }; return cards }
        func delete(_ id: String) async throws { log.append("delete \(id)"); if failDelete { throw URLError(.badServerResponse) } }
        func restore(_ id: String) async throws { log.append("restore \(id)") }
        func setSaved(_ id: String, _ saved: Bool) async throws { log.append("save \(id) \(saved)"); if failSave { throw URLError(.badServerResponse) } }
    }

    private func model(_ api: FakeAPI) -> FindsListModel {
        let m = FindsListModel(api: api)
        m.now = { self.now }; m.calendar = utc; m.purge = { _ in }; m.undoWindow = .milliseconds(150)
        return m
    }

    func testLoadStatesAndEmpty() async {
        let api = FakeAPI()
        let m = model(api)
        XCTAssertEqual(m.phase, .loading)
        await m.load()
        XCTAssertEqual(m.phase, .loaded); XCTAssertTrue(m.isEmpty, "F0: nothing here yet")
        api.cards = [card("a")]
        await m.load()
        XCTAssertFalse(m.isEmpty); XCTAssertEqual(m.count, 1)
        api.failList = true
        await m.load()
        XCTAssertEqual(m.phase, .loaded, "a failed refresh keeps what is on screen")
        let fresh = model(api)
        await fresh.load()
        XCTAssertEqual(fresh.phase, .failed, "first load failing shows the retry state")
    }

    func testDeleteThenUndoRestoresTheRow() async {
        let api = FakeAPI(); api.cards = [card("a"), card("b", at: "2026-11-02T10:00:00Z")]
        let m = model(api)
        await m.load()
        await m.delete("a")
        XCTAssertEqual(m.cards.map(\.id), ["b"]); XCTAssertEqual(m.removed?.id, "a")
        await m.undoDelete()
        XCTAssertEqual(Set(m.cards.map(\.id)), ["a", "b"]); XCTAssertNil(m.removed)
        XCTAssertEqual(api.log, ["delete a", "restore a"])
    }

    func testUndoToastClosesAfterTheWindowAndPurgesFrames() async throws {
        let api = FakeAPI(); api.cards = [card("a")]
        let m = model(api)
        var purged: [String] = []
        m.purge = { purged.append($0) }
        await m.load()
        await m.delete("a")
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertNil(m.removed); XCTAssertEqual(purged, ["a"])
    }

    func testFailedDeleteBringsTheRowBack() async {
        let api = FakeAPI(); api.cards = [card("a")]; api.failDelete = true
        let m = model(api)
        await m.load()
        await m.delete("a")
        XCTAssertEqual(m.cards.map(\.id), ["a"]); XCTAssertNil(m.removed)
    }

    func testPinMovesToSavedAndFailureRevertsIt() async {
        let api = FakeAPI(); api.cards = [card("a")]
        let m = model(api)
        await m.load()
        await m.toggleSaved("a")
        XCTAssertEqual(m.sections.first?.title, "Saved"); XCTAssertEqual(api.log, ["save a true"])
        api.failSave = true
        await m.toggleSaved("a")
        XCTAssertEqual(m.sections.first?.title, "Saved", "failed unpin stays pinned")
    }

    // MARK: REST + local frames

    func testRequestsCarryTokenAndOwner() {
        let api = HTTPFindsAPI(endpoint: CallEndpoint(url: URL(string: "wss://genita.example.com:8443/v1/session")!, token: "tok"), user: "install-1")
        let r = api.request("POST", "/v1/finds/abc/save", body: ["saved": true])
        XCTAssertEqual(r.url?.absoluteString, "https://genita.example.com:8443/v1/finds/abc/save")
        XCTAssertEqual(r.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        XCTAssertEqual(r.value(forHTTPHeaderField: "X-Genita-User"), "install-1")
        XCTAssertEqual(r.httpMethod, "POST")
        XCTAssertEqual(String(data: r.httpBody ?? Data(), encoding: .utf8), #"{"saved":true}"#)
        XCTAssertEqual(HTTPFindsAPI(endpoint: CallEndpoint(url: URL(string: "ws://127.0.0.1:8787/v1/session")!, token: nil), user: "u").request("GET", "/v1/finds").url?.absoluteString, "http://127.0.0.1:8787/v1/finds")
    }

    func testFrameStoreRoundTripAndRemove() {
        let old = FindFrameStore.directory
        FindFrameStore.directory = FileManager.default.temporaryDirectory.appending(path: "frames-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: FindFrameStore.directory); FindFrameStore.directory = old }
        FindFrameStore.save(id: "abcdef12-0000", frames: [Data([1]), Data([2, 2])])
        XCTAssertEqual(FindFrameStore.load(id: "abcdef12-0000"), [Data([1]), Data([2, 2])])
        FindFrameStore.save(id: "../escape", frames: [Data([9])])
        XCTAssertTrue(FindFrameStore.load(id: "../escape").isEmpty, "ids are not paths")
        FindFrameStore.remove(id: "abcdef12-0000")
        XCTAssertTrue(FindFrameStore.load(id: "abcdef12-0000").isEmpty)
    }

    // MARK: reopening a card into the sheet

    func testOpenSavedPutsTheCardInTheSheetAndCloseGoesBackToTheList() {
        let sheet = FindsModel()
        let c = card("reopen-1234")
        sheet.openSaved(c, frames: [Data([1])])
        XCTAssertEqual(sheet.state, .half); XCTAssertEqual(sheet.current?.id, "reopen-1234"); XCTAssertEqual(sheet.current?.reopened, true)
        XCTAssertEqual(sheet.current?.frames.count, 1, "the camera moment comes from the frames the phone kept")
        sheet.dragEnded(translation: 80, velocity: 0)
        XCTAssertEqual(sheet.state, .idle, "swipe down on a reopened card returns to the list, no Undo toast")
        sheet.openSaved(c, frames: [])
        XCTAssertEqual(sheet.entries.count, 1, "the same card is not added twice")
        sheet.talkAboutThis()
        XCTAssertEqual(sheet.current?.reopened, false); XCTAssertEqual(sheet.state, .half, "the card stays up over the call")
    }

    func testSaveFromTheSheetIsReported() {
        let sheet = FindsModel()
        var seen: [(String, Bool)] = []
        sheet.saveChanged = { seen.append(($0, $1)) }
        sheet.openSaved(card("save-1234"), frames: [])
        sheet.toggleSave(); sheet.toggleSave()
        XCTAssertEqual(seen.map { "\($0.0) \($0.1)" }, ["save-1234 true", "save-1234 false"])
    }
}
