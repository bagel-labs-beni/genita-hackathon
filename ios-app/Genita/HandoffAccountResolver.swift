import Foundation

/// A missing handoff scope is retried on demand. One request burst is bounded; resume or a
/// recovered call can start another burst after it finishes, without trusting a saved user ID.
@MainActor final class HandoffAccountResolver {
    private var task: Task<Void, Never>?
    private var generation = 0

    func invalidate() {
        generation += 1
        task?.cancel()
        task = nil
    }

    @discardableResult
    func resolve(snapshot: LaunchAuthSnapshot, current: @escaping () -> LaunchAuthSnapshot,
                 fetch: @escaping () async -> GenitaSessionState, adopt: @escaping (String) -> Void,
                 expired: @escaping () -> Void,
                 sleep: @escaping (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) -> Task<Void, Never>? {
        guard snapshot.token != nil else { return nil }
        if let task { return task }
        let generation = self.generation
        let task = Task { [weak self] in
            defer { if self?.generation == generation { self?.task = nil } }
            for attempt in 0..<3 {
                guard !Task.isCancelled, self?.generation == generation, snapshot.accepts(current()) else { return }
                let state = await fetch()
                guard !Task.isCancelled, self?.generation == generation, snapshot.generation == current().generation else { return }
                if case .expired = state {
                    // The current auth client clears the token on 401. An older authentication
                    // lifetime must never sign out a newer one, even if its token was also cleared.
                    if current().token == nil { expired() }
                    return
                }
                guard snapshot.accepts(current()) else { return }
                switch state {
                case .active(let me): adopt(me.user.id); return
                case .offline:
                    guard attempt < 2 else { return }
                    do { try await sleep(.seconds(attempt == 0 ? 1 : 2)) } catch { return }
                case .expired, .signedOut: return
                }
            }
        }
        self.task = task
        return task
    }
}
