#if DEBUG
import Foundation

/// Debug builds only. Puts the Finds sheet into one of the r03 board's states using events recorded from a real
/// genita-server run (Resources/finds-fixture.json: fridge recipe, outfit, link; `npm run finds:e2e -- --record`).
///   GENITA_FINDS_STATE = 1…19 (r03 frame numbers), 20 = IC-4 "can't see it", 21 = reason chips (D48 ③), 22 = budget reason chip (Knows-Me Map)
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
            return FindsFixtureRun(kind: kind, frames: frames, events: events)
        }
    }
}

extension FindsModel {
    func applyFixture(state n: Int) {
        let runs = FindsFixtureRun.load()
        guard let recipe = runs.first(where: { $0.kind == .recipe }) else { return }
        let outfit = runs.first { $0.kind == .outfit }
        let link = runs.first { $0.kind == .link }
        let noImages = { (r: FindsFixtureRun) in r.events.filter { if case .findImage = $0 { return false }; return true } }
        let untilCard = { (r: FindsFixtureRun) in Array(r.events.prefix { if case .findCreated = $0 { return false }; return true }) }
        func play(_ list: [(FindsFixtureRun, [ServerEvent])]) {
            reset()
            for (run, events) in list {
                latestFrames = run.frames.map { $0.base64EncodedString() }
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
        case 21:
            // D48 ③: the same recipe card with reason chips from the user's taste lines
            let withReasons = recipe.events.map { e -> ServerEvent in
                guard case var .findCreated(c) = e else { return e }
                c.card.reasons = [.init(text: "Your taste: quick weeknight food", source: "Quick, simple weeknight cooking.", from: "profile"), .init(text: "You said: no cilantro", source: "no cilantro", from: "call")]
                return .findCreated(c)
            }
            play([(recipe, withReasons)]); state = .half
        case 22:
            // Knows-Me Map: a budget reason chip from the profile ("Your budget: under $100"). The PF-1 product card
            // (kind "product") isn't on this branch (#171/#174), so the two priced picks ride on the outfit card.
            guard let outfit else { return }
            let picks = outfit.events.compactMap { e -> ServerEvent? in
                if case .observeBoxes = e { return nil }
                guard case var .findCreated(c) = e else { return e }
                c.card.eyebrow = "From what you said"
                c.card.title = "Two for the weekend"
                c.card.subtitle = "Two picks, $89 and $64"
                c.card.camera = nil
                c.card.options = []
                c.card.why = ["Cotton chore jacket, $89: clean lines, no logos.", "Linen overshirt, $64: an understated color."]
                c.card.reasons = [.init(text: "Your style: clean, minimal clothes", source: "Style: Clean, minimal clothes.", from: "profile"),
                                  .init(text: "Your budget: under $100", source: "Budget: usually under $100 for clothes.", from: "profile")]
                return .findCreated(c)
            }
            play([(outfit, picks)]); state = .half
        case 17: play([(recipe, recipe.events)]); state = .half; close()
        case 19: play([(recipe, recipe.events)]); state = .full; scrollTarget = "how"
        case 20:
            play([(recipe, Array(untilCard(recipe).prefix(1)))])
            if let id = entries.first?.id {
                apply(.findFailed(.init(findId: id, reason: .unclear, message: "I couldn't see the food clearly. Can you show me again with more light?")))
            }
            state = .searching
        default: break
        }
    }
}
#endif
