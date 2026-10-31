import Foundation
import Observation

enum Stage: String, Codable, CaseIterable {
    case welcome, signIn, name, prompt, paste, preparing, preferences, image, voice
    case depth, help, relationship, challenge, tempo, initiative, boundaries, presence, summary, connecting, conversation
}
enum SetupDepth: String, Codable, CaseIterable { case quick, right, deep
    var title: String { switch self { case .quick: "Quick start"; case .right: "Make it feel right"; case .deep: "Deep setup" } }
    var detail: String { switch self { case .quick: "About 3 minutes"; case .right: "About 8 minutes · recommended"; case .deep: "About 15 minutes" } }
    var path: [Stage] {
        switch self {
        case .quick: [.depth, .help, .relationship, .presence, .summary]
        case .right: [.depth, .help, .relationship, .challenge, .tempo, .presence, .summary]
        case .deep: [.depth, .help, .relationship, .challenge, .tempo, .initiative, .boundaries, .presence, .summary]
        }
    }
}
struct SavedSetup: Codable {
    var stage: Stage = .welcome
    var name = ""
    var response = ""
    var depth: SetupDepth = .right
    var voice: Int?
    var answers: [String: String] = [:]
    var boundaries: Set<String> = []
    var presence: Set<String> = []
    var presenceCardIDs: Set<String>? = nil
    var imageData: Data?
    var hasOnboarded = false
    enum CodingKeys: String, CodingKey { case stage, name, response, depth, voice, answers, boundaries, presence, presenceCardIDs, hasOnboarded }

}
@MainActor @Observable final class AppState {
    var setup: SavedSetup { didSet { if oldValue.imageData != setup.imageData { saveImage() }; save() } }
    var history: [Stage] = []
    var settingsOpen = false
    var menuOpen = false
    var storage: UserDefaults
    let imageURL: URL
    nonisolated static var defaultImageURL: URL { URL.applicationSupportDirectory.appending(path: "Genita/companion.jpg") }

    static let storageKey = "genita.native.setup.v1"
    static let prompt = "Based only on what you know about me from our conversations, write a concise profile for my AI companion. Use these headings: Communication style, Response preferences, Interests, Likes & dislikes, and Boundaries. Include only preferences I have explicitly shared or clearly demonstrated. Mark uncertain points and say “Not enough information” when needed. Do not invent facts or include sensitive details, private names, past events, or ongoing tasks. Write in English, in short bullet points, with no introduction. Return only the profile so I can paste it into Genita."
    init(storage: UserDefaults = .standard, reset: Bool = false, imageURL: URL = AppState.defaultImageURL) {
        self.storage = storage
        self.imageURL = imageURL
        if reset { storage.removeObject(forKey: Self.storageKey); try? FileManager.default.removeItem(at: imageURL) }
        if let data = storage.data(forKey: Self.storageKey), let saved = try? JSONDecoder().decode(SavedSetup.self, from: data) { setup = saved } else { setup = SavedSetup() }
        setup.imageData = try? Data(contentsOf: imageURL)
        if setup.hasOnboarded { setup.stage = .conversation }
        else if setup.stage == .preparing { setup.stage = .paste }
        else if setup.stage == .connecting { setup.stage = .summary }
        #if DEBUG
        if let raw = ProcessInfo.processInfo.environment["GENITA_REVIEW_STAGE"], let reviewStage = Stage(rawValue: raw) {
            let variant = ProcessInfo.processInfo.environment["GENITA_REVIEW_VARIANT"] ?? ""
            setup.name = variant == "empty" ? "" : "Dyno"
            setup.response = variant == "empty" ? "" : "Communication style\n• Warm, direct, and informal.\nResponse preferences\n• Specific feedback and clear alternatives.\nInterests\n• Visual design and building products.\nLikes & dislikes\n• Concrete examples over generic praise.\nBoundaries\n• Ask before taking action for me."
            setup.voice = variant == "empty" ? nil : 0
            setup.depth = SetupDepth(rawValue: variant) ?? .right
            if variant != "empty" {
                setup.answers = ["help": "Think with me", "relationship": "Trusted partner", "challenge": "2", "tempo": "2", "initiative": "2"]
                setup.boundaries = ["Message anyone for me"]
                setup.presence = ["Calm"]
            }
            if variant == "image" || reviewStage == .conversation || reviewStage == .connecting,
               let url = Bundle.main.url(forResource: "companion", withExtension: "png") { setup.imageData = try? Data(contentsOf: url) }
            else { setup.imageData = nil }
            setup.stage = reviewStage
        }
        #endif
    }
    var stage: Stage { setup.stage }
    var validResponse: Bool { !setup.response.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    var validName: Bool { !setup.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private func saveImage() {
        guard let data = setup.imageData else { try? FileManager.default.removeItem(at: imageURL); return }
        try? FileManager.default.createDirectory(at: imageURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: imageURL, options: [.atomic, .completeFileProtection])
    }
    func save() { if let data = try? JSONEncoder().encode(setup) { storage.set(data, forKey: Self.storageKey) } }
    func go(_ stage: Stage) {
        // The processing screen is transient: back from the next screen must not replay it.
        if setup.stage == .preparing { if stage != .preferences { history.append(.preferences) } }
        else { history.append(setup.stage) }
        setup.stage = stage
    }
    func back() {
        if let previous = history.popLast() { setup.stage = previous; return }
        let fallback: [Stage: Stage] = [.signIn: .welcome, .name: .signIn, .prompt: .name, .paste: .prompt, .preferences: .paste, .image: .preferences, .voice: .image, .depth: .voice]
        if let previous = fallback[stage] { setup.stage = previous }
        else if let i = setup.depth.path.firstIndex(of: stage), i > 0 { setup.stage = setup.depth.path[i - 1] }
    }
    func returnTo(_ stage: Stage) {
        if let index = history.lastIndex(of: stage) { history = Array(history.prefix(index)) }
        else { history.removeAll() }
        setup.stage = stage
    }
    func nextPreference() {
        let path = setup.depth.path
        if let i = path.firstIndex(of: stage), i + 1 < path.count { go(path[i + 1]) }
    }
    func complete() { setup.hasOnboarded = true; setup.stage = .conversation; history = [] }
    func answer(_ key: String, _ value: String) { setup.answers[key] = value }
    func toggleBoundary(_ value: String) { if setup.boundaries.contains(value) { setup.boundaries.remove(value) } else { setup.boundaries.insert(value) } }
    func togglePresence(_ value: String) { if setup.presence.contains(value) { setup.presence.remove(value) } else { setup.presence.insert(value) } }
}
