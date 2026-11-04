import XCTest
@testable import Genita

/// F5-U-CAM · CAM-H: boxes from `observe.boxes` on the live preview — aspect-fill geometry, label side, 4 s fade, chip highlight.
@MainActor final class CameraBoxesTests: XCTestCase {
    private func event(find: String = "f1", w: Int = 480, h: Int = 854, _ items: [(String, NormBox)]) -> ServerEvent.ObserveBoxes {
        .init(findId: find, frame: 1, w: w, h: h, items: items.map { .init(label: $0.0, box: $0.1) })
    }
    private let egg = NormBox(x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4)
    private let tofu = NormBox(x1: 0.5, y1: 0.5, x2: 0.9, y2: 0.7)

    func testSameAspectMapsStraightOntoTheView() {
        let r = CameraBoxes.rect(egg, frame: CGSize(width: 480, height: 854), in: CGSize(width: 390, height: 693.875))
        XCTAssertEqual(r.minX, 39, accuracy: 0.01); XCTAssertEqual(r.minY, 138.775, accuracy: 0.01)
        XCTAssertEqual(r.width, 78, accuracy: 0.01); XCTAssertEqual(r.height, 138.775, accuracy: 0.01)
    }

    func testAspectFillCropsTheOverflowAndCentresIt() {
        // 480 × 854 frame in a 390 × 844 view: scale = max(0.8125, 0.9883) = 0.9883, width overflows by 84.6 pt, 42.3 pt per side
        let frame = CGSize(width: 480, height: 854), view = CGSize(width: 390, height: 844)
        let r = CameraBoxes.rect(NormBox(x1: 0, y1: 0, x2: 1, y2: 1), frame: frame, in: view)
        XCTAssertEqual(r.minX, -42.2, accuracy: 0.1); XCTAssertEqual(r.width, 474.4, accuracy: 0.1)
        XCTAssertEqual(r.minY, 0, accuracy: 0.01); XCTAssertEqual(r.height, 844, accuracy: 0.01)
        // a wide frame in a tall view crops left and right
        let wide = CameraBoxes.rect(NormBox(x1: 0.5, y1: 0, x2: 0.6, y2: 1), frame: CGSize(width: 1600, height: 900), in: CGSize(width: 400, height: 800))
        XCTAssertEqual(wide.midX, 400 * 0.5 + 0.05 * (1600 * (800.0 / 900)) , accuracy: 0.5, "scale 0.889: frame is 1422 wide, centred")
    }

    func testFrontCameraPreviewIsMirrored() {
        let plain = CameraBoxes.rect(egg, frame: CGSize(width: 100, height: 100), in: CGSize(width: 100, height: 100))
        let mirrored = CameraBoxes.rect(egg, frame: CGSize(width: 100, height: 100), in: CGSize(width: 100, height: 100), mirrored: true)
        XCTAssertEqual(plain.minX, 10, accuracy: 0.01); XCTAssertEqual(mirrored.minX, 70, accuracy: 0.01)
        XCTAssertEqual(plain.width, mirrored.width, accuracy: 0.01); XCTAssertEqual(plain.minY, mirrored.minY, accuracy: 0.01)
    }

    func testLabelAboveUnlessThereIsNoRoom() {
        XCTAssertTrue(CameraBoxes.labelAbove(CGRect(x: 0, y: 200, width: 50, height: 50), topInset: 100))
        XCTAssertFalse(CameraBoxes.labelAbove(CGRect(x: 0, y: 120, width: 50, height: 50), topInset: 100), "below the box when it is under the status area")
    }

    func testBatchesMergeAndNewBoxesPopInOrder() {
        let b = CameraBoxes()
        b.apply(event([("Tofu", tofu)]))
        XCTAssertTrue(b.visible); XCTAssertEqual(b.boxes.map(\.label), ["Tofu"]); XCTAssertEqual(b.boxes[0].order, 0)
        b.apply(event([("Egg", egg), ("Tofu", tofu), ("Milk", egg)]))
        XCTAssertEqual(b.boxes.map(\.label), ["Egg", "Tofu", "Milk"])
        XCTAssertEqual(b.boxes.map(\.order), [0, 0, 1], "Tofu was already on screen; Egg then Milk pop 60 ms apart")
        XCTAssertEqual(b.frameSize, CGSize(width: 480, height: 854))
    }

