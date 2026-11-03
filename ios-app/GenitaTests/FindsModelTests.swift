import XCTest
@testable import Genita

/// F10-U-SHEET · Sheet rules from the r03 state map, driven by protocol events (PROTOCOL.md "Finds").
@MainActor final class FindsModelTests: XCTestCase {
    private func card(_ id: String, kind: FindKind = .recipe, items: [FindItem] = []) -> FindCard {
        try! JSONDecoder().decode(FindCard.self, from: Data("""
        {"id":"\(id)","kind":"\(kind.rawValue)","createdAt":"2026-11-02T10:00:00Z","eyebrow":"From your fridge","title":"Kimchi fried rice",
         "subtitle":"About 15 min","items":[],"steps":[{"text":"Fry it."}],"options":[],"why":[],"ask":["Spicy?"],"sources":[],"how":[]}
        """.utf8))
    }
    private func started(_ id: String) -> ServerEvent {
        try! ServerEvent.decode(#"{"type":"find.started","findId":"\#(id)","utteranceId":1,"kind":"recipe","title":"Looking at your fridge","detail":"recipes"}"#)
    }
    private func created(_ id: String) -> ServerEvent { .findCreated(.init(findId: id, card: card(id))) }

    func testSearchingThenRisingThenHalf() async throws {
        let m = FindsModel()
        m.latestFrames = [Data([0xff, 0xd8]).base64EncodedString()]
        m.apply(started("a"))
        XCTAssertEqual(m.state, .searching)
        XCTAssertEqual(m.entries.first?.frames.count, 1, "the question's frames stay with the find")
        m.apply(created("a"))
        XCTAssertEqual(m.state, .rising, "text first, the sheet rises")
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertEqual(m.state, .half)
    }

    func testFoldAndCloseRules() {
        let m = FindsModel()
        m.apply(started("a")); m.apply(created("a")); m.force(.half)
        XCTAssertTrue(m.faceTapped()); XCTAssertEqual(m.state, .peek, "face tap folds, never closes")
        m.tapPeek(); XCTAssertEqual(m.state, .half)
        m.dragEnded(translation: 400, velocity: 3000); XCTAssertEqual(m.state, .peek, "a hard flick still moves one step")
        m.dragEnded(translation: 80, velocity: 0); XCTAssertEqual(m.state, .dismissed, "second swipe down closes")
        m.undo(); XCTAssertEqual(m.state, .peek, "Undo restores")
        m.tapPeek(); m.dragEnded(translation: -80, velocity: 0); XCTAssertEqual(m.state, .full)
        m.pipTapped(); XCTAssertEqual(m.state, .half)
        m.close(); XCTAssertEqual(m.state, .dismissed)
    }

    func testUserTalkingFoldsHalfButNotFullOrTouching() {
        let m = FindsModel()
        m.apply(started("a")); m.apply(created("a")); m.force(.half)
        m.touching = true; m.userStartedTalking(); XCTAssertEqual(m.state, .half)
        m.touching = false; m.userStartedTalking(); XCTAssertEqual(m.state, .peek)
        m.force(.full); m.userStartedTalking(); XCTAssertEqual(m.state, .full)
    }

    func testNewResultDoesNotTakeTheCardYouRead() {
        let m = FindsModel()
        m.apply(started("a")); m.apply(created("a")); m.force(.half)
        m.apply(started("b"))
        XCTAssertEqual(m.state, .half); XCTAssertEqual(m.page, 0)
        m.apply(created("b"))
        XCTAssertEqual(m.page, 0); XCTAssertNotNil(m.newFind)
        m.viewNewFind(); XCTAssertEqual(m.page, 1); XCTAssertNil(m.newFind)
    }

    func testItemsAndImagesUpdateTheCard() throws {
        let m = FindsModel()
        m.apply(started("a")); m.apply(created("a"))
        let items = try ServerEvent.decode(#"{"type":"find.items","findId":"a","checking":false,"subtitle":"About 15 min · You have 1, need rice","status":"Need rice","items":[{"id":"i1","name":"eggs","tier":"have","from":"camera","box":{"x1":0.1,"y1":0.1,"x2":0.2,"y2":0.2}},{"id":"i2","name":"rice","tier":"buy","from":"recipe"}]}"#)
        m.apply(items)
        XCTAssertEqual(m.current?.card?.items.map(\.tier), [.have, .buy])
        XCTAssertEqual(m.current?.card?.status, "Need rice")
        XCTAssertFalse(m.current?.checking ?? true)
        m.apply(try ServerEvent.decode(#"{"type":"find.image","findId":"a","slot":"step-1","status":"ready","url":"/v1/finds/a/images/step-1"}"#))
        XCTAssertEqual(m.current?.card?.steps.first?.image?.url, "/v1/finds/a/images/step-1")
    }

    func testReopenedRecipeSubtitleUsesPastTense() {
        XCTAssertEqual(
            FindCardPage.reopenedSubtitle("About 15 min · You have 4, need cooked rice"),
            "About 15 min · You had 4, needed cooked rice"
        )
        XCTAssertEqual(
            FindCardPage.reopenedSubtitle("About 15 min · You have 4, nothing to buy"),
            "About 15 min · You had 4, nothing to buy"
        )
        // #215 short line
        XCTAssertEqual(FindCardPage.reopenedSubtitle("15 min · Have 6 · Need soy sauce"), "15 min · Had 6 · Needed soy sauce")
        XCTAssertEqual(FindCardPage.reopenedSubtitle("15 min · Need gochujang and scallions"), "15 min · Needed gochujang and scallions")
        XCTAssertEqual(FindCardPage.reopenedSubtitle("Have 2 · Nothing to buy"), "Had 2 · Nothing to buy")
    }

    func testConfirmStopAndAskSendTheRightMessages() {
        let m = FindsModel()
        var sent: [ClientMessage] = []
        m.send = { sent.append($0) }
        m.apply(started("a"))
        m.stop()
        XCTAssertEqual(sent.last, .findStop(findId: "a")); XCTAssertEqual(m.state, .idle)
        m.apply(created("a")); m.force(.half)
        m.confirm(FindItem(id: "i2", name: "kimchi", tier: .maybe, from: .both), yes: true)
        XCTAssertEqual(sent.last, .findConfirm(.init(findId: "a", itemId: "i2", yes: true)))
        m.ask("Spicy?")
        XCTAssertEqual(sent.last, .text(.init(text: "Spicy?", frames: nil, findId: "a")))
    }

    func testUnclearFailureStaysOnTheSearchingLine() throws {
        let m = FindsModel()
        m.apply(started("a"))
        m.apply(try ServerEvent.decode(#"{"type":"find.failed","findId":"a","reason":"unclear","message":"Show me again?"}"#))
        XCTAssertEqual(m.state, .searching)
        XCTAssertEqual(m.current?.failed?.reason, .unclear)
    }

    func testAskIsOffWhileInterpreting() {
        let m = FindsModel()
        var sent: [ClientMessage] = []
        m.send = { sent.append($0) }
        m.apply(started("a")); m.apply(created("a")); m.force(.half)
        m.interpreting = true
        m.ask("Spicy?")
        XCTAssertTrue(sent.isEmpty, "a card question would be translated to the other person")
        m.interpreting = false
        m.ask("Spicy?")
        XCTAssertEqual(sent.count, 1)
    }

    func testBookmarkRevertsWhenTheServerSaveFails() async throws {
        let m = FindsModel()
        m.apply(started("a")); m.apply(created("a")); m.force(.half)
        m.saveRemote = { _, _ in false }
        m.toggleSave()
        XCTAssertEqual(m.current?.saved, true, "shows at once")
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(m.current?.saved, false, "server said no: back to unsaved")
        var calls: [(String, Bool)] = []
        m.saveRemote = { id, saved in calls.append((id, saved)); return true }
        m.toggleSave()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(m.current?.saved, true)
        XCTAssertEqual(calls.first?.0, "a"); XCTAssertEqual(calls.first?.1, true)
    }

    // MARK: PF-1 product search (#120)

    /// The server's own sample (shared/protocol-samples/server/find.created.product.json), the same file GenitaKit decodes.
    private func productCreated() throws -> ServerEvent {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("shared/protocol-samples/server/find.created.product.json"))
        return try ServerEvent.decode(String(decoding: data, as: UTF8.self))
    }

    func testProductCardDecodesWithOptionalPrice() throws {
        let m = FindsModel()
        m.apply(started("4c2d9b10-7e3a-4f61-9a25-0d8e7f6a5b43"))
        m.apply(try productCreated())
        let card = try XCTUnwrap(m.current?.card)
        XCTAssertEqual(card.kind, .product)
        XCTAssertEqual(card.products?.map(\.store), ["Northline", "Field & Co."])
        XCTAssertEqual(card.products?.first?.price, "$68")
        XCTAssertNil(card.products?.last?.price, "no price on the page: the card says Price on site")
        XCTAssertEqual(card.evidence?.style, "Clean, minimal clothes. Understated colors.")
    }

    func testProductImageSlotsLandOnTheProducts() throws {
        let m = FindsModel()
        let id = "4c2d9b10-7e3a-4f61-9a25-0d8e7f6a5b43"
        m.apply(started(id)); m.apply(try productCreated())
        m.apply(try ServerEvent.decode(#"{"type":"find.image","findId":"\#(id)","slot":"product-2","status":"ready","url":"/v1/finds/\#(id)/images/product-2"}"#))
        m.apply(try ServerEvent.decode(#"{"type":"find.image","findId":"\#(id)","slot":"product-1","status":"failed"}"#))
        let products = try XCTUnwrap(m.current?.card?.products)
        XCTAssertEqual(products[1].image?.status, .ready)
        XCTAssertEqual(products[1].image?.url, "/v1/finds/\(id)/images/product-2")
        XCTAssertEqual(products[0].image?.status, .failed, "a failed picture becomes the calm placeholder, not a hole")
    }

    func testProductImageSlotOutOfRangeIsIgnored() throws {
        let m = FindsModel()
        let id = "4c2d9b10-7e3a-4f61-9a25-0d8e7f6a5b43"
        m.apply(started(id)); m.apply(try productCreated())
        let before = m.current?.card
        m.apply(try ServerEvent.decode(#"{"type":"find.image","findId":"\#(id)","slot":"product-3","status":"ready","url":"/x"}"#))
        XCTAssertEqual(m.current?.card, before)
    }

    func testProductRowSaysProductsAndLinkCount() throws {
        let m = FindsModel()
        m.apply(started("4c2d9b10-7e3a-4f61-9a25-0d8e7f6a5b43")); m.apply(try productCreated())
        let card = try XCTUnwrap(m.entries.first?.card)
        XCTAssertEqual(FindsRow(card: card).subtitle, "Products · 2 links")
    }

    func testSavingAProductCardFlipsTheCTAStateAndPostsOnce() async throws {
        let m = FindsModel()
        let id = "4c2d9b10-7e3a-4f61-9a25-0d8e7f6a5b43"
        var calls: [(String, Bool)] = []
        m.saveRemote = { id, saved in calls.append((id, saved)); return true }
        m.apply(started(id)); m.apply(try productCreated()); m.force(.full)
        XCTAssertEqual(m.current?.saved, false, "Save to Finds")
        m.toggleSave()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(m.current?.saved, true, "Open Finds")
        XCTAssertEqual(calls.count, 1); XCTAssertEqual(calls.first?.0, id); XCTAssertEqual(calls.first?.1, true)
    }

    private func productStarted(_ id: String) -> ServerEvent {
        try! ServerEvent.decode(#"{"type":"find.started","findId":"\#(id)","utteranceId":1,"kind":"product","title":"Finding 2 for your style…","detail":"Jacket"}"#)
    }
    private let noMatch = #"{"type":"find.failed","findId":"a","reason":"search_failed","message":"Couldn’t find a good match. Try a color or a price, or ask me again."}"#

    func testNoMatchFailureSplitsTitleAndBodyAndRetryAsksTheSameQuestion() throws {
        let m = FindsModel()
        var sent: [ClientMessage] = []
        m.send = { sent.append($0) }
        m.latestQuestion = "Jin, can we look for a jacket for this weekend?"
        m.apply(productStarted("a"))
        m.latestQuestion = "Thanks"   // said while it searched: not what Retry asks
        m.apply(try ServerEvent.decode(noMatch))
        let lines = try XCTUnwrap(m.current?.failureLines)
        XCTAssertEqual(lines.title, "Couldn’t find a good match")
        XCTAssertEqual(lines.body, "Try a color or a price, or ask me again.")
        XCTAssertEqual(m.state, .searching, "stays the collapsed sheet")
        XCTAssertTrue(m.current?.canRetry == true)
        m.retry()
        XCTAssertEqual(sent.last, .text(.init(text: "Jin, can we look for a jacket for this weekend?", frames: nil)))
        XCTAssertEqual(m.state, .idle)
    }

    func testRetryIsProductOnlyAndOffWhileInterpreting() throws {
        let m = FindsModel()
        var sent: [ClientMessage] = []
        m.send = { sent.append($0) }
        m.latestQuestion = "What can I make?"
        m.apply(started("a"))   // recipe: its camera frames are gone
        m.apply(try ServerEvent.decode(noMatch))
        XCTAssertFalse(m.current?.canRetry ?? true)
        m.retry(); XCTAssertTrue(sent.isEmpty)

        let p = FindsModel()
        p.send = { sent.append($0) }
        p.latestQuestion = "a jacket"
        p.apply(productStarted("a")); p.apply(try ServerEvent.decode(noMatch))
        p.interpreting = true
        p.retry(); XCTAssertTrue(sent.isEmpty, "interpretation would translate it to the other person")
    }

    /// IC-4: the unclear failure is the dark card, "Look again" drops it and the call goes on; other failures never show the card.
    func testLookAgainClosesTheUnclearCardOnly() throws {
        let m = FindsModel()
        m.apply(started("a"))
        m.apply(try ServerEvent.decode(#"{"type":"find.failed","findId":"a","reason":"unclear","message":"Show me again?"}"#))
        XCTAssertTrue(m.current?.isUnclear ?? false)
        m.lookAgain()
        XCTAssertEqual(m.state, .idle)

        let n = FindsModel()
        n.apply(started("b"))
        n.apply(try ServerEvent.decode(#"{"type":"find.failed","findId":"b","reason":"search_failed","message":"x"}"#))
        XCTAssertFalse(n.current?.isUnclear ?? true)
        n.lookAgain()
        XCTAssertEqual(n.state, .searching, "only IC-4 is dismissed by Look again")
    }

    func testUnclearFailureHasNoRetry() throws {
        let m = FindsModel()
        m.apply(started("a"))
        m.apply(try ServerEvent.decode(#"{"type":"find.failed","findId":"a","reason":"unclear","message":"Show me again?"}"#))
        XCTAssertEqual(m.current?.failureLines?.title, "I can’t see it clearly")
        XCTAssertEqual(m.current?.failureLines?.body, "Show me again?")
        XCTAssertFalse(m.current?.canRetry ?? true)
    }

    func testTokenSubjectSeparatesAccounts() {
        func jwt(_ sub: String) -> String {
            let body = Data(#"{"sub":"\#(sub)"}"#.utf8).base64EncodedString().replacingOccurrences(of: "=", with: "")
            return "eyJhbGciOiJIUzI1NiJ9.\(body).sig"
        }
        XCTAssertEqual(CallController.tokenSubject(jwt("user-a")), "user-a")
        XCTAssertNotEqual(CallController.tokenSubject(jwt("user-a")), CallController.tokenSubject(jwt("user-b")))
        XCTAssertEqual(CallController.tokenSubject("shared-dev-token"), "dev")
        XCTAssertNil(CallController.tokenSubject(nil))
    }

    // FT-NOSEE: the card names only what the camera did not show, never a guess, and goes by itself
    func testNoSeeCheckFromRecipeCard() {
        func item(_ id: String, _ name: String, _ tier: FindTier) -> FindItem {
            try! JSONDecoder().decode(FindItem.self, from: Data(#"{"id":"\#(id)","name":"\#(name)","tier":"\#(tier.rawValue)","from":"recipe"}"#.utf8))
        }
        var c = card("a")
        c.items = [item("1", "eggs", .have), item("2", "scallions", .have), item("3", "cooked rice", .buy), item("4", "kimchi", .maybe), item("5", "oil", .buy)]
        let check = NoSeeCheck.from(card: c)
        XCTAssertEqual(check?.title, "For kimchi fried rice")
        XCTAssertEqual(check?.rows.map(\.name), ["Eggs", "Scallions", "cooked rice", "kimchi"])
        XCTAssertEqual(check?.rows.map(\.seen), [true, true, false, false])
        XCTAssertEqual(check?.hint, "Move the camera if it’s there.")
        c.items = [item("1", "eggs", .have)]
        XCTAssertNil(NoSeeCheck.from(card: c), "everything seen: no card")
        c.items = [item("3", "cooked rice", .buy)]; c.kind = .outfit
        XCTAssertNil(NoSeeCheck.from(card: c), "recipes only")
    }

    func testNoSeeCardLeavesByItselfOrOnDismiss() async throws {
        let m = FindsModel()
        let check = NoSeeCheck(title: "For x", rows: [.init(name: "rice", seen: false)])
        m.showNoSee(check, hold: .milliseconds(80))
        XCTAssertEqual(m.noSee, check)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertNil(m.noSee, "auto-hides")
        m.showNoSee(check, hold: nil)
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertNotNil(m.noSee, "no hold = stays")
        m.dismissNoSee(); XCTAssertNil(m.noSee)
    }

    func testStatusLineShortensByWholeWordsOnly() {
        XCTAssertEqual(OneLineText.afterDot("Light jacket · checking 2 shops"), ["Checking 2 shops"])
        XCTAssertEqual(OneLineText.afterDot("Finding 2 for your style…"), [])
        let opts = OneLineText.options("Couldn’t find a good match", [])
        XCTAssertEqual(opts.first, "Couldn’t find a good match")
        XCTAssertEqual(Array(opts.dropFirst()), ["Couldn’t find a good…", "Couldn’t find a…", "Couldn’t find…", "Couldn’t…"])
        for o in opts { XCTAssertTrue(o.replacingOccurrences(of: "…", with: "").split(separator: " ").allSatisfy { "Couldn’t find a good match".split(separator: " ").contains($0) }, "no cut word: \(o)") }
    }

    /// #214: the PF-1 status pill follows the sheet — On it… → the card's line → Saved → Nothing I'd pick; not for recipes.
    func testProductPillFollowsTheSheet() async throws {
        let id = "4c2d9b10-7e3a-4f61-9a25-0d8e7f6a5b43"
        let m = FindsModel()
        m.saveRemote = { _, _ in true }
        m.apply(productStarted(id))
        XCTAssertEqual(m.pillText, "On it…")
        m.apply(try productCreated()); m.force(.half)
        XCTAssertEqual(m.pillText, "Found two for you.")
        XCTAssertLessThanOrEqual(m.pillText?.count ?? 99, 28, "one line on both devices (#211)")
        m.toggleSave()
        XCTAssertEqual(m.pillText, "Saved. They’re in Finds.")
        let f = FindsModel()
        f.apply(productStarted("a")); f.apply(try ServerEvent.decode(noMatch))
        XCTAssertEqual(f.pillText, "Nothing I’d pick for you.")
        // fridge (recipe) cards use the pill too since #122's follow-up; other kinds (link, outfit) keep the call cue
        let r = FindsModel()
        r.apply(started("r")); r.force(.half)
        XCTAssertEqual(r.pillText, "Let me take a look…", "a fridge search shows the short line until the server's pill arrives")
        let l = FindsModel()
        l.apply(try ServerEvent.decode(#"{"type":"find.started","findId":"l","utteranceId":1,"kind":"link","title":"Reading your link","detail":"example.com"}"#))
        XCTAssertNil(l.pillText, "link cards keep the ordinary call cue")
    }

    /// Fridge pill (#122 follow-up): the server's short line is shown; the long sentence is not.
    func testFridgePillUsesTheServerLineNotTheSentence() throws {
        let m = FindsModel()
        m.apply(started("r"))
        XCTAssertEqual(m.pillText, "Let me take a look…")
        m.apply(created("r")); m.force(.half)
        let items = try ServerEvent.decode(#"{"type":"find.items","findId":"r","items":[],"checking":true,"pill":"Egg, tofu +2"}"#)
        m.apply(items)
        XCTAssertEqual(m.pillText, "Egg, tofu +2")
        m.apply(try ServerEvent.decode(#"{"type":"find.items","findId":"r","items":[],"checking":false}"#))
        XCTAssertEqual(m.pillText, "Egg, tofu +2", "a later update without a pill keeps it")
    }

    /// UI sweep 11/3: in the half sheet (scrolling off) a two-line recipe title cut the ingredient chips in half.
    /// The picture gives way: title row + picture ≤ 192 pt, so the 44 pt chip row ends inside the 344 pt page.
    func testHalfSheetPictureLeavesRoomForTheChips() {
        XCTAssertEqual(FindCardPage.halfCameraHeight(titleRow: 53), 132, "one-line title: r03 picture, unchanged")
        let twoLines: CGFloat = 87 // "Kimchi fried rice / with tofu and egg" + subtitle
        XCTAssertLessThanOrEqual(40 + 44 + 3 * 8 + twoLines + FindCardPage.halfCameraHeight(titleRow: twoLines) + 44, 344, "chips whole")
        XCTAssertEqual(FindCardPage.halfCameraHeight(titleRow: 200), 88, "never smaller than 88")
    }
}
