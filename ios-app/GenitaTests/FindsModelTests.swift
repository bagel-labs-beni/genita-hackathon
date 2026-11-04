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

    /// b16 (Chelsea 11/4 21:49): the searching sheet is sized to its content, no empty band under the skeleton rows:
    /// 32 top + 52 header + 18 + 2 × 64 rows + 14 between + 20 bottom + 34 home indicator.
    func testSearchingSheetFitsItsContent() {
        let content: CGFloat = 32 + 52 + 18 + 64 + 14 + 64
        let bottom: CGFloat = 20 + 34
        XCTAssertEqual(SheetState.searching.height, content + bottom)
        XCTAssertEqual(SheetState.rising.height, SheetState.searching.height, "rising starts where searching was")
        XCTAssertLessThan(SheetState.searching.height, SheetState.half.height)
    }

    /// b16: at the half sheet the product picture gives way so Open in browser sits above Save to Finds (364 pt page).
    func testHalfProductPictureLeavesRoomForThePill() {
        let titleRow: CGFloat = 54
        let picture = FindCardPage.halfProductPicture(titleRow: titleRow)
        let fixed: CGFloat = 40 + 44 + 8 + 8 + 8
        let below: CGFloat = 8 + 20 + 4 + 20 + 8 + 44
        XCTAssertLessThanOrEqual(fixed + titleRow + picture + below, 364, "pill above the CTA")
        XCTAssertEqual(FindCardPage.halfProductPicture(titleRow: 300), 56, "never smaller than 56")
        XCTAssertEqual(FindCardPage.halfProductPicture(titleRow: 0), 151, "never bigger than the square")
    }

    /// b16 "never show empty picture content": a picture that failed to load is dropped from the card, and the top
    /// pick moves to the next row that has one (none → no hero).
    func testBrokenPhotosAreDroppedAndTheTopPickMoves() throws {
        let json = #"{"id":"c","kind":"unknown","layout":"general","createdAt":"","eyebrow":"","title":"t","subtitle":"","items":[],"steps":[],"options":[],"why":[],"ask":[],"sources":[{"title":"A","url":"https://a.com","domain":"a.com","image":{"slot":"source-0","status":"ready","url":"/a"}},{"title":"B","url":"https://b.com","domain":"b.com","image":{"slot":"source-1","status":"ready","url":"/b"}}],"how":[],"hero":{"slot":"hero","status":"ready","url":"/a"}}"#
        let card = try JSONDecoder().decode(FindCard.self, from: Data(json.utf8))
        XCTAssertEqual(card.topPick?.index, 0)
        let hidden = card.hidingPhotos(["/a"])
        XCTAssertNil(hidden.sources[0].image)
        XCTAssertNil(hidden.hero, "the hero was the same broken picture")
        XCTAssertEqual(hidden.topPick?.index, 1, "the next row with a picture leads")
        XCTAssertEqual(card.topPick(usable: { $0.url != "/a" })?.index, 1)
        XCTAssertNil(card.hidingPhotos(["/a", "/b"]).topPick, "no picture left: no hero, rows only")
    }

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

    /// MO-05: a "+" chip adds the ingredient to this recipe's list (✓), a second tap takes it off; per find, local only.
    func testAddMissingIngredientToggles() {
        let m = FindsModel()
        XCTAssertFalse(m.isAdded("soy", in: "a"))
        m.toggleAdded("soy", in: "a")
        XCTAssertTrue(m.isAdded("soy", in: "a"))
        XCTAssertFalse(m.isAdded("soy", in: "b"), "another find keeps its own list")
        XCTAssertNil(m.selectedItem, "adding is not selecting: the camera boxes stay as they are")
        m.toggleAdded("soy", in: "a")
        XCTAssertFalse(m.isAdded("soy", in: "a"))
        m.toggleAdded("soy", in: "a")
        m.reset()
        XCTAssertFalse(m.isAdded("soy", in: "a"), "a reset (sign-out, fixtures) forgets the list")
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
        m.followsNewSearch = false
        m.apply(started("a")); m.apply(created("a")); m.force(.half)
        m.apply(started("b"))
        XCTAssertEqual(m.state, .half); XCTAssertEqual(m.page, 0)
        m.apply(created("b"))
        XCTAssertEqual(m.page, 0); XCTAssertNotNil(m.newFind)
        m.viewNewFind(); XCTAssertEqual(m.page, 1); XCTAssertNil(m.newFind)
    }

    /// P1-12: on the Mac the sheet stays open while she talks, so the search she just asked for takes the sheet.
    func testMacSheetFollowsTheNewSearchInsteadOfABannerOnly() async throws {
        let m = FindsModel()
        m.followsNewSearch = true
        m.apply(started("a")); m.apply(created("a")); m.force(.full)
        m.apply(started("b"))
        XCTAssertEqual(m.state, .searching, "the new search shows, not nothing until a banner")
        XCTAssertEqual(m.current?.id, "b")
        m.apply(created("b"))
        XCTAssertEqual(m.state, .rising); XCTAssertNil(m.newFind, "its card rises, no New · View banner")
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertEqual(m.state, .half); XCTAssertEqual(m.current?.id, "b")
        XCTAssertEqual(m.cardCount, 2, "the first card stays in the pager")
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

    /// ui-deferred: the PF-1 jacket card in the debug fixture showed the link card's suitcase illustration.
    /// Every fixture picture is bundled, and a product's picture is a product shot no other card reuses.
    func testFixturePicturesExistAndProductsDontBorrowAnotherCardsPicture() throws {
        let runs = FindsFixtureRun.load()
        XCTAssertFalse(runs.isEmpty, "finds-fixture.json is bundled")
        var usedBy: [String: Set<String>] = [:]
        for run in runs {
            for case let .findImage(i) in run.events {
                guard let url = i.url, url.hasPrefix("bundle:") else { continue }
                let name = String(url.dropFirst(7))
                XCTAssertNotNil(Bundle.main.url(forResource: name, withExtension: "jpg"), "\(name).jpg is bundled")
                usedBy[name, default: []].insert(run.kind.rawValue)
            }
        }
        let product = try XCTUnwrap(runs.first { $0.kind == .product })
        let shots = product.events.compactMap { e -> String? in
            guard case let .findImage(i) = e, i.slot.hasPrefix("product-"), let url = i.url else { return nil }
            return String(url.dropFirst(7))
        }
        XCTAssertEqual(shots, ["finds-product-jacket"], "the jacket card shows the jacket")
        for name in shots { XCTAssertEqual(usedBy[name], ["product"], "\(name) belongs to the product card only") }
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
    private let noMatch = #"{"type":"find.failed","findId":"a","reason":"search_failed","message":"Couldn’t find a good match. Try a color or a price."}"#

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
        XCTAssertEqual(lines.body, "Try a color or a price.")
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

    /// UI sweep 11/3 → r02: in the half sheet (scrolling off) the picture gives way so the 94 pt ingredient tile strip
    /// (64 pt photo tile + one name line) ends inside the 344 pt page under any title.
    func testHalfSheetPictureLeavesRoomForTheTiles() {
        XCTAssertEqual(FindCardPage.halfCameraHeight(titleRow: 53), 89, "one-line title + subtitle: 89 pt picture")
        let twoLines: CGFloat = 87 // "Kimchi fried rice / with tofu and egg" + subtitle
        let fixed: CGFloat = 108 // 40 top + 44 header + 3 × 8 spacing
        let used: CGFloat = fixed + twoLines + FindCardPage.halfCameraHeight(titleRow: twoLines) + FindCardPage.stripHeight
        XCTAssertLessThanOrEqual(used, 344, "tiles whole")
        XCTAssertEqual(FindCardPage.halfCameraHeight(titleRow: 70), 72, "72 while it fits")
        XCTAssertEqual(FindCardPage.halfCameraHeight(titleRow: 200), 0, "big text: no picture in the half sheet, tiles whole")
    }

    /// Visual cards contract v1: `ingredient-<item id>` lands on that item whatever its position; a later find.items
    /// without the photo keeps it; a bare number that names no id is the 1-based position.
    func testIngredientPhotoLandsByIdAndIsKept() throws {
        let m = FindsModel()
        m.apply(try ServerEvent.decode(#"{"type":"find.started","findId":"v","utteranceId":1,"kind":"recipe","title":"Kimchi fried rice","detail":""}"#))
        m.apply(try ServerEvent.decode(#"{"type":"find.created","findId":"v","card":{"id":"v","kind":"recipe","layout":"recipe","createdAt":"2026-11-04T12:00:00Z","eyebrow":"Recipe","title":"Kimchi fried rice","subtitle":"","items":[{"id":"ing-1","name":"cooked rice · 2 cups","tier":"buy","from":"recipe"},{"id":"ing-2","name":"kimchi · 1 cup","tier":"buy","from":"recipe"}],"steps":[{"text":"Fry the kimchi."}],"options":[],"why":[],"ask":[],"sources":[],"how":[]}}"#))
        m.apply(try ServerEvent.decode(#"{"type":"find.image","findId":"v","slot":"ingredient-ing-2","status":"ready","url":"/v1/finds/v/images/ingredient-ing-2"}"#))
        var card = try XCTUnwrap(m.entries.first?.card)
        XCTAssertEqual(card.cardLayout, .recipe)
        XCTAssertNil(card.items[0].image, "by id, not position")
        XCTAssertEqual(card.items[1].image?.url, "/v1/finds/v/images/ingredient-ing-2")
        XCTAssertEqual(card.items[1].tileName, "Kimchi")
        XCTAssertEqual(card.items[1].tileAmount, "1 cup")
        m.apply(try ServerEvent.decode(#"{"type":"find.items","findId":"v","items":[{"id":"ing-2","name":"kimchi · 1 cup","tier":"have","from":"both"},{"id":"ing-1","name":"cooked rice · 2 cups","tier":"buy","from":"recipe"}],"checking":false}"#))
        card = try XCTUnwrap(m.entries.first?.card)
        XCTAssertEqual(card.items.first { $0.id == "ing-2" }?.image?.status, .ready, "an update without the photo keeps it")
        m.apply(try ServerEvent.decode(#"{"type":"find.image","findId":"v","slot":"ingredient-2","status":"ready","url":"/x"}"#))
        card = try XCTUnwrap(m.entries.first?.card)
        XCTAssertEqual(card.items[1].image?.url, "/x", "a bare number that names no id: 1-based position")
    }

    /// r02: the layout hint picks the card; an old card (no `layout`) lays out by `kind` as before.
    func testCardLayoutFromHintOrKind() throws {
        func card(_ kind: String, layout: String?, sources: Int = 1, steps: Int = 1) throws -> FindCard {
            let src = (0..<sources).map { #"{"title":"T\#($0)","url":"https://a.com/\#($0)","domain":"a.com"}"# }.joined(separator: ",")
            let st = (0..<steps).map { #"{"text":"Step \#($0)"}"# }.joined(separator: ",")
            let l = layout.map { #","layout":"\#($0)""# } ?? ""
            let json = #"{"id":"c","kind":"\#(kind)"\#(l),"createdAt":"","eyebrow":"","title":"t","subtitle":"","items":[],"steps":[\#(st)],"options":[],"why":[],"ask":[],"sources":[\#(src)],"how":[]}"#
            return try JSONDecoder().decode(FindCard.self, from: Data(json.utf8))
        }
        XCTAssertEqual(try card("answer", layout: "place").cardLayout, .place)
        XCTAssertEqual(try card("answer", layout: "how-to").cardLayout, .howTo)
        XCTAssertEqual(try card("answer", layout: "general").cardLayout, .general)
        XCTAssertEqual(try card("answer", layout: nil).cardLayout, .general, "old server: unknown kind → r01 rows")
        XCTAssertEqual(try card("link", layout: "news").cardLayout, .general, "a layout this build doesn't know → by kind")
        XCTAssertEqual(try card("answer", layout: "place", sources: 0).cardLayout, .general, "place with no places → rows")
        XCTAssertEqual(try card("answer", layout: "how-to", steps: 0).cardLayout, .general, "how-to with no steps → rows")
        XCTAssertEqual(try card("recipe", layout: nil).cardLayout, .recipe)
        XCTAssertEqual(try card("outfit", layout: "general").cardLayout, .outfit, "outfit keeps its layout")
    }
}