    func testAnotherFindStartsOver() {
        let b = CameraBoxes()
        b.apply(event(find: "f1", [("Tofu", tofu)])); b.highlight("tofu")
        b.apply(event(find: "f2", [("Beige trench", egg)]))
        XCTAssertEqual(b.boxes.map(\.label), ["Beige trench"]); XCTAssertNil(b.highlighted)
    }

    /// Nobody speaks: a batch fades at the hold's cap (12 s on a device; shortened here).
    func testBoxesFadeAtTheCapWhenNobodySpeaks() async throws {
        let b = CameraBoxes()
        b.hold = .init(minimum: 0.05, cap: 0.12)
        b.apply(event([("Egg", egg)]))
        XCTAssertTrue(b.visible); XCTAssertTrue(b.holding)
        try await Task.sleep(for: .milliseconds(350))
        XCTAssertFalse(b.visible, "faded"); XCTAssertFalse(b.holding); XCTAssertEqual(b.boxes.count, 1, "kept so a chip tap can bring it back")
        XCTAssertEqual(CameraBoxes().fadeAfter, .seconds(4), "a chip tap still shows them for the board's 4 s")
        XCTAssertEqual(CameraBoxes().hold, .init(minimum: 4, cap: 12, sentence: 6, afterSpeech: 0.6), "demo S3: up to 12 s when nobody speaks")
    }

    func testNewBatchRestartsTheClock() async throws {
        let b = CameraBoxes()
        b.hold = .init(minimum: 0.05, cap: 0.25)
        b.apply(event([("Egg", egg)]))
        try await Task.sleep(for: .milliseconds(150))
        b.apply(event([("Egg", egg), ("Tofu", tofu)]))
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertTrue(b.visible, "300 ms after the first batch but 150 ms after the second")
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertFalse(b.visible)
    }

    // MARK: demo S3 hold (s3-b9: masks gone at 4 s, "I can see…" at 8–12 s; 2 of 6 runs before she spoke)

    func testHoldRules() {
        let h = CameraBoxes.Hold()
        XCTAssertEqual(h.fadeAt(speechStart: nil, speechEnd: nil), 12, accuracy: 0.001, "nobody speaks: the cap")
        XCTAssertEqual(h.fadeAt(speechStart: 4.5, speechEnd: nil), 10.5, accuracy: 0.001, "still speaking: the ingredient sentence's 6 s")
        XCTAssertEqual(h.fadeAt(speechStart: 4.5, speechEnd: 8), 8.6, accuracy: 0.001, "her answer played: fade right after")
        XCTAssertEqual(h.fadeAt(speechStart: 7.7, speechEnd: nil), 13.7, accuracy: 0.001, "an answer that starts before the cap finishes its sentence")
        XCTAssertEqual(h.fadeAt(speechStart: 0.2, speechEnd: 1), 4, accuracy: 0.001, "never under the board's 4 s")
        XCTAssertEqual(h.fadeAt(speechStart: 12.5, speechEnd: nil), 12, accuracy: 0.001, "speech after the cap doesn't bring them back")
        XCTAssertEqual(h.fadeAt(speechStart: -1, speechEnd: 5), 5, accuracy: 0.001, "speech that began before a later batch of the same find")
    }

    /// Run e2-1 timing: masks land, the filler "Let me see." was still playing, the answer plays 7 s later and the masks
    /// stay through it, fading just after it ends (not 4 s after they landed).
    func testMasksStayUntilTheAnswerHasPlayed() async throws {
        let b = CameraBoxes()
        b.hold = .init(minimum: 0.05, cap: 3, sentence: 2, afterSpeech: 0.05)
        b.companionStarted(1)                       // "Let me see." playing
        b.apply(event([("Tomato", egg)]))
        b.companionStopped(1); b.companionStopped(nil)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertTrue(b.visible, "the filler that was already playing is not her answer")
        b.companionStarted(2)                       // "I can see tomato, bell pepper, onion, and garlic. …"
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertTrue(b.visible, "up while she names them")
        b.companionStopped(2)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertFalse(b.visible, "fades right after she finished"); XCTAssertFalse(b.holding)
    }

