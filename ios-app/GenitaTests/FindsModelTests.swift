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
}
