import AppKit

/// Server-driven config on the Mac (GET /v1/app-config): read at launch and whenever the app becomes active
/// (the store throttles to once a minute). Bundled defaults until the first answer; the last one is cached.
enum MacAppConfig {
    @MainActor private static var observer: NSObjectProtocol?

    @MainActor static func start() {
        guard observer == nil, !ProcessInfo.processInfo.arguments.contains("--uitesting") else { return }
        Task { await GenitaAppConfigStore.shared.refresh(force: true) }
        observer = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in await GenitaAppConfigStore.shared.refresh() }
        }
    }
}
