import Foundation
import Observation

// F10-U-FINDS · The Finds tab's data: what the server keeps (GET /v1/finds, saved first then newest), grouped the way
// the r03 board draws it (Saved · From today's call · Yesterday · older days). Platform-neutral; the phone draws it.

protocol FindsAPI: Sendable {
    func list() async throws -> [FindCard]
    func delete(_ id: String) async throws
    func restore(_ id: String) async throws
    func setSaved(_ id: String, _ saved: Bool) async throws
}

/// The REST side of PROTOCOL.md "Finds": same bearer token as the call, owner in `X-Genita-User`.
struct HTTPFindsAPI: FindsAPI {
    var base: URL
    var token: String?
    var user: String
    var session: URLSession = .shared

    init(endpoint: CallEndpoint, user: String, session: URLSession = .shared) {
        var c = URLComponents(url: endpoint.url, resolvingAgainstBaseURL: false) ?? URLComponents()
        c.scheme = c.scheme == "wss" ? "https" : "http"
        c.path = ""; c.query = nil
        self.base = c.url ?? endpoint.url
        self.token = endpoint.token
        self.user = user
        self.session = session
    }

    struct Failure: Error, Equatable { var status: Int }

    func request(_ method: String, _ path: String, body: [String: Any]? = nil) -> URLRequest {
        var r = URLRequest(url: URL(string: path, relativeTo: base)!.absoluteURL, timeoutInterval: 15)
        r.httpMethod = method
        r.setValue(user, forHTTPHeaderField: "X-Genita-User")
        if let token { r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        return r
    }

    private func send(_ r: URLRequest) async throws -> Data {
        let (data, response) = try await session.data(for: r)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw Failure(status: status) }
        return data
    }

    func list() async throws -> [FindCard] {
        struct Body: Decodable { var finds: [FindCard] }
        return try JSONDecoder().decode(Body.self, from: try await send(request("GET", "/v1/finds"))).finds
    }
    func delete(_ id: String) async throws { _ = try await send(request("DELETE", "/v1/finds/\(id)")) }
    func restore(_ id: String) async throws { _ = try await send(request("POST", "/v1/finds/\(id)/restore")) }
    func setSaved(_ id: String, _ saved: Bool) async throws { _ = try await send(request("POST", "/v1/finds/\(id)/save", body: ["saved": saved])) }
}

/// The camera frames a find was made from. The server never keeps them (PROTOCOL.md), so the app keeps its own copy
/// on the phone — only for finds the user made — to show "what the camera saw" when a card is reopened. Removed
/// with the find, and with the account (each account has its own folder, so deleting one never touches another's).
enum FindFrameStore {
    static var directory: URL = URL.applicationSupportDirectory.appending(path: "Genita/find-frames")
    /// The signed-in account (session JWT `sub`), nil when signed out.
    nonisolated(unsafe) static var owner: () -> String? = { CallController.tokenSubject(CallEndpoint.current().token) }

