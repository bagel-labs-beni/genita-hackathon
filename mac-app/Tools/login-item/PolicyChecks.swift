// Open at login policy (MacLoginItem): first sign-in registers, the Settings switch registers / unregisters, macOS's
// approval state and the user's own System Settings choice are respected. Built by check.sh with MacLoginItem.swift.
import AppKit
import Foundation

final class FakeLoginItemService: LoginItemService {
    var status: LoginItemStatus = .notRegistered
    /// what register() leaves behind (macOS may want approval)
    var statusAfterRegister: LoginItemStatus = .enabled
    var registerThrows = false
    private(set) var calls: [String] = []
    struct Failed: Error {}
    func register() throws {
        calls.append("register")
        status = statusAfterRegister
        if registerThrows { throw Failed() }
    }
    func unregister() throws {
        calls.append("unregister")
        status = .notRegistered
    }
}

@main struct PolicyChecks {
    nonisolated(unsafe) static var failures = 0
    static func check(_ ok: Bool, _ name: String) {
        print(ok ? "ok   " : "FAIL ", name)
        if !ok { failures += 1 }
    }

    @MainActor static func fresh(_ name: String, bundle: String = "/Applications/Genita.app") -> (MacLoginItem, FakeLoginItemService, UserDefaults) {
        let suite = "genita.login-item-check.\(name).\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        let service = FakeLoginItemService()
        return (MacLoginItem(service: service, defaults: defaults, bundlePath: { bundle }), service, defaults)
    }

    @MainActor static func main() {
        do { // first run: the first successful sign-in registers, once
            let (item, service, _) = fresh("first-run")
            check(item.isOn, "first run: the switch shows on before anything is registered (default on)")
            item.signedIn()
            check(service.calls == ["register"], "first run: sign-in registers the login item")
            check(item.status == .enabled && item.isOn && !item.needsApproval, "first run: enabled, switch on, no approval line")
            item.signedIn(); item.signedIn()
            check(service.calls == ["register"], "later sign-ins / refreshes never register again")
        }
        do { // toggle off → unregister; on → register again
            let (item, service, defaults) = fresh("toggle")
            item.signedIn()
            item.setOn(false)
            check(service.calls == ["register", "unregister"], "toggle off: unregisters")
            check(!item.isOn && defaults.object(forKey: MacLoginItem.enabledKey) as? Bool == false, "toggle off: switch off, choice stored")
            item.setOn(false)
            check(service.calls == ["register", "unregister"], "toggle off again: nothing (already not registered)")
            item.setOn(true)
            check(service.calls == ["register", "unregister", "register"] && item.isOn, "toggle on: registers again")
            item.setOn(true)
            check(service.calls.count == 3, "toggle on while enabled: no second register")
        }
        do { // the user turned it off before the first sign-in: the sign-in respects it
            let (item, service, _) = fresh("off-before-sign-in")
            item.setOn(false)
            item.signedIn()
            check(!service.calls.contains("register"), "switched off before signing in: sign-in does not register")
        }
        do { // the first register() fails: tried again on the next launch, not every refresh of this one
            let suite = "genita.login-item-check.retry.\(UUID().uuidString)"
            let defaults = UserDefaults(suiteName: suite)!
            let service = FakeLoginItemService()
            service.statusAfterRegister = .notFound
            service.registerThrows = true
            let first = MacLoginItem(service: service, defaults: defaults, bundlePath: { "/Applications/Genita.app" })
            first.signedIn(); first.signedIn()
            check(service.calls == ["register"] && !first.configured, "failed register: not marked done, once per launch")
            service.statusAfterRegister = .enabled
            service.registerThrows = false
            let next = MacLoginItem(service: service, defaults: defaults, bundlePath: { "/Applications/Genita.app" })
            next.signedIn()
            check(service.calls == ["register", "register"] && next.configured && next.isOn, "failed register: the next launch registers")
            defaults.removePersistentDomain(forName: suite)
        }
        do { // macOS wants approval
            let (item, service, _) = fresh("approval")
            service.statusAfterRegister = .requiresApproval
            service.registerThrows = true // register() can throw while leaving the item waiting for approval
            item.signedIn()
            check(item.status == .requiresApproval, "approval: status read back after register() threw")
            check(item.isOn && item.needsApproval, "approval: switch on, one approval line shown")
            item.setOn(true)
            check(service.calls == ["register"], "approval: switching on again doesn't re-register a waiting item")
            item.setOn(false)
            check(service.calls == ["register", "unregister"] && !item.needsApproval, "approval: switching off unregisters, line gone")
        }
        do { // removed in System Settings after the first registration: respected, not re-added
            let (item, service, _) = fresh("removed-in-system-settings")
            item.signedIn()
            service.status = .notRegistered
            item.refresh()
            check(!item.isOn, "removed in System Settings: the switch shows off")
            item.signedIn()
            check(service.calls == ["register"], "removed in System Settings: a later sign-in doesn't add it back")
        }
        do { // run from the disk image / translocated: wait for the copy in Applications
            let (item, service, _) = fresh("dmg", bundle: "/Volumes/Genita/Genita.app")
            item.signedIn()
            check(service.calls.isEmpty && !item.configured, "run from the DMG: no registration yet")
            let (moved, movedService, _) = fresh("translocated", bundle: "/private/var/folders/x/AppTranslocation/ABC/d/Genita.app")
            moved.signedIn()
            check(movedService.calls.isEmpty, "translocated copy: no registration yet")
        }
        do { // launched at login detection
            let event = NSAppleEventDescriptor(eventClass: AEEventClass(kCoreEventClass), eventID: AEEventID(kAEOpenApplication),
                                               targetDescriptor: nil, returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
            check(!MacLoginLaunch.wasLaunchedAtLogin(event: event, environment: [:]), "login launch: a plain open is not a login launch")
            event.setParam(NSAppleEventDescriptor(enumCode: OSType(keyAELaunchedAsLogInItem)), forKeyword: AEKeyword(keyAEPropData))
            check(MacLoginLaunch.wasLaunchedAtLogin(event: event, environment: [:]), "login launch: keyAELaunchedAsLogInItem is a login launch")
            check(!MacLoginLaunch.wasLaunchedAtLogin(event: nil, environment: [:]), "login launch: no event is not a login launch")
            check(MacLoginLaunch.wasLaunchedAtLogin(event: nil, environment: ["GENITA_LAUNCHED_AT_LOGIN": "1"]), "login launch: env simulates it")
            check(!MacLoginLaunch.wasLaunchedAtLogin(event: event, environment: ["GENITA_LAUNCHED_AT_LOGIN": "0"]), "login launch: env 0 overrides")
        }
        print(failures == 0 ? "login item policy: all passed" : "login item policy: \(failures) failed")
        exit(failures == 0 ? 0 : 1)
    }
}
