import AppKit

/// The app file is `Genita.app` (Chelsea 11/4: "GenitaMac 말고 Genita"). Builds up to 7 shipped as `GenitaMac.app`, and
/// Sparkle 2 installs an update at the installed bundle's own path (`SUInstaller`: it finds `Genita.app` in the DMG by
/// bundle id, then installs to `host.bundlePath`), so an updated Mac would keep the old file name — and Finder,
/// Spotlight, Launchpad and the Privacy & Security lists show the file name. So at launch a copy still called
/// `GenitaMac.app` renames itself to `Genita.app` and reopens from there. Permissions (TCC), UserDefaults, Keychain and
/// Sparkle's state are keyed by bundle id + Developer ID signature, not by the path, so they carry over.
///
/// If a `Genita.app` with the same bundle id already sits next to it (a fresh DMG install beside an old copy), the
/// older of the two goes to the Trash (recoverable) and the newer one is the one that runs.
enum MacBundleName {
    static let legacyFileName = "GenitaMac.app"
    static let fileName = "Genita.app"

    enum Action: Equatable {
        case none
        /// Move this bundle to `to` (no sibling there) and reopen it.
        case rename(to: URL)
        /// A same-id `Genita.app` that is older than this build: trash it, move this bundle there, reopen.
        case replaceOlder(sibling: URL)
        /// A same-id `Genita.app` that is this build or newer: open it and trash this copy.
        case openNewer(sibling: URL)
    }

    struct AppCopy: Equatable {
        var url: URL
        var bundleID: String?
        var build: Int?
    }

    /// Pure decision (tested in `mac-app/Tools/bundle-name/check.sh`).
    static func plan(current: AppCopy, parentWritable: Bool, readOnlyVolume: Bool, sibling: AppCopy?, siblingRunning: Bool) -> Action {
        guard current.url.lastPathComponent == legacyFileName else { return .none }
        // A quarantined app launched in place runs from a read-only App Translocation mount: nothing to rename.
        guard parentWritable, !readOnlyVolume, !current.url.path.contains("/AppTranslocation/") else { return .none }
        let target = current.url.deletingLastPathComponent().appendingPathComponent(fileName)
        guard let sibling else { return .rename(to: target) }
        guard !siblingRunning, let id = current.bundleID, sibling.bundleID == id,
              let mine = current.build, let theirs = sibling.build else { return .none }
        return theirs >= mine ? .openNewer(sibling: sibling.url) : .replaceOlder(sibling: sibling.url)
    }

    /// Carries out `action`. Returns true when another copy was opened and this process must exit now.
    /// Every failure leaves a working app: a failed reopen moves the bundle back and this process keeps running.
    static func perform(_ action: Action, current: URL, fileManager fm: FileManager = .default,
                        trash: (URL) -> Bool = { (try? FileManager.default.trashItem(at: $0, resultingItemURL: nil)) != nil },
                        open: (URL) -> Bool) -> Bool {
        switch action {
        case .none:
            return false
        case .rename(let target):
            return move(current, to: target, fm: fm, open: open)
        case .replaceOlder(let sibling):
            guard trash(sibling) else { return false }
            return move(current, to: sibling, fm: fm, open: open)
        case .openNewer(let sibling):
            guard open(sibling) else { return false }
            _ = trash(current) // best effort: the newer copy is already running
            return true
        }
    }

    private static func move(_ current: URL, to target: URL, fm: FileManager, open: (URL) -> Bool) -> Bool {
        guard (try? fm.moveItem(at: current, to: target)) != nil else { return false }
        if open(target) { return true }
        try? fm.moveItem(at: target, to: current) // could not reopen: put it back and keep running from here
        return false
    }

    /// Called first thing at launch, before any window, socket or Sparkle session exists.
    @MainActor static func fixOnLaunch() {
        guard !ProcessInfo.processInfo.arguments.contains("--uitesting") else { return }
        let fm = FileManager.default
        let url = Bundle.main.bundleURL
        guard url.lastPathComponent == legacyFileName else { return } // fresh installs: nothing to do
        let parent = url.deletingLastPathComponent()
        let siblingURL = parent.appendingPathComponent(fileName)
        let sibling = fm.fileExists(atPath: siblingURL.path) ? info(siblingURL) : nil
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
            .contains { $0.bundleURL?.standardizedFileURL == siblingURL.standardizedFileURL }
        let readOnly = (try? url.resourceValues(forKeys: [.volumeIsReadOnlyKey]).volumeIsReadOnly) ?? true
        let action = plan(current: info(url), parentWritable: fm.isWritableFile(atPath: parent.path),
                          readOnlyVolume: readOnly, sibling: sibling, siblingRunning: running)
        NSLog("Genita bundle name: %@ → %@", url.path, String(describing: action))
        if perform(action, current: url, open: reopen) { exit(0) }
    }

    private static func info(_ url: URL) -> AppCopy {
        let plist = Bundle(url: url)?.infoDictionary
        return AppCopy(url: url, bundleID: plist?["CFBundleIdentifier"] as? String,
                      build: (plist?["CFBundleVersion"] as? String).flatMap(Int.init))
    }

    /// `open -n`: this process (same bundle id) is still alive, so a plain open would only activate it.
    private static func reopen(_ url: URL) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        p.arguments = ["-n", url.path]
        guard (try? p.run()) != nil else { return false }
        p.waitUntilExit()
        return p.terminationStatus == 0
    }
}
