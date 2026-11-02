#if DEBUG
import Foundation

/// Debug builds only. Puts the Finds sheet into one of the r03 board's states using events recorded from a real
/// genita-server run (Resources/finds-fixture.json: fridge recipe, outfit, link; `npm run finds:e2e -- --record`).
///   GENITA_FINDS_STATE = 1…19 (r03 frame numbers), 20 = IC-4 "can't see it", 21–24 = PF-1 product search (#120), 25 = fridge pill (#214), 26 = FT-NOSEE, 41 = reason chips (D48 ③), 42 = budget reason chip on a product card (Knows-Me Map)
/// Pictures point at bundled illustrations ("bundle:finds-step-1") instead of the server.
extension CallController {
    func installFindsFixture(environment env: [String: String] = ProcessInfo.processInfo.environment) {
        guard let raw = env["GENITA_FINDS_STATE"], let n = Int(raw) else { return }
        Task { [weak self] in
            for _ in 0..<80 where self?.link != .live { try? await Task.sleep(for: .milliseconds(100)) }
            try? await Task.sleep(for: .milliseconds(300))
            self?.finds.applyFixture(state: n)
        }
    }
}

struct FindsFixtureRun {
    let kind: FindKind
    var question: String? = nil
    let frames: [Data]
    let events: [ServerEvent]

