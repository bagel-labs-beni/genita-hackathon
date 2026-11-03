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

    func testBoxesFadeAfterFourSeconds() async throws {
        let b = CameraBoxes()
        b.fadeAfter = .milliseconds(120)
        b.apply(event([("Egg", egg)]))
        XCTAssertTrue(b.visible)
        try await Task.sleep(for: .milliseconds(350))
        XCTAssertFalse(b.visible, "faded"); XCTAssertEqual(b.boxes.count, 1, "kept so a chip tap can bring it back")
        XCTAssertEqual(CameraBoxes().fadeAfter, .seconds(4), "the board's 4 s")
    }

    func testNewBatchRestartsTheClock() async throws {
        let b = CameraBoxes()
        b.fadeAfter = .milliseconds(250)
        b.apply(event([("Egg", egg)]))
        try await Task.sleep(for: .milliseconds(150))
        b.apply(event([("Egg", egg), ("Tofu", tofu)]))
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertTrue(b.visible, "300 ms after the first batch but 150 ms after the second")
        try await Task.sleep(for: .milliseconds(250))
        XCTAssertFalse(b.visible)
    }

    func testChipHighlightLightsOneBoxAndBringsBackFadedBoxes() async throws {
        let b = CameraBoxes()
        b.fadeAfter = .milliseconds(100)
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

    /// Demo S3 option (c), masks only: a label never sits under the top-left menu button or the self-view PiP;
    /// it moves below / beside instead. Without obstacles it stays where boxes put it (above, left-aligned).
    func testMaskLabelsStayClearOfTheMenuButtonAndThePip() {
        let view = CGSize(width: 390, height: 844), top: CGFloat = 59, label = CGSize(width: 80, height: 28)
        let menu = CameraBoxes.menuRect(top: top), pip = CameraBoxes.pipRect(view: view, top: top, sheetHalf: false)
        let open = CGRect(x: 120, y: 400, width: 100, height: 80)
        XCTAssertEqual(CameraBoxes.labelOrigin(open, label: label, view: view, topInset: 96 + top, obstacles: [menu, pip]), CGPoint(x: 120, y: 368), "free space: above, as boxes")
        // the counter capture: a tomato right under the menu button — its label went onto the button
        let tomato = CGRect(x: 18, y: 150, width: 120, height: 115)
        let t = CameraBoxes.labelOrigin(tomato, label: label, view: view, topInset: 96 + top, obstacles: [menu, pip])
        XCTAssertFalse(CGRect(origin: t, size: label).intersects(menu), "not on the menu button")
        // a pepper under the PiP: the mask may be under it, its label may not
        let pepper = CGRect(x: 250, y: 170, width: 130, height: 120)
        let p = CameraBoxes.labelOrigin(pepper, label: label, view: view, topInset: 96 + top, obstacles: [menu, pip])
        XCTAssertFalse(CGRect(origin: p, size: label).intersects(pip), "not under the PiP")
        XCTAssertTrue(CGRect(origin: .zero, size: view).contains(CGRect(origin: p, size: label)), "still on screen")
    }

    /// UI sweep 11/3: a box label never sits under the status line pill ("Green onion" behind "Listening");
    /// a label in free space keeps the box rule's spot (above, left-aligned).
    func testLabelsStayClearOfTheStatusLine() {
        let view = CGSize(width: 390, height: 844), top: CGFloat = 59, label = CGSize(width: 90, height: 28)
        let status = CameraBoxes.statusRect(view: view, top: top)
        let obstacles = [CameraBoxes.menuRect(top: top), status, CameraBoxes.pipRect(view: view, top: top, sheetHalf: false)]
        // a box just under the pill: the box rule puts its label right on the pill
        let onion = CGRect(x: 150, y: 210, width: 100, height: 90)
        let boxRule = CGRect(x: onion.minX, y: onion.minY + CameraBoxes.labelOffsetY(onion, topInset: 96 + top), width: label.width, height: label.height)
        XCTAssertTrue(boxRule.intersects(status), "red: the box rule alone overlaps the status line")
        let o = CameraBoxes.labelOrigin(onion, label: label, view: view, topInset: 96 + top, obstacles: obstacles)
        XCTAssertFalse(CGRect(origin: o, size: label).intersects(status), "green: moved off the status line")
        let open = CGRect(x: 40, y: 420, width: 100, height: 80)
        XCTAssertEqual(CameraBoxes.labelOrigin(open, label: label, view: view, topInset: 96 + top, obstacles: obstacles), CGPoint(x: 40, y: 388), "free space: unchanged")
    }

    /// UI sweep 11/3 (after the status-line fix): a label moved below its box landed on the next box's label.
    func testLabelsDoNotSitOnEachOther() {
        let view = CGSize(width: 390, height: 844), top: CGFloat = 59, label = CGSize(width: 90, height: 28)
        let obstacles = [CameraBoxes.menuRect(top: top), CameraBoxes.statusRect(view: view, top: top)]
        let a = CGRect(x: 150, y: 210, width: 100, height: 90)   // label pushed below: (150, 304)
        let b = CGRect(x: 190, y: 340, width: 100, height: 90)   // its own label above: (190, 308) — the same spot
        let o = CameraBoxes.labelOrigins([(id: "a", rect: a, label: label), (id: "b", rect: b, label: label)], view: view, topInset: 96 + top, obstacles: obstacles)
        let ra = CGRect(origin: o["a"]!, size: label), rb = CGRect(origin: o["b"]!, size: label)
        XCTAssertFalse(ra.intersects(rb), "two pills never overlap")
        XCTAssertFalse(rb.intersects(obstacles[1]))
    }

    /// UI sweep 11/3: "Whole milk" sat under the camera / mic / more buttons; the rail moves with the sheet.
    func testLabelsStayClearOfTheControlRail() {
        let view = CGSize(width: 390, height: 844), top: CGFloat = 59, label = CGSize(width: 90, height: 28)
        let rail = CameraBoxes.railRect(view: view, sheet: .idle)
        XCTAssertTrue(rail.contains(CGPoint(x: 334, y: 665)) && rail.contains(CGPoint(x: 334, y: 783)), "camera and more buttons inside")
        XCTAssertEqual(CameraBoxes.railRect(view: view, sheet: .half).minY, rail.minY - 440)
        let milk = CGRect(x: 280, y: 690, width: 90, height: 120)
        let o = CameraBoxes.labelOrigin(milk, label: label, view: view, topInset: 96 + top, obstacles: [rail])
        XCTAssertFalse(CGRect(origin: o, size: label).intersects(rail), "moved off the buttons")
    }
}
