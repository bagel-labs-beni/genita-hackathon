import XCTest
import CoreImage
@testable import Genita

/// Finds audit 11/4 (AU-69, AU-70, AU-71, AU-72, AU-75): FD-01 / FD-02 paths the r03 tests didn't cover.
@MainActor final class FindsAuditTests: XCTestCase {
    private func card(_ id: String, kind: FindKind = .recipe, camera: Bool = false, hero: String? = nil) -> FindCard {
        let cam = camera ? #","camera":{"frame":0,"at":"2026-11-04T10:00:00Z","w":640,"h":480,"label":"Your camera · 10:00"}"# : ""
        let pic = hero.map { #","hero":{"slot":"hero","status":"\#($0)"}"# } ?? ""
        return try! JSONDecoder().decode(FindCard.self, from: Data("""
        {"id":"\(id)","kind":"\(kind.rawValue)","createdAt":"2026-11-04T10:00:00Z","eyebrow":"From your camera","title":"Card \(id)",
         "subtitle":"","items":[],"steps":[{"text":"Fry it."}],"options":[],"why":[],"ask":[],"sources":[],"how":[]\(cam)\(pic)}
        """.utf8))
    }
    private func started(_ id: String, kind: FindKind = .product) -> ServerEvent {
        try! ServerEvent.decode(#"{"type":"find.started","findId":"\#(id)","utteranceId":1,"kind":"\#(kind.rawValue)","title":"Looking","detail":"shops"}"#)
    }
    private func created(_ id: String, kind: FindKind = .product, camera: Bool = false, hero: String? = nil) -> ServerEvent {
        .findCreated(.init(findId: id, card: card(id, kind: kind, camera: camera, hero: hero)))
    }

    /// AU-69 · FD-02 step 3: the card is at half, the user says "Find a couple that match my style" — speech start folds
    /// it to peek, then find.started arrives. The refine search and its result must show, not hide behind the old peek.
    func testANewSearchFromPeekShowsTheSearchAndItsResult() async throws {
        let m = FindsModel()
        m.apply(started("a")); m.apply(created("a")); m.force(.half)
        m.userStartedTalking()
        XCTAssertEqual(m.state, .peek)
        m.apply(started("b"))
        XCTAssertEqual(m.state, .searching, "the searching sheet comes up for the refine")
        XCTAssertEqual(m.current?.id, "b")
        XCTAssertEqual(m.pillText, "On it…", "not the old card's line")
        m.apply(created("b"))
        XCTAssertEqual(m.state, .rising)
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertEqual(m.state, .half); XCTAssertEqual(m.current?.id, "b")
    }

    /// AU-69: a result that lands while the sheet is folded (search started while reading) takes the peek.
    func testAResultLandingInPeekTakesThePeek() {
        let m = FindsModel()
        m.apply(started("a")); m.apply(created("a")); m.force(.half)
        m.apply(started("b"))
        XCTAssertEqual(m.current?.id, "a", "reading at half: the card you read stays")
        XCTAssertEqual(m.pillText, "On it…", "the pill follows the newer search")
        m.force(.peek)
        m.apply(created("b"))
        XCTAssertEqual(m.state, .peek); XCTAssertEqual(m.current?.id, "b"); XCTAssertNil(m.newFind)
    }

    /// AU-70 · FD-01 step 5: "Talk about this on a call" tells the server which card.
    func testTalkAboutThisNamesTheCard() {
        let m = FindsModel()
        var sent: [ClientMessage] = []
        m.send = { sent.append($0) }
        m.openSaved(card("old-card-1"), frames: [])
        m.talkAboutThis()
        XCTAssertEqual(sent.last, .findFocus(findId: "old-card-1"))
        XCTAssertFalse(m.current?.reopened ?? true)
        let wire = try! JSONSerialization.jsonObject(with: JSONEncoder().encode(ClientMessage.findFocus(findId: "old-card-1"))) as! [String: String]
        XCTAssertEqual(wire, ["type": "find.focus", "findId": "old-card-1"])
    }

    /// AU-75: frames go with the find that used them, never with a later one; only cards that show frames keep them.
    func testCameraFramesAreNotReusedAndOnlyKeptForCardsThatShowThem() {
        let m = FindsModel()
        var kept: [String: Int] = [:]
        m.persistFrames = { id, frames in kept[id] = frames.count }
        m.latestFrames = [Data([0xff, 0xd8]).base64EncodedString()]
        m.apply(started("fridge", kind: .recipe))
        XCTAssertTrue(m.latestFrames.isEmpty, "the find took the frames")
        m.apply(created("fridge", kind: .recipe, camera: true))
        XCTAssertEqual(kept["fridge"], 1, "the fridge card shows its frame")
        // camera off, then a voice-only product search: no old frames attached or kept
        m.apply(started("boots"))
        XCTAssertEqual(m.entries.last?.frames.count, 0)
        m.apply(created("boots"))
        XCTAssertNil(kept["boots"])
        // a product search asked with the camera on keeps nothing either: its card shows no frame
        m.latestFrames = [Data([0xff, 0xd8]).base64EncodedString()]
        m.apply(started("shoes")); m.apply(created("shoes"))
        XCTAssertNil(kept["shoes"])
    }

    /// AU-75: account deletion takes that account's kept frames with it, and never another account's (Codex P1).
    func testRemoveAllDeletesOnlyThatAccountsFrames() throws {
        let saved = FindFrameStore.directory
        defer { FindFrameStore.directory = saved }
        FindFrameStore.directory = FileManager.default.temporaryDirectory.appending(path: "find-frames-\(UUID().uuidString)")
        FindFrameStore.save(id: "abcdef12-0001", frames: [Data([1]), Data([2])], owner: "acct-a")
        FindFrameStore.save(id: "abcdef12-0002", frames: [Data([3])], owner: "acct-b")
        // a frame saved before 11/4, loose in the folder with no owner
        try Data([9]).write(to: FindFrameStore.directory.appending(path: "abcdef12-0003-0.jpg"))
        XCTAssertEqual(FindFrameStore.load(id: "abcdef12-0001", owner: "acct-a").count, 2)
        XCTAssertEqual(FindFrameStore.load(id: "abcdef12-0003", owner: "acct-a").count, 1, "old loose frames still open")
        // and one of account B's, also loose
        try Data([8]).write(to: FindFrameStore.directory.appending(path: "abcdef12-0004-0.jpg"))
        FindFrameStore.removeAll(owner: "acct-a", ids: ["abcdef12-0001", "abcdef12-0003"])
        XCTAssertTrue(FindFrameStore.load(id: "abcdef12-0001", owner: "acct-a").isEmpty)
        XCTAssertTrue(FindFrameStore.load(id: "abcdef12-0003", owner: "acct-a").isEmpty, "its own loose frames go")
        XCTAssertEqual(FindFrameStore.load(id: "abcdef12-0002", owner: "acct-b").count, 1, "the other account keeps its frames")
        XCTAssertEqual(FindFrameStore.load(id: "abcdef12-0004", owner: "acct-b").count, 1, "and its loose ones (Codex r2)")
    }

    /// AU-62 / AU-72: the socket dropped mid-search. The new session never sends that result: the search fails with
    /// Retry (not "On it…" forever) and a picture still loading stops shimmering.
    func testInterruptedSearchFailsAndPendingPicturesStop() throws {
        let m = FindsModel()
        m.apply(started("done")); m.apply(created("done", hero: "pending")); m.force(.peek)
        m.latestQuestion = "Can we look for dark brown boots?"
        m.apply(started("boots"))
        XCTAssertEqual(m.state, .searching)
        m.interrupted()
        let boots = try XCTUnwrap(m.entries.first { $0.id == "boots" })
        XCTAssertEqual(boots.failed?.reason, .error)
        XCTAssertTrue(boots.canRetry, "Retry asks the same words again")
        XCTAssertEqual(m.pillText, "Nothing I’d pick for you.")
        XCTAssertEqual(m.entries.first { $0.id == "done" }?.card?.hero?.status, .failed)
        // reopening it from Finds takes the server's copy (its picture finished there)
        m.openSaved(card("done", kind: .product, hero: "ready"), frames: [])
        XCTAssertEqual(m.current?.card?.hero?.status, .ready)
    }

    /// AU-71 · FD-01 step 6: the pasted text's link is what goes to the server (its findUrl reads the same).
    func testFirstLinkInPastedText() {
        XCTAssertEqual(CallController.firstLink(in: "https://www.nytimes.com/2026/11/03/travel/carry-on.html"), "https://www.nytimes.com/2026/11/03/travel/carry-on.html")
        XCTAssertEqual(CallController.firstLink(in: "look at this: https://example.com/a?b=1."), "https://example.com/a?b=1")
        XCTAssertEqual(CallController.firstLink(in: "(HTTPS://Example.com/x)"), "HTTPS://Example.com/x")
        XCTAssertNil(CallController.firstLink(in: "example dot com"))
        XCTAssertNil(CallController.firstLink(in: ""))
    }

    /// AU-80 · F10-17: closing a failed or still-running search has nothing in Finds to undo: no "In Finds · Undo" toast.
    func testClosingACardlessSheetShowsNoUndoToast() {
        let m = FindsModel()
        var sent: [ClientMessage] = []
        m.send = { sent.append($0) }
        m.apply(started("a"))
        m.close()
        XCTAssertEqual(m.state, .idle, "no toast state")
        XCTAssertEqual(sent.last, .findStop(findId: "a"), "a running search is stopped")
        m.apply(started("b"))
        m.apply(.findFailed(.init(findId: "b", reason: .searchFailed, message: "Nothing that fits. Try again?")))
        sent = []
        m.close()
        XCTAssertEqual(m.state, .idle)
        XCTAssertTrue(sent.isEmpty, "a failed search needs no stop")
        // a card still closes with Undo
        m.apply(started("c")); m.apply(created("c")); m.force(.half)
        m.close()
        XCTAssertEqual(m.state, .dismissed)
        m.undo()
        XCTAssertEqual(m.state, .half)
    }

    /// AU-58 · D56: FT-NOSEE comes from the fridge card in a real call (it was fixture-only): closing the card shows
    /// what the camera didn't see; a card with everything in view, or without the camera, shows nothing.
    func testClosingAFridgeCardShowsWhatTheCameraDidntSee() throws {
        let m = FindsModel()
        let json = #"{"id":"r1","kind":"recipe","createdAt":"2026-11-04T10:00:00Z","eyebrow":"From your camera","title":"Kimchi fried rice","subtitle":"","items":[{"id":"i1","name":"eggs","tier":"have","from":"camera"},{"id":"i2","name":"cooked rice","tier":"buy","from":"recipe"}],"steps":[],"options":[],"why":[],"ask":[],"sources":[],"how":[],"camera":{"frame":0,"at":"2026-11-04T10:00:00Z","w":480,"h":854,"label":"Your camera · 10:00"}}"#
        let card = try JSONDecoder().decode(FindCard.self, from: Data(json.utf8))
        m.apply(started("r1", kind: .recipe)); m.apply(.findCreated(.init(findId: "r1", card: card))); m.force(.half)
        XCTAssertNil(m.noSee, "never over the sheet")
        m.close()
        XCTAssertEqual(m.noSee?.title, "For kimchi fried rice")
        XCTAssertEqual(m.noSee?.rows.map(\.seen), [true, false])
        XCTAssertEqual(m.noSee?.rows.last?.name, "cooked rice")
        // a product card never makes one
        let p = FindsModel()
        p.apply(started("p1")); p.apply(created("p1")); p.force(.half); p.close()
        XCTAssertNil(p.noSee)
    }

    /// Codex r3: an older Finds list (picture still pending) never takes back a picture the call already got.
    func testReopeningKeepsAPictureTheListDoesNotHaveYet() {
        let m = FindsModel()
        m.apply(started("a")); m.apply(created("a", hero: "pending")); m.force(.peek)
        m.apply(try! ServerEvent.decode(#"{"type":"find.image","findId":"a","slot":"hero","status":"ready","url":"/v1/finds/a/images/hero"}"#))
        XCTAssertEqual(m.current?.card?.hero?.status, .ready)
        m.openSaved(card("a", kind: .product, hero: "pending"), frames: [])
        XCTAssertEqual(m.current?.card?.hero?.status, .ready)
    }

    /// Codex r4: reopening a card this call made keeps what the call confirmed (an ingredient now "have"), not the list's older state.
    func testReopeningKeepsTheCallsConfirmedIngredients() throws {
        let m = FindsModel()
        m.apply(started("a", kind: .recipe)); m.apply(created("a", kind: .recipe)); m.force(.peek)
        m.apply(try ServerEvent.decode(#"{"type":"find.items","findId":"a","checking":false,"subtitle":"Have 1","status":"All set","items":[{"id":"i1","name":"kimchi","tier":"have","from":"both"}]}"#))
        var old = card("a", kind: .recipe)
        old.status = "1 to check"
        m.openSaved(old, frames: [])
        XCTAssertEqual(m.current?.card?.items.first?.tier, .have)
        XCTAssertEqual(m.current?.card?.status, "All set")
    }

    /// Codex r5: ingredients still "checking" when the call dropped take the server's finished result from the list.
    func testReopeningTakesTheListsResultForIngredientsStillChecking() throws {
        let m = FindsModel()
        m.apply(started("a", kind: .recipe)); m.apply(created("a", kind: .recipe)); m.force(.peek)
        m.apply(try ServerEvent.decode(#"{"type":"find.items","findId":"a","checking":true,"items":[{"id":"i1","name":"kimchi","tier":"checking","from":"camera"}]}"#))
        m.interrupted()
        var listed = card("a", kind: .recipe)
        listed.items = [FindItem(id: "i1", name: "kimchi", tier: .have, from: .camera)]
        m.openSaved(listed, frames: [])
        XCTAssertEqual(m.current?.card?.items.first?.tier, .have)
    }

    /// D59 · CW-01 DARK: the phone flags a frame too dark or too flat to see anything; a normal scene is not flagged.
    func testFrameQualityFlagsDarkAndFlatFramesOnly() throws {
        let rect = CGRect(x: 0, y: 0, width: 640, height: 360)
        let scene = CIFilter(name: "CICheckerboardGenerator", parameters: ["inputWidth": 20, "inputColor0": CIColor(red: 0.85, green: 0.85, blue: 0.85), "inputColor1": CIColor(red: 0.25, green: 0.25, blue: 0.25)])!.outputImage!.cropped(to: rect)
        XCTAssertFalse(FrameQuality.unclear(scene), "a busy, lit scene")
        let dark = scene.applyingFilter("CIExposureAdjust", parameters: ["inputEV": -4])
        XCTAssertTrue(FrameQuality.unclear(dark), "−4 EV")
        let flat = CIImage(color: CIColor(red: 0.5, green: 0.5, blue: 0.5)).cropped(to: rect)
        XCTAssertTrue(FrameQuality.unclear(flat), "nothing to make out")
        let wire = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ClientMessage.frames(.init(images: ["a"], unclear: true)))) as! [String: Any]
        XCTAssertEqual(wire["unclear"] as? Bool, true)
        let plain = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ClientMessage.frames(.init(images: ["a"])))) as! [String: Any]
        XCTAssertNil(plain["unclear"], "omitted when the frames are fine")
    }
}