    static func load() -> [FindsFixtureRun] {
        guard let url = Bundle.main.url(forResource: "finds-fixture", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let runs = root["runs"] as? [[String: Any]] else { return [] }
        return runs.compactMap { run in
            guard let kind = (run["kind"] as? String).flatMap(FindKind.init(rawValue:)), let raw = run["events"] as? [Any] else { return nil }
            let frames = (run["frames"] as? [String] ?? []).compactMap { name in
                Bundle.main.url(forResource: name, withExtension: "jpg").flatMap { try? Data(contentsOf: $0) }
            }
            let events = raw.compactMap { obj -> ServerEvent? in
                guard let d = try? JSONSerialization.data(withJSONObject: obj) else { return nil }
                return try? JSONDecoder().decode(ServerEvent.self, from: d)
            }
            return FindsFixtureRun(kind: kind, question: run["question"] as? String, frames: frames, events: events)
        }
    }
}

extension FindsModel {
    func applyFixture(state n: Int) {
        let runs = FindsFixtureRun.load()
        guard let recipe = runs.first(where: { $0.kind == .recipe }) else { return }
        let outfit = runs.first { $0.kind == .outfit }
        let link = runs.first { $0.kind == .link }
        let product = runs.first { $0.kind == .product }
        let noImages = { (r: FindsFixtureRun) in r.events.filter { if case .findImage = $0 { return false }; return true } }
        let untilCard = { (r: FindsFixtureRun) in Array(r.events.prefix { if case .findCreated = $0 { return false }; return true }) }
        func play(_ list: [(FindsFixtureRun, [ServerEvent])]) {
            reset()
            for (run, events) in list {
                latestFrames = run.frames.map { $0.base64EncodedString() }
                latestQuestion = run.question
                for e in events { apply(e) }
            }
        }
        let item = { (name: String) in self.current?.card?.items.first { $0.name.contains(name) }?.id }
        switch n {
        case 1: play([(recipe, untilCard(recipe))]); state = .searching
        case 2: play([(recipe, noImages(recipe))]); force(.rising)
        case 3, 18: play([(recipe, recipe.events)]); state = .half
        case 4: play([(recipe, recipe.events)]); state = .half; selectedItem = item("egg")
        case 5: play([(recipe, recipe.events)]); state = .half; selectedItem = item("soy")
        case 6: play([(recipe, recipe.events)]); state = .full; doneSteps[current?.id ?? ""] = [0]
        case 7: play([(recipe, recipe.events)]); state = .full; scrollTarget = "ask"
        case 8: play([(recipe, recipe.events)]); state = .full; browser = current?.card?.sources.first
        case 9: play([(recipe, recipe.events)]); state = .peek
        case 10: play([(recipe, recipe.events)]); state = .half; userStartedTalking()
        case 11:
            play([(recipe, recipe.events)] + (outfit.map { [($0, $0.events)] } ?? []))
            state = .half
            showPage(0)
            if let id = entries.last?.id { force(.half, newFind: id) }
        case 12: play([(recipe, recipe.events)] + (outfit.map { [($0, $0.events)] } ?? [])); state = .half; showPage(1)
        case 13: play([(recipe, recipe.events)] + [outfit, link].compactMap { $0 }.map { ($0, $0.events) }); state = .half; showPage(2)
        case 14:
            guard let link else { return }
            let failed = link.events.map { e -> ServerEvent in
                guard case var .findCreated(c) = e else { return e }
                c.card.page?.opened = false
                c.card.how = ["Couldn’t open the page you pasted. These points come from search results about it, not the page itself.", "The picture is an illustration I made."]
                return .findCreated(c)
            }
            play([(link, failed)]); state = .full
        case 15:
            let failed = recipe.events.map { e -> ServerEvent in
                guard case var .findImage(i) = e else { return e }
                i.status = .failed
                i.url = nil
                return .findImage(i)
            }
            play([(recipe, failed)]); state = .full
        case 16: play([(recipe, recipe.events)]); state = .half; offline = true
        case 41:
            // D48 ③: the same recipe card with reason chips from the user's taste lines
            let withReasons = recipe.events.map { e -> ServerEvent in
                guard case var .findCreated(c) = e else { return e }
                c.card.reasons = [.init(text: "Your taste: quick weeknight food", source: "Quick, simple weeknight cooking.", from: "profile"), .init(text: "You said: no cilantro", source: "no cilantro", from: "call")]
                return .findCreated(c)
            }
            play([(recipe, withReasons)]); state = .half
        case 42:
            // Knows-Me Map: the PF-1 product card with the profile's budget chip ("Your budget: under $100"), $89 / $64
            guard let product else { return }
            saveRemote = { _, _ in true }
            let priced = product.events.map { e -> ServerEvent in
                guard case var .findCreated(c) = e else { return e }
                let prices = ["$89", "$64"]
                if var items = c.card.products {
                    for i in items.indices where i < prices.count { items[i].price = prices[i] }
                    c.card.products = items
                }
                c.card.reasons = [.init(text: "Your style: clean, minimal clothes", source: "Style: Clean, minimal clothes.", from: "profile"),
                                  .init(text: "Your budget: under $100", source: "Budget: usually under $100 for clothes.", from: "profile")]
                return .findCreated(c)
            }
            play([(product, priced)]); state = .full
        case 17: play([(recipe, recipe.events)]); state = .half; close()
        case 19: play([(recipe, recipe.events)]); state = .full; scrollTarget = "how"
        case 30:
            // F5-U-CAM CAM-H: boxes over the live preview (the UI test turns the fixture camera on); no sheet
            Task { [weak self] in
                for _ in 0..<80 where CallController.shared.cameraOn == false { try? await Task.sleep(for: .milliseconds(100)) }
                if let last = recipe.events.last(where: { if case .observeBoxes = $0 { return true }; return false }), case let .observeBoxes(b) = last { self?.boxes.apply(b) }
            }
        case 26:
            // FT-NOSEE: boxes on the camera, no sheet, the check card says the rice is not in view
            play([(recipe, recipe.events)]); force(.idle)
            Task { [weak self] in
                for _ in 0..<80 where CallController.shared.cameraOn == false { try? await Task.sleep(for: .milliseconds(100)) }
                if let last = recipe.events.last(where: { if case .observeBoxes = $0 { return true }; return false }), case let .observeBoxes(b) = last { self?.boxes.apply(b) }
                self?.showNoSee(NoSeeCheck(title: "For kimchi fried rice", rows: [.init(name: "Eggs", seen: true), .init(name: "Scallions", seen: true), .init(name: "cooked rice", seen: false)]), hold: nil)
            }
        case 31:
            // CAM-H with the card half up: boxes arrive with the card; the test taps an ingredient chip
            play([(recipe, recipe.events)]); state = .half
        case 32:
            // CAM-H chip tap: the egg chip is pressed (the half sheet's chip row sits under the CTA when the title wraps)
            play([(recipe, recipe.events)]); state = .half
            if let egg = current?.card?.items.first(where: { $0.name == "egg" }) { tapItem(egg) }
        case 20:
            play([(recipe, Array(untilCard(recipe).prefix(1)))])
            if let id = entries.first?.id {
                apply(.findFailed(.init(findId: id, reason: .unclear, message: "I couldn't see the food clearly. Can you show me again with more light?")))
            }
            state = .searching
        case 25:
            // fridge pill (#122 follow-up): the server's short line, the sentence is only spoken
            play([(recipe, recipe.events)]); state = .half
            if entries.indices.contains(page) { entries[page].card?.pill = "Egg, tofu, green onion +1"; entries[page].card?.say = "I can see egg, tofu, green onion, and milk. You could make kimchi fried rice with tofu and egg, if you have kimchi." }
        case 21, 22, 23, 24:
            // PF-1 product search: 21 searching · 22 two cards · 23 saved (Open Finds) · 24 "Couldn't find a good match"
            guard let product else { return }
            saveRemote = { _, _ in true } // no server in screenshots: the bookmark stays
            if n == 21 {
                play([(product, Array(product.events.prefix { if case .findCreated = $0 { return false }; return true }))]); state = .searching
            } else if n == 24 {
                play([(product, Array(product.events.prefix(1)))])
                if let id = entries.first?.id {
                    apply(.findFailed(.init(findId: id, reason: .searchFailed, message: "Couldn’t find a good match. Try a color or a price, or ask me again.")))
                }
                state = .searching
            } else {
                play([(product, product.events)]); state = .full
                if n == 23 { toggleSave() }
            }
        default: break
        }
    }
}
#endif


#if DEBUG
/// Debug builds only: the Finds tab from recorded cards (no server). GENITA_FINDS_TAB = list | empty | detail.
actor FixtureFindsAPI: FindsAPI {
    private var cards: [FindCard]
    private(set) var removed: Set<String> = []
    init(cards: [FindCard]) { self.cards = cards }

    func list() async throws -> [FindCard] { cards.filter { !removed.contains($0.id) } }
    func delete(_ id: String) async throws { removed.insert(id) }
    func restore(_ id: String) async throws { removed.remove(id) }
    func setSaved(_ id: String, _ saved: Bool) async throws {
        if let i = cards.firstIndex(where: { $0.id == id }) { cards[i].saved = saved }
    }

    /// r03 F1: Saved (the kimchi rice), today (outfit, a link that would not open), yesterday (a link that did).
    @MainActor static func recorded(now: Date = Date()) -> (cards: [FindCard], frames: [String: [Data]]) {
        let iso = ISO8601DateFormatter()
        let runs = FindsFixtureRun.load()
        var cards: [FindCard] = []
        var frames: [String: [Data]] = [:]
        func card(_ kind: FindKind, hoursAgo: Double, change: (inout FindCard) -> Void = { _ in }) {
            guard let run = runs.first(where: { $0.kind == kind }) else { return }
            let m = FindsModel()
            m.load(recorded: run.events, frames: run.frames)
            guard var c = m.entries.first?.card else { return }
            let original = c.id
            c.createdAt = iso.string(from: now.addingTimeInterval(-hoursAgo * 3600))
            change(&c)
            if cards.contains(where: { $0.id == c.id }) { c.id = UUID().uuidString.lowercased() }
            cards.append(c)
            frames[c.id] = frames[original] ?? run.frames
        }
        card(.recipe, hoursAgo: 3) { $0.saved = true }
        card(.outfit, hoursAgo: 2)
        card(.link, hoursAgo: 1) { $0.page?.opened = false; $0.title = "Carry-on packing guide"; $0.status = nil }
        card(.link, hoursAgo: 27) { $0.title = "Late ramen near Hapjeong" }
        return (cards, frames)
    }
}
#endif