    /// This account's folder; frames saved before 11/4 sit loose in `directory` (read, and removed on any deletion).
    static func folder(_ owner: String?) -> URL {
        let name = (owner ?? "").unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_" }.prefix(64)
        return directory.appending(path: name.isEmpty ? "anon" : "a-" + String(String.UnicodeScalarView(name)))
    }
    private static func valid(_ id: String) -> Bool { id.range(of: #"^[A-Za-z0-9-]{8,64}$"#, options: .regularExpression) != nil }

    static func save(id: String, frames: [Data], owner: String? = owner()) {
        guard !frames.isEmpty, valid(id) else { return }
        let dir = folder(owner)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for (i, data) in frames.enumerated() { try? data.write(to: dir.appending(path: "\(id)-\(i).jpg"), options: .atomic) }
    }

    static func load(id: String, owner: String? = owner()) -> [Data] {
        guard valid(id) else { return [] }
        for dir in [folder(owner), directory] {
            var out: [Data] = []
            while let data = try? Data(contentsOf: dir.appending(path: "\(id)-\(out.count).jpg")) { out.append(data) }
            if !out.isEmpty { return out }
        }
        return []
    }

    static func remove(id: String, owner: String? = owner()) {
        guard valid(id) else { return }
        for dir in [folder(owner), directory] {
            var i = 0
            while FileManager.default.fileExists(atPath: dir.appending(path: "\(id)-\(i).jpg").path) {
                try? FileManager.default.removeItem(at: dir.appending(path: "\(id)-\(i).jpg"))
                i += 1
            }
        }
    }

    /// Account deleted (M02): its folder goes, and the loose pre-11/4 frames (no owner recorded) with it (AU-75).
    static func removeAll(owner: String?) {
        let fm = FileManager.default
        try? fm.removeItem(at: folder(owner))
        for url in (try? fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [] where url.pathExtension == "jpg" {
            try? fm.removeItem(at: url)
        }
    }
}

struct FindsRow: Identifiable, Equatable {
    var id: String { card.id }
    let card: FindCard
    var title: String { card.title }
    var saved: Bool { card.saved ?? false }

    /// r03 F1 second line: "Recipe · Needed rice", "Outfit · 2 frames", "Your link · couldn’t open".
    var subtitle: String {
        switch card.kind {
        case .recipe:
            let buy = card.items.filter { $0.tier == .buy && $0.optional != true }.map { $0.name.lowercased() }
            if buy.isEmpty { return "Recipe · " + (card.status ?? "You have it all") }
            return buy.count <= 2 ? "Recipe · Needed " + buy.joined(separator: ", ") : "Recipe · Missing \(buy.count)"
        case .outfit:
            let frames = max(1, Set(card.options.map(\.frame)).count)
            return "Outfit · \(frames) frame\(frames == 1 ? "" : "s")"
        case .link:
            if card.page?.opened == false { return "Your link · couldn’t open" }
            return "Your link" + (card.status.map { " · " + $0 } ?? "")
        case .product:
            let n = card.products?.count ?? 0
            return "Products · \(n) link\(n == 1 ? "" : "s")"
        case .unknown:
            return card.status ?? ""
        }
    }
}

struct FindsSection: Identifiable, Equatable {
    let id: String
    let title: String
    let rows: [FindsRow]
}

@MainActor @Observable final class FindsListModel {
    enum Phase: Equatable { case loading, loaded, failed }

    private(set) var cards: [FindCard] = []
    private(set) var phase: Phase = .loading
    /// A card the user just swiped away: "Deleted · Undo" until the window closes (the server keeps it 24 h).
    private(set) var removed: FindCard?
    @ObservationIgnored var api: FindsAPI
    @ObservationIgnored var now: () -> Date = Date.init
    @ObservationIgnored var calendar = Calendar.current
    @ObservationIgnored var undoWindow: Duration = .seconds(5)
    /// Frames the app kept for a find (camera box "at that moment").
    @ObservationIgnored var frames: (String) -> [Data] = { FindFrameStore.load(id: $0) }
    @ObservationIgnored var purge: (String) -> Void = { FindFrameStore.remove(id: $0) }
    @ObservationIgnored private var toastTask: Task<Void, Never>?
    @ObservationIgnored private var inFlight: [String: Task<Void, Error>] = [:]

    init(api: FindsAPI) { self.api = api }

    var isEmpty: Bool { phase == .loaded && cards.isEmpty }
    var sections: [FindsSection] { Self.sections(cards, now: now(), calendar: calendar) }
    var count: Int { cards.count }
    #if DEBUG
    func testSeed(_ list: [FindCard]) { cards = list; phase = .loaded }
    #endif

    func load() async {
        if cards.isEmpty { phase = .loading }
        do {
            let list = try await api.list()
            cards = list
            phase = .loaded
        } catch {
            phase = cards.isEmpty ? .failed : .loaded
        }
    }

    /// Optimistic: the row leaves at once; a failed call brings it back. The phone's copy of the camera frames goes
    /// only after the server delete succeeded AND the Undo window closed.
    func delete(_ id: String) async {
        guard let i = cards.firstIndex(where: { $0.id == id }) else { return }
        if let earlier = removed { purge(earlier.id) }
        let card = cards.remove(at: i)
        removed = card
        let request = Task { [api] in try await api.delete(id) }
        inFlight[id] = request
        toastTask?.cancel()
        toastTask = Task { [weak self] in
            try? await Task.sleep(for: self?.undoWindow ?? .seconds(5))
            guard let self, !Task.isCancelled, self.removed?.id == id else { return }
            self.removed = nil
            if (try? await request.value) != nil { self.purge(id) }
        }
        do { try await request.value } catch {
            inFlight[id] = nil
            if removed?.id == id { removed = nil; toastTask?.cancel() }
            restoreLocally(card)
        }
    }

    func undoDelete() async {
        guard let card = removed else { return }
        toastTask?.cancel()
        removed = nil
        restoreLocally(card)
        // restore must not overtake the delete it undoes
        if let request = inFlight[card.id] { _ = try? await request.value }
        inFlight[card.id] = nil
        do { try await api.restore(card.id) } catch { cards.removeAll { $0.id == card.id } }
    }

    func toggleSaved(_ id: String) async {
        guard let i = cards.firstIndex(where: { $0.id == id }) else { return }
        let was = cards[i].saved ?? false
        cards[i].saved = !was
        do { try await api.setSaved(id, !was) } catch {
            if let j = cards.firstIndex(where: { $0.id == id }) { cards[j].saved = was }
        }
    }

    /// Detail sheet's bookmark changed a card that is in the list.
    func markSaved(_ id: String, _ saved: Bool) {
        if let i = cards.firstIndex(where: { $0.id == id }) { cards[i].saved = saved }
    }

    private func restoreLocally(_ card: FindCard) {
        guard !cards.contains(where: { $0.id == card.id }) else { return }
        cards.append(card)
    }

    // MARK: grouping

    static func date(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: iso) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: iso)
    }

    /// "Today" / "Yesterday" / "Nov 1" for a day; `today` lets the list say "From today’s call".
    static func dayTitle(_ day: Date, now: Date, calendar: Calendar, today: String = "Today") -> String {
        if calendar.isDate(day, inSameDayAs: now) { return today }
        if let y = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(day, inSameDayAs: y) { return "Yesterday" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        f.dateFormat = calendar.isDate(day, equalTo: now, toGranularity: .year) ? "MMM d" : "MMM d, yyyy"
        return f.string(from: day)
    }

    /// Saved first, then days newest first: "From today’s call", "Yesterday", then "Nov 1"-style dates.
    static func sections(_ cards: [FindCard], now: Date, calendar: Calendar) -> [FindsSection] {
        let dated = cards.map { ($0, date($0.createdAt) ?? .distantPast) }
        let byNewest = dated.sorted { $0.1 > $1.1 }
        var out: [FindsSection] = []
        let saved = byNewest.filter { $0.0.saved == true }.map { FindsRow(card: $0.0) }
        if !saved.isEmpty { out.append(.init(id: "saved", title: "Saved", rows: saved)) }
        let rest = byNewest.filter { $0.0.saved != true }
        let days = Dictionary(grouping: rest) { calendar.startOfDay(for: $0.1) }
        for day in days.keys.sorted(by: >) {
            let title = dayTitle(day, now: now, calendar: calendar, today: "From today’s call")
            out.append(.init(id: "day-\(day.timeIntervalSince1970)", title: title, rows: days[day]!.map { FindsRow(card: $0.0) }))
        }
        return out
    }
}