    func testLongAnswerFadesAfterTheIngredientSentence() async throws {
        let b = CameraBoxes()
        b.hold = .init(minimum: 0.05, cap: 3, sentence: 0.2, afterSpeech: 0.05)
        b.apply(event([("Tomato", egg)]))
        b.companionStarted(7)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertTrue(b.visible)
        try await Task.sleep(for: .milliseconds(350))
        XCTAssertFalse(b.visible, "the rest of the reply (the dish, the steps) plays without them")
    }

    func testAChipTapDuringTheHoldKeepsIt() async throws {
        let b = CameraBoxes()
        b.fadeAfter = .milliseconds(50)
        b.hold = .init(minimum: 0.05, cap: 0.4)
        b.apply(event([("Egg", egg)]))
        b.highlight("egg")
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertTrue(b.visible, "not cut to the chip's own short fade"); XCTAssertTrue(b.holding)
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertFalse(b.visible)
    }

    func testClearEndsTheHold() {
        let b = CameraBoxes()
        var ended = 0
        b.onHoldEnded = { ended += 1 }
        b.apply(event([("Egg", egg)]))
        b.clear()
        XCTAssertFalse(b.holding); XCTAssertEqual(ended, 1, "camera off / flipped: a card waiting at peek can rise")
        b.clear()
        XCTAssertEqual(ended, 1)
    }

