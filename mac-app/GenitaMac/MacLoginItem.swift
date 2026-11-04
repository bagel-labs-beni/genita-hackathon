import AppKit
import Foundation
import ServiceManagement
import os

/// Open at login (CEO 11/4, proximity "징" without opening Genita first): macOS cannot wake a quit app from Bluetooth,
/// so the Mac app stays resident. After the first successful sign-in it registers itself as a login item
/// (`SMAppService.mainApp`, macOS 13+) and starts hidden at login with the presence socket and the proximity scanner
/// ready; a proximity move then opens the call window by itself (MacHandoff.ownerChanged → showCompanion).
///
/// - Registration is only ever `register()` / `unregister()`; nothing else in System Settings is touched. When macOS
///   wants the user's approval (`.requiresApproval`), Settings shows one line pointing at System Settings ▸ Login Items.
/// - Settings ▸ "Open at login" (on by default) is the user's switch. Turning Genita off in System Settings is respected:
///   the first-sign-in registration happens once, never again on later launches.
/// - The policy is pure apart from the injected service, so mac-app/Tools/login-item/check.sh tests it without Xcode.
enum LoginItemStatus: Equatable {
    case enabled
    case requiresApproval
    case notRegistered
    case notFound
}

protocol LoginItemService: AnyObject {
    var status: LoginItemStatus { get }
    func register() throws
    func unregister() throws
}

/// The real login item: this app (`SMAppService.mainApp`).
final class SystemLoginItemService: LoginItemService {
    var status: LoginItemStatus {
        switch SMAppService.mainApp.status {
        case .enabled: .enabled
        case .requiresApproval: .requiresApproval
        case .notRegistered: .notRegistered
        default: .notFound
        }
    }
    func register() throws { try SMAppService.mainApp.register() }
    func unregister() throws { try SMAppService.mainApp.unregister() }
}

/// CI review renders and the harnesses: never registers anything on the machine running them.
final class InertLoginItemService: LoginItemService {
    var status: LoginItemStatus = .notRegistered
    func register() throws {}
    func unregister() throws {}
}

@MainActor final class MacLoginItem: ObservableObject {
    static let shared = MacLoginItem(
        service: ProcessInfo.processInfo.environment["GENITA_MAC_REVIEW_OUT"] == nil ? SystemLoginItemService() : InertLoginItemService())

    /// The user's choice; absent = on (the default).
    static let enabledKey = "genita.loginItem.enabled"
    /// Set once the first-sign-in registration (or the user's own toggle) has happened.
    static let configuredKey = "genita.loginItem.configured"

    @Published private(set) var status: LoginItemStatus
    private let service: LoginItemService
    private let defaults: UserDefaults
    private let bundlePath: () -> String
    private let log = Logger(subsystem: "ai.thebeni.genita", category: "login-item")

    init(service: LoginItemService, defaults: UserDefaults = .standard, bundlePath: @escaping () -> String = { Bundle.main.bundleURL.path }) {
        self.service = service
        self.defaults = defaults
        self.bundlePath = bundlePath
        self.status = service.status
    }

    var configured: Bool {
        #if DEBUG
        if reviewPinned { return true }
        #endif
        return defaults.bool(forKey: Self.configuredKey)
    }
    private var preference: Bool { defaults.object(forKey: Self.enabledKey) as? Bool ?? true }

    /// What the Settings switch shows: before the first registration the default (on); after it, what macOS says,
    /// so turning Genita off in System Settings shows off here too.
    var isOn: Bool { configured ? (status == .enabled || status == .requiresApproval) : preference }
    /// Registered, waiting for the user to approve it in System Settings ▸ Login Items.
    var needsApproval: Bool { isOn && status == .requiresApproval }

    /// A copy run from the disk image or a translocated (quarantined, not yet moved) location would register a path
    /// that disappears; wait for the copy in Applications.
    var transientLocation: Bool {
        let path = bundlePath()
        return path.hasPrefix("/Volumes/") || path.contains("/AppTranslocation/")
    }

    /// After a successful sign-in (`/me` answered for a signed-in account). Registers once, on the first one. A
    /// failed register() is tried again on the next launch (Codex P2), never more than once per launch.
    func signedIn() {
        refresh()
        guard !configured, !transientLocation, !triedThisLaunch else { return }
        guard preference else { defaults.set(true, forKey: Self.configuredKey); return }
        triedThisLaunch = true
        apply(true)
        if status == .enabled || status == .requiresApproval { defaults.set(true, forKey: Self.configuredKey) }
    }
    private var triedThisLaunch = false

    /// Settings ▸ Open at login.
    func setOn(_ on: Bool) {
        defaults.set(on, forKey: Self.enabledKey)
        defaults.set(true, forKey: Self.configuredKey)
        apply(on)
    }

    /// Re-read macOS's state (Settings opening, the user may have changed it in System Settings meanwhile).
    func refresh() {
        #if DEBUG
        if reviewPinned { return }
        #endif
        status = service.status
    }

    /// Opens System Settings at Login Items (only opens the pane; the user approves there).
    func openLoginItemsSettings() { SMAppService.openSystemSettingsLoginItems() }

    private func apply(_ on: Bool) {
        let now = service.status
        // register() again on an enabled item / unregister() on a missing one only throws; nothing to do
        if on, now == .enabled || now == .requiresApproval { status = now; return }
        if !on, now == .notRegistered || now == .notFound { status = now; return }
        do {
            if on { try service.register() } else { try service.unregister() }
        } catch {
            // .requiresApproval comes back as an error from register() on some systems; the status says what happened
            log.info("login item \(on ? "register" : "unregister", privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
        }
        status = service.status
        log.info("login item status \(String(describing: self.status), privacy: .public)")
    }

    #if DEBUG
    /// review renders only (watch-shots harness): pins the state in memory, never in the defaults
    private var reviewPinned = false
    func reviewStatus(_ next: LoginItemStatus) { reviewPinned = true; status = next }
    #endif
}

/// Was this launch macOS opening Genita at login? Read in `applicationDidFinishLaunching`, while the launch's
/// `kAEOpenApplication` event is current (`keyAELaunchedAsLogInItem`, also set for `SMAppService.mainApp`).
/// `GENITA_LAUNCHED_AT_LOGIN=1` simulates it (dev runs, the hidden-launch check).
enum MacLoginLaunch {
    static func wasLaunchedAtLogin(event: NSAppleEventDescriptor?, environment: [String: String] = ProcessInfo.processInfo.environment) -> Bool {
        if let v = environment["GENITA_LAUNCHED_AT_LOGIN"] { return ["1", "true", "yes"].contains(v.lowercased()) }
        guard let event, event.eventID == AEEventID(kAEOpenApplication) else { return false }
        return event.paramDescriptor(forKeyword: AEKeyword(keyAEPropData))?.enumCodeValue == OSType(keyAELaunchedAsLogInItem)
    }
}
