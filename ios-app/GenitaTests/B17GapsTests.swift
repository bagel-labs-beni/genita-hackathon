import XCTest
@testable import Genita

/// b17 scorecard gaps: the I02 Paste pill sits on the Figma label row, and every About you chip starts with a capital.
@MainActor final class B17GapsTests: XCTestCase {
    private let nodes = DesignLibrary.nodes("paste")
    private var card: DesignNode { nodes.first { $0.name == "Your AI’s response" && $0.type != "text" }! }
    private var label: DesignNode? { nodes.first { $0.type == "text" && $0.characters == "Your AI’s response" } }

    func testPastePillIsOnTheFigmaLabelRow() {
        let label = try! XCTUnwrap(self.label)
        // Figma I02 10:35: card 31,264 328 wide; label 52,285 22 high → the row's centre is 296 (I01's copy icon line)
        XCTAssertEqual(ReferenceOnboardingView.pasteRowY(card: card, label: label), label.y + label.h / 2)
        XCTAssertEqual(ReferenceOnboardingView.pasteRowY(card: card, label: label), 296)
        XCTAssertGreaterThan(ReferenceOnboardingView.pasteRowY(card: card, label: label), card.y + ScrollEdgeFade.header / 2,
                             "not the 44 pt band's centre (10 pt above the label)")
        XCTAssertEqual(ReferenceOnboardingView.pasteInset, 12, "12 pt in from the card's right edge")
    }

    func testPastePillFallsBackToTheBandWithoutALabel() {
        XCTAssertEqual(ReferenceOnboardingView.pasteRowY(card: card, label: nil), card.y + ScrollEdgeFade.header / 2)
    }

    func testChipsStartWithACapital() {
        XCTAssertEqual(InsightShareCard.chipLabel("noodles"), "Noodles")
        XCTAssertEqual(InsightShareCard.chipLabel("Talk it out"), "Talk it out")
        XCTAssertEqual(InsightShareCard.chipLabel(" iPhone notes"), "iPhone notes", "a word cased on purpose stays")
        XCTAssertEqual(InsightShareCard.chipLabel("spicy food"), "Spicy food")
        XCTAssertEqual(InsightShareCard.chipLabel(""), "")
    }
    func testSourceTitleLosesTheSiteNameTail() {
        XCTAssertEqual(FindCard.Source.withoutSiteName("Kimchi Fried Rice with Crispy Tofu | Chopped", domain: "chopped.com"), "Kimchi Fried Rice with Crispy Tofu")
        XCTAssertEqual(FindCard.Source(title: "Kimchi Fried Rice with Crispy Tofu | Chopped", url: "https://chopped.com/a", domain: "chopped.com").displayTitle,
                       "Kimchi Fried Rice with Crispy Tofu")
        XCTAssertEqual(FindCard.Source.withoutSiteName("Easy Kimchi Jjigae | Serious Eats", domain: "www.seriouseats.com"), "Easy Kimchi Jjigae")
        XCTAssertEqual(FindCard.Source.withoutSiteName("Best ramen | Vegetarian options", domain: "eater.com"), "Best ramen | Vegetarian options",
                       "a tail that isn't the site keeps the title whole (Codex r1)")
        XCTAssertEqual(FindCard.Source.withoutSiteName("Best ramen | For meat eaters", domain: "eater.com"), "Best ramen | For meat eaters",
                       "only the site's exact name goes (Codex r1)")
        XCTAssertEqual(FindCard.Source.withoutSiteName("Late ramen near Hapjeong | Eater", domain: "seoul.eater.com"), "Late ramen near Hapjeong")
        XCTAssertEqual(FindCard.Source.withoutSiteName("A | Chopped", domain: "chopped.com"), "A | Chopped", "a short head keeps the whole title")
        XCTAssertEqual(FindCard.Source.withoutSiteName("Best ramen in Seoul", domain: "eater.com"), "Best ramen in Seoul")
    }

    func testBodyDragResizesFullOnlyAtTheTop() {
        XCTAssertTrue(FindsSheet.bodyDragResizes(.half, pageAtTop: false))
        XCTAssertTrue(FindsSheet.bodyDragResizes(.peek, pageAtTop: false))
        XCTAssertTrue(FindsSheet.bodyDragResizes(.full, pageAtTop: true))
        XCTAssertFalse(FindsSheet.bodyDragResizes(.full, pageAtTop: false), "scrolled: the card scrolls")
        XCTAssertFalse(FindsSheet.bodyDragResizes(.searching, pageAtTop: true))
        XCTAssertTrue(FindsSheet.inGrab(CGPoint(x: 195, y: 20), width: 390), "the grab's own drag")
        XCTAssertFalse(FindsSheet.inGrab(CGPoint(x: 195, y: 80), width: 390))
        XCTAssertFalse(FindsSheet.inGrab(CGPoint(x: 40, y: 20), width: 390))
    }

    #if DEBUG
    func testFindsListLinksHaveTheirOwnPictures() {
        let cards = FixtureFindsAPI.recorded().cards.filter { $0.kind == .link }
        XCTAssertEqual(cards.count, 2)
        let heroes = cards.compactMap { $0.hero?.url }
        XCTAssertEqual(Set(heroes).count, 2, "two link finds, two pictures: \(heroes)")
        XCTAssertTrue(heroes.contains("bundle:finds-link-ramen"))
        XCTAssertNotNil(Bundle.main.url(forResource: "finds-link-ramen", withExtension: "jpg"))
    }

    /// The PF-1 "two cards" fixture (UI tests, Appetize, Preview): each product shows its own bundled photo.
    func testFixtureProductsEachHaveTheirOwnPhoto() throws {
        let m = FindsModel()
        m.applyFixture(state: 22)
        let products = try XCTUnwrap(m.current?.card?.products)
        XCTAssertEqual(products.map(\.name), ["Cotton chore jacket", "Linen overshirt"])
        let urls = products.compactMap { $0.image?.status == .ready ? $0.image?.url : nil }
        XCTAssertEqual(urls, ["bundle:finds-product-jacket", "bundle:finds-product-overshirt"])
        XCTAssertEqual(Set(urls).count, urls.count, "no two cards share a photo")
        for u in urls { XCTAssertNotNil(Bundle.main.url(forResource: String(u.dropFirst(7)), withExtension: "jpg"), "\(u) is bundled") }
    }
    #endif
}
