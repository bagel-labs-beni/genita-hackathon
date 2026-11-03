import AppKit
import Security

/// The app file is `Genita.app` (Chelsea 11/4: "GenitaMac 말고 Genita"). Builds up to 7 shipped as `GenitaMac.app`, and
/// Sparkle 2 installs an update at the installed bundle's own path (`SUInstaller`: it finds `Genita.app` in the DMG by
/// bundle id, then installs to `host.bundlePath`), so an updated Mac would keep the old file name — and Finder,
/// Spotlight, Launchpad and the Privacy & Security lists show the file name. So at launch a copy still called
/// `GenitaMac.app` renames itself to `Genita.app` and reopens from there. Permissions (TCC), UserDefaults, Keychain and
/// Sparkle's state are keyed by bundle id + Developer ID signature, not by the path, so they carry over.
///
/// If a `Genita.app` signed by the same developer (our designated requirement) already sits next to it — a fresh DMG
/// install beside an old copy — the older of the two goes to the Trash (recoverable) and the newer one is the one that
/// runs; if that `Genita.app` is already running, this copy hands over to it and quits (one Mac client per account).
/// A sibling that fails the signature check is never opened, trashed or replaced.
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
        /// The trusted `Genita.app` beside it is already running: bring it forward and quit this copy.
        case yieldToRunning(sibling: URL)
    }

    struct AppCopy: Equatable {
        var url: URL
        var bundleID: String?
        var build: Int?
    }

    /// Pure decision (tested in `mac-app/Tools/bundle-name/check.sh`).
    /// `siblingTrusted`: the sibling passes this app's own designated requirement (same Developer ID team + bundle id).
    static func plan(current: AppCopy, parentWritable: Bool, readOnlyVolume: Bool, sibling: AppCopy?, siblingTrusted: Bool, siblingRunning: Bool) -> Action {
        guard current.url.lastPathComponent == legacyFileName else { return .none }
        // Handing over to a running trusted copy moves no files, so it comes before the write checks (Codex re-review P2).
        if let sibling, siblingTrusted, siblingRunning, let id = current.bundleID, sibling.bundleID == id {
            return .yieldToRunning(sibling: sibling.url)
        }
        // A quarantined app launched in place runs from a read-only App Translocation mount: nothing to rename.
        guard parentWritable, !readOnlyVolume, !current.url.path.contains("/AppTranslocation/") else { return .none }
        let target = current.url.deletingLastPathComponent().appendingPathComponent(fileName)
        guard let sibling else { return .rename(to: target) }
        guard siblingTrusted, !siblingRunning, let id = current.bundleID, sibling.bundleID == id else { return .none }
        guard let mine = current.build, let theirs = sibling.build else { return .none }
        return theirs >= mine ? .openNewer(sibling: sibling.url) : .replaceOlder(sibling: sibling.url)
    }

    /// Carries out `action`. Returns true when another copy was opened and this process must exit now.
    /// Every failure leaves a working app: a failed reopen moves the bundle back and this process keeps running.
    static func perform(_ action: Action, current: URL, fileManager fm: FileManager = .default,
                        trash: (URL) -> Bool = { (try? FileManager.default.trashItem(at: $0, resultingItemURL: nil)) != nil },
                        activate: (URL) -> Bool = { _ in false },
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
        case .yieldToRunning(let sibling):
            return activate(sibling)
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
        let trusted = sibling != nil && sameSigner(siblingURL)
        let runningSibling = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
            .first { $0.bundleURL?.standardizedFileURL == siblingURL.standardizedFileURL }
        let readOnly = (try? url.resourceValues(forKeys: [.volumeIsReadOnlyKey]).volumeIsReadOnly) ?? true
        let action = plan(current: info(url), parentWritable: fm.isWritableFile(atPath: parent.path),
                          readOnlyVolume: readOnly, sibling: sibling, siblingTrusted: trusted, siblingRunning: runningSibling != nil)
        NSLog("Genita bundle name: %@ → %@", url.path, String(describing: action))
        if perform(action, current: url, activate: { open($0, newInstance: false) }, open: { open($0, newInstance: true) }) { exit(0) }
    }

    private static func info(_ url: URL) -> AppCopy {
        let plist = Bundle(url: url)?.infoDictionary
        return AppCopy(url: url, bundleID: plist?["CFBundleIdentifier"] as? String,
                      build: (plist?["CFBundleVersion"] as? String).flatMap(Int.init))
    }

    /// The sibling's signature satisfies this running app's designated requirement (identifier + Developer ID team).
    /// Unsigned / ad-hoc builds (DEBUG, CI) have no team requirement a sibling could meet → false.
    static func sameSigner(_ url: URL) -> Bool {
        var me: SecCode?, meStatic: SecStaticCode?, requirement: SecRequirement?, other: SecStaticCode?
        guard SecCodeCopySelf([], &me) == errSecSuccess, let me,
              SecCodeCopyStaticCode(me, [], &meStatic) == errSecSuccess, let meStatic,
              SecCodeCopyDesignatedRequirement(meStatic, [], &requirement) == errSecSuccess, let requirement,
              SecStaticCodeCreateWithPath(url as CFURL, [], &other) == errSecSuccess, let other else { return false }
        return SecStaticCodeCheckValidity(other, SecCSFlags(rawValue: kSecCSCheckAllArchitectures), requirement) == errSecSuccess
    }

    /// `open -n` starts the moved copy (this process, same bundle id, is still alive, so a plain open would only
    /// activate it). A plain `open` of the running sibling's path activates it and sends Reopen, so its home window
    /// comes back through `applicationShouldHandleReopen` even if it was closed.
    private static func open(_ url: URL, newInstance: Bool) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        p.arguments = newInstance ? ["-n", url.path] : [url.path]
        guard (try? p.run()) != nil else { return false }
        p.waitUntilExit()
        return p.terminationStatus == 0
    }
}