    /// The card lands while the masks are held: it waits at peek (the half sheet covered the lower masks on build 9),
    /// then rises when they fade.
    func testCardWaitsAtPeekWhileTheMasksAreHeldThenRises() async throws {
        let m = FindsModel()
        m.boxes.hold = .init(minimum: 0.05, cap: 3, sentence: 2, afterSpeech: 0.05)
        m.apply(try ServerEvent.decode(#"{"type":"find.started","findId":"s3","utteranceId":1,"kind":"recipe","title":"t","detail":"d"}"#))
        m.apply(.observeBoxes(event(find: "s3", [("Tomato", egg), ("Garlic", tofu)])))
        XCTAssertEqual(m.state, .searching)
        m.apply(created("s3"))
        XCTAssertEqual(m.state, .peek, "held at peek while the masks are up")
        m.boxes.companionStarted(2)
        m.boxes.companionStopped(2)
        try await Task.sleep(for: .milliseconds(250))
        XCTAssertFalse(m.boxes.visible)
        XCTAssertTrue(m.state == .rising || m.state == .half, "then it rises as before (\(m.state))")
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertEqual(m.state, .half)
    }

    func testHeldCardStaysFoldedWhenTheUserTalksOrMovesIt() async throws {
        let m = FindsModel()
        m.boxes.hold = .init(minimum: 0.05, cap: 0.2)
        m.apply(try ServerEvent.decode(#"{"type":"find.started","findId":"s3","utteranceId":1,"kind":"recipe","title":"t","detail":"d"}"#))
        m.apply(.observeBoxes(event(find: "s3", [("Tomato", egg)])))
        m.apply(created("s3"))
        XCTAssertEqual(m.state, .peek)
        m.userStartedTalking()
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(m.state, .peek, "the user is talking: it stays folded")

        // tapped open, then folded again by hand: the end of the hold doesn't pull it back up
        let n = FindsModel()
        n.boxes.hold = .init(minimum: 0.05, cap: 0.2)
        n.apply(try ServerEvent.decode(#"{"type":"find.started","findId":"s4","utteranceId":1,"kind":"recipe","title":"t","detail":"d"}"#))
        n.apply(.observeBoxes(event(find: "s4", [("Tomato", egg)])))
        n.apply(created("s4"))
        n.tapPeek(); XCTAssertEqual(n.state, .half)
        n.dragEnded(translation: 80, velocity: 0); XCTAssertEqual(n.state, .peek)
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(n.state, .peek)
    }

    func testCardWithoutBoxesRisesStraightAway() {
        let m = FindsModel()
        m.apply(try! ServerEvent.decode(#"{"type":"find.started","findId":"p1","utteranceId":1,"kind":"recipe","title":"t","detail":"d"}"#))
        m.apply(created("p1"))
        XCTAssertEqual(m.state, .rising)
    }

    func testStageLiftClearsThePeekSheetWithoutPushingMasksUnderTheHUD() {
        // 390 × 844, peek sheet top 696, label floor 107
        let low = [CGRect(x: 40, y: 300, width: 80, height: 80), CGRect(x: 200, y: 600, width: 90, height: 120)]   // bottom 720
        XCTAssertEqual(CameraBoxes.stageLift(boxes: low, sheetTop: 696, viewHeight: 844, floor: 107), 36, "720 + 12 − 696")
        let tall = [CGRect(x: 40, y: 150, width: 80, height: 80), CGRect(x: 200, y: 640, width: 90, height: 120)]
        XCTAssertEqual(CameraBoxes.stageLift(boxes: tall, sheetTop: 696, viewHeight: 844, floor: 107), 11, "the top mask keeps its label under the floor")
        XCTAssertEqual(CameraBoxes.stageLift(boxes: [CGRect(x: 0, y: 300, width: 50, height: 50)], sheetTop: 696, viewHeight: 844, floor: 107), 0, "already clear")
        let deep = [CGRect(x: 40, y: 500, width: 80, height: 330)]
        XCTAssertEqual(CameraBoxes.stageLift(boxes: deep, sheetTop: 696, viewHeight: 844, floor: 107), 108, "no more than the sheet hides at the bottom")
        XCTAssertEqual(CameraBoxes.stageLift(boxes: low, sheetTop: 844, viewHeight: 844, floor: 107), 0, "no sheet, no lift")
        XCTAssertEqual(CameraBoxes.stageLift(boxes: [], sheetTop: 696, viewHeight: 844, floor: 107), 0)
    }

    private func created(_ id: String) -> ServerEvent {
        let card = try! JSONDecoder().decode(FindCard.self, from: Data("""
        {"id":"\(id)","kind":"recipe","createdAt":"2026-11-04T10:00:00Z","eyebrow":"From your camera","title":"Roasted tomato red pepper soup",
         "subtitle":"About 30 min","items":[],"steps":[{"text":"Roast them."}],"options":[],"why":[],"ask":["Spicy?"],"sources":[],"how":[]}
        """.utf8))
        return .findCreated(.init(findId: id, card: card))
    }

    func testChipHighlightLightsOneBoxAndBringsBackFadedBoxes() async throws {
        let b = CameraBoxes()
        b.fadeAfter = .milliseconds(100)
        b.hold = .init(minimum: 0.05, cap: 0.1)
        b.apply(event([("Egg", egg), ("Green onion", tofu)]))
        try await Task.sleep(for: .milliseconds(250))
        XCTAssertFalse(b.visible)
        b.highlight("green onion")
        XCTAssertEqual(b.highlighted, "green onion"); XCTAssertTrue(b.visible, "tapping a chip shows its box again")
        b.highlight("cooked rice")
        XCTAssertNil(b.highlighted, "a chip with no box (to buy, not seen) lights nothing")
        b.highlight("egg"); b.highlight(nil)
        XCTAssertNil(b.highlighted)
    }

    func testSheetChipsDriveTheBoxes() {
        let sheet = FindsModel()
        sheet.boxes.apply(event([("Egg", egg)]))
        let item = FindItem(id: "egg", name: "egg", tier: .have, from: .both, box: egg)
        sheet.tapItem(item)
        XCTAssertEqual(sheet.boxes.highlighted, "egg")
        sheet.tapItem(item)
        XCTAssertNil(sheet.boxes.highlighted, "second tap lets go")
        sheet.apply(.observeBoxes(event([("Egg", egg), ("Tofu", tofu)])))
        XCTAssertEqual(sheet.boxes.boxes.count, 2, "observe.boxes from the server reaches the preview")
        sheet.callEnded()
        XCTAssertTrue(sheet.boxes.boxes.isEmpty)
    }

    func testBoxesFromBeforeACameraFlipAreDropped() {
        let sheet = FindsModel()
        sheet.apply(try! ServerEvent.decode(#"{"type":"find.started","findId":"late-1","utteranceId":1,"kind":"recipe","title":"t","detail":"d"}"#))
        sheet.boxes.clear()   // camera flipped or turned off
        sheet.apply(.observeBoxes(event(find: "late-1", [("Egg", egg)])))
        XCTAssertTrue(sheet.boxes.boxes.isEmpty, "the late batch belongs to the old camera")
        sheet.apply(try! ServerEvent.decode(#"{"type":"find.started","findId":"new-1","utteranceId":2,"kind":"recipe","title":"t","detail":"d"}"#))
        sheet.apply(.observeBoxes(event(find: "new-1", [("Egg", egg)])))
        XCTAssertEqual(sheet.boxes.boxes.count, 1)
    }

    func testLabelNeverAboveTheTopInset() {
        // a box that starts off the top edge: its label goes below the box and is pushed under the status area
        let off = CGRect(x: 0, y: -40, width: 60, height: 50)
        XCTAssertGreaterThanOrEqual(off.minY + CameraBoxes.labelOffsetY(off, topInset: 120), 120)
        let normal = CGRect(x: 10, y: 300, width: 60, height: 50)
        XCTAssertEqual(CameraBoxes.labelOffsetY(normal, topInset: 120), -32)
    }

    func testBoxEndingAboveTheStatusAreaIsNotDrawn() {
        XCTAssertTrue(CameraBoxes.aboveView(CGRect(x: 0, y: -40, width: 60, height: 70), topInset: 120))
        XCTAssertFalse(CameraBoxes.aboveView(CGRect(x: 0, y: 60, width: 60, height: 120), topInset: 120))
    }

    func testBoxesUnderTheNoSeeCardAreHidden() {
        let card = CGRect(x: 24, y: 124, width: 220, height: 140)
        XCTAssertTrue(CameraBoxes.hidden(CGRect(x: 40, y: 200, width: 50, height: 50), avoiding: card))
        XCTAssertTrue(CameraBoxes.hidden(CGRect(x: 40, y: 290, width: 50, height: 50), avoiding: card), "its label (above) would reach the card")
        XCTAssertFalse(CameraBoxes.hidden(CGRect(x: 250, y: 400, width: 50, height: 50), avoiding: card))
        XCTAssertFalse(CameraBoxes.hidden(CGRect(x: 40, y: 200, width: 50, height: 50), avoiding: nil))
        XCTAssertEqual(NoSeeCheck(title: "t", rows: [.init(name: "a", seen: true), .init(name: "b", seen: true), .init(name: "c", seen: false)]).cardHeight, 140, "Figma 59:35: 12 + 16 + 8 + 68 + 24 + 12")
    }

    /// Demo S3 · SAM masks (#298): one item per match, the same label repeating. Each instance is its own box with its
    /// own mask; the label pill shows once, on the largest; a chip lights every instance of its label.
    func testEveryMatchIsItsOwnBoxWithOneLabelPerIngredient() {
        let b = CameraBoxes()
        let small = NormBox(x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2), big = NormBox(x1: 0.3, y1: 0.3, x2: 0.6, y2: 0.6)
        let m = NormMask(w: 2, h: 1, rle: [1, 1])
        b.apply(.init(findId: "f", frame: 0, w: 480, h: 854, items: [
            .init(label: "Tomatoes", box: small, mask: m), .init(label: "Tomatoes", box: big, mask: m), .init(label: "Garlic", box: egg),
        ]))
        XCTAssertEqual(b.boxes.map(\.id), ["tomatoes", "tomatoes#1", "garlic"], "ids stay unique; a single match keeps its old id")
        let view = CGSize(width: 390, height: 844), frame = CGSize(width: 480, height: 854)
        let drawn = b.boxes.map { (item: $0, rect: CameraBoxes.rect($0.box, frame: frame, in: view)) }
        XCTAssertEqual(CameraBoxes.labelOwners(drawn), ["tomatoes#1", "garlic"], "one pill per label, on the largest instance")
        XCTAssertEqual(CameraBoxes.labelOwners(drawn.filter { $0.item.id != "tomatoes#1" }), ["tomatoes", "garlic"],
                       "the biggest one hidden (under the status bar or a card): a drawn one carries the label (Codex P2)")
        XCTAssertEqual(b.boxes[0].mask, m)
        XCTAssertNil(b.boxes[2].mask, "no mask → drawn as a box")
        XCTAssertNotNil(b.maskImages(for: b.boxes[0]), "fill and outline images from the grid")
        XCTAssertNil(b.maskImages(for: b.boxes[2]))
        b.highlight("tomatoes")
        XCTAssertEqual(b.highlighted, "tomatoes")
        XCTAssertTrue(CameraBoxes.masksEnabled, "masks are on by default (Chelsea OK, option c); off with GENITA_SAM_MASKS_UI=0")
    }

    /// iPhone 16 (390 × 844, safe area 47 / 34) on the HUD r01 A grid; `top` is the call's old board offset (safe top − 44).
    private static let grid16 = CallHUDGrid(size: CGSize(width: 390, height: 844), safeTop: 47, safeBottom: 34)

    /// Demo S3 option (c), masks only: a label never sits under the top-left menu button or the self-view PiP;
    /// it moves below / beside instead. Without obstacles it stays where boxes put it (above, left-aligned).
    func testMaskLabelsStayClearOfTheMenuButtonAndThePip() {
        let grid = Self.grid16, view = grid.size, top: CGFloat = grid.safeTop - 44, label = CGSize(width: 80, height: 28)
        let menu = CameraBoxes.menuRect(grid: grid), pip = CameraBoxes.pipRect(view: view, top: top, sheetHalf: false)
        let open = CGRect(x: 120, y: 400, width: 100, height: 80)
        XCTAssertEqual(CameraBoxes.labelOrigin(open, label: label, view: view, topInset: grid.labelFloor, obstacles: [menu, pip]), CGPoint(x: 120, y: 368), "free space: above, as boxes")
        // the counter capture: a tomato right under the menu button — its label went onto the button
        let tomato = CGRect(x: 18, y: 110, width: 120, height: 115)
        let t = CameraBoxes.labelOrigin(tomato, label: label, view: view, topInset: grid.labelFloor, obstacles: [menu, pip])
        XCTAssertFalse(CGRect(origin: t, size: label).intersects(menu), "not on the menu button")
        // a pepper under the PiP: the mask may be under it, its label may not
        let pepper = CGRect(x: 250, y: 170, width: 130, height: 120)
        let p = CameraBoxes.labelOrigin(pepper, label: label, view: view, topInset: grid.labelFloor, obstacles: [menu, pip])
        XCTAssertFalse(CGRect(origin: p, size: label).intersects(pip), "not under the PiP")
        XCTAssertTrue(CGRect(origin: .zero, size: view).contains(CGRect(origin: p, size: label)), "still on screen")
    }

    /// UI sweep 11/3: a box label never sits under the status line pill ("Green onion" behind "Listening").
    /// HUD r01 A put the pill on the menu row, above the label floor (safe top + 60), on every screen size; it stays an obstacle.
    func testLabelsStayClearOfTheStatusLine() {
        for grid in [Self.grid16, CallHUDGrid(size: CGSize(width: 402, height: 874), safeTop: 62, safeBottom: 34), CallHUDGrid(size: CGSize(width: 375, height: 667), safeTop: 20, safeBottom: 0)] {
            XCTAssertLessThanOrEqual(CameraBoxes.statusRect(grid: grid).maxY, grid.labelFloor, "no label can reach the pill (\(grid.size))")
            XCTAssertLessThanOrEqual(CameraBoxes.menuRect(grid: grid).maxY - 6, grid.labelFloor, "nor the menu button")
        }
        let grid = Self.grid16, view = grid.size, top: CGFloat = grid.safeTop - 44, label = CGSize(width: 90, height: 28)
        let obstacles = [CameraBoxes.menuRect(grid: grid), CameraBoxes.statusRect(grid: grid), CameraBoxes.pipRect(view: view, top: top, sheetHalf: false)]
        let onion = CGRect(x: 150, y: 110, width: 100, height: 90)
        let o = CameraBoxes.labelOrigin(onion, label: label, view: view, topInset: grid.labelFloor, obstacles: obstacles)
        XCTAssertFalse(CGRect(origin: o, size: label).intersects(obstacles[1]), "off the status line")
        let open = CGRect(x: 40, y: 420, width: 100, height: 80)
        XCTAssertEqual(CameraBoxes.labelOrigin(open, label: label, view: view, topInset: grid.labelFloor, obstacles: obstacles), CGPoint(x: 40, y: 388), "free space: unchanged")
    }

    /// 춘식이 (dyno504 preview-05): "Tofu" sat level with the pill. Labels stay out of the menu row band (safe top … + 60):
    /// no room above → inside the box's top 6 pt; a box reaching into the band → under it 6 pt. The pill doesn't move.
    func testLabelsStayOutOfTheMenuRowBand() {
        let grid = Self.grid16, floor = grid.labelFloor
        XCTAssertEqual(floor, 107)
        let tofu = CGRect(x: 150, y: 120, width: 90, height: 80)          // room above? 120 − 32 = 88 < 107: no
        XCTAssertEqual(CameraBoxes.labelOffsetY(tofu, topInset: floor), 6, "inside the box's top")
        let high = CGRect(x: 150, y: 70, width: 90, height: 80)           // the box reaches into the band
        XCTAssertEqual(CameraBoxes.labelOffsetY(high, topInset: floor), 80 + 6, "under the box")
        let open = CGRect(x: 150, y: 300, width: 90, height: 80)
        XCTAssertEqual(CameraBoxes.labelOffsetY(open, topInset: floor), -32, "room above: as before")
        let o = CameraBoxes.labelOrigin(tofu, label: CGSize(width: 70, height: 28), view: grid.size, topInset: floor, obstacles: [CameraBoxes.menuRect(grid: grid), CameraBoxes.statusRect(grid: grid)])
        XCTAssertEqual(o, CGPoint(x: 150, y: 126), "masks: inside the top too")
    }

    /// Codex P2: a pill on the second line (a cue with a button, a long Finds line) is where labels must keep clear of.
    func testLabelsStayClearOfTheSecondLine() {
        let grid = Self.grid16, view = grid.size, label = CGSize(width: 90, height: 28)
        let second = CameraBoxes.statusRect(grid: grid, line: .second, width: 300)
        XCTAssertEqual(second.midY, grid.secondLineY)
        XCTAssertEqual(second.midX, view.width / 2, "centred")
        let box = CGRect(x: 100, y: 150, width: 120, height: 100)
        let boxRule = CGRect(x: box.minX, y: box.minY - label.height - 4, width: label.width, height: label.height)
        XCTAssertTrue(boxRule.intersects(second), "red: above the box lands on the second line")
        let o = CameraBoxes.labelOrigin(box, label: label, view: view, topInset: grid.labelFloor, obstacles: [CameraBoxes.menuRect(grid: grid), second])
        XCTAssertFalse(CGRect(origin: o, size: label).intersects(second), "green: moved off it")
    }

    /// UI sweep 11/3 (after the status-line fix): a label moved below its box landed on the next box's label.
    func testLabelsDoNotSitOnEachOther() {
        let grid = Self.grid16, view = grid.size, label = CGSize(width: 90, height: 28)
        let obstacles = [CameraBoxes.menuRect(grid: grid), CameraBoxes.statusRect(grid: grid)]
        let a = CGRect(x: 20, y: 110, width: 100, height: 90)    // no room above: label inside its top, (20, 116)
        let b = CGRect(x: 40, y: 140, width: 100, height: 90)    // its label above, (40, 108), lands on a's
        let o = CameraBoxes.labelOrigins([(id: "a", rect: a, label: label), (id: "b", rect: b, label: label)], view: view, topInset: grid.labelFloor, obstacles: obstacles)
        let ra = CGRect(origin: o["a"]!, size: label), rb = CGRect(origin: o["b"]!, size: label)
        XCTAssertFalse(ra.intersects(rb), "two pills never overlap")
        XCTAssertFalse(rb.intersects(obstacles[0]))
    }

    /// UI sweep 11/3: "Whole milk" sat under the camera / mic / more buttons; the rail moves with the sheet.
    func testLabelsStayClearOfTheControlRail() {
        let grid = Self.grid16, view = grid.size, label = CGSize(width: 90, height: 28)
        let rail = CameraBoxes.railRect(grid: grid, sheet: .idle)
        XCTAssertTrue(rail.contains(CGPoint(x: grid.railX, y: grid.railY(.camera))) && rail.contains(CGPoint(x: grid.railX, y: grid.railY(.more))), "camera and more buttons inside")
        XCTAssertEqual(CameraBoxes.railRect(grid: grid, sheet: .half).minY, grid.railY(.camera, sheetUp: true) - 22 - 4 - 440)
        let milk = CGRect(x: 280, y: 690, width: 90, height: 120)
        let o = CameraBoxes.labelOrigin(milk, label: label, view: view, topInset: grid.labelFloor, obstacles: [rail])
        XCTAssertFalse(CGRect(origin: o, size: label).intersects(rail), "moved off the buttons")
    }
}
