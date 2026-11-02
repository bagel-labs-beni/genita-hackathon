import SwiftUI
import AppKit
import CoreBluetooth
import AVFoundation
import os

/// Proximity handoff on the Mac (rules: shared/Handoff/ProximityHandoff.swift, server: PROTOCOL.md "Proximity").
///
/// While the same account's iPhone holds the conversation and is in front, the Mac scans for Genita's Bluetooth
/// service. When one iPhone's token stays close (−45 dBm or stronger for 0.5 s, see `ProximityDetector`) it reports
/// the token; the server checks it is this account's and moves the conversation here. The move itself is the usual
/// ownership change (MacHandoff shows the companion, MacCall continues the call with its turns, #209; the companion's
/// fade-in is the presence lane's GENITA_PRESENCE_FADE, #303). This adds the Mac's half of the moment: the Connected
/// chime and a one-line toast. Bluetooth is asked for the first time it is useful (iPhone in a call), never at launch.
/// Off entirely unless `ProximityHandoffFlag`.
@MainActor final class MacProximity: NSObject, ObservableObject, CBCentralManagerDelegate {
    static let shared = MacProximity()
    /// What the scanner sees, for QA (`log stream --predicate 'category == "proximity"'` shows the same).
    @Published private(set) var debugLine = ""
    private weak var handoff: MacHandoff?
    private var central: CBCentralManager?
    private var scanning = false
    private var detector = ProximityDetector(config: .current())
    /// peripheral → the token it advertised last (the local name can arrive in a later scan response)
    private var tokens: [UUID: String] = [:]
    private var timer: Timer?
    private var toastWindow: NSPanel?
    private var chime: AVAudioPlayer?
    private var moment = 0
    private var lastLog = 0.0
    private let log = Logger(subsystem: "ai.thebeni.genita", category: "proximity")

    func attach(_ handoff: MacHandoff) {
        guard self.handoff == nil else { return }
        self.handoff = handoff
        handoff.server.onMessage = { [weak self] m in self?.receive(m) }
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in Task { @MainActor in self?.tick() } }
    }

    private var enabled: Bool { ProximityHandoffFlag.enabled(remote: GenitaAppConfigStore.shared.config.flag("proximityHandoff", default: false)) }

    private func tick() {
        guard let handoff else { return }
        let wanted = ProximityPolicy.macShouldScan(enabled: enabled, macOwner: handoff.ownership.isOwner, serverConnected: handoff.server.connected, phoneActive: handoff.server.peerActive)
        guard wanted else { return stopScan() }
        guard let central else {
            // First time it is useful: this creates the Bluetooth permission prompt (NSBluetoothAlwaysUsageDescription).
            central = CBCentralManager(delegate: self, queue: .main, options: [CBCentralManagerOptionShowPowerAlertKey: false])
            return
        }
        guard central.state == .poweredOn else { return stopScan() }
        guard !scanning else { return }
        scanning = true
        detector = ProximityDetector(config: .current())
        tokens = [:]
        // Duplicates on: every advertisement is an RSSI reading for the hold.
        central.scanForPeripherals(withServices: [CBUUID(string: ProximityToken.serviceUUID)], options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
        log.info("proximity scanning")
    }

    private func stopScan() {
        guard scanning else { return }
        scanning = false
        central?.stopScan()
        debugLine = ""
    }

    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        MainActor.assumeIsolated {
            log.info("bluetooth state \(central.state.rawValue, privacy: .public)")
            if central.state != .poweredOn { scanning = false }
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let id = peripheral.identifier
        let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String
        let rssi = RSSI.intValue
        MainActor.assumeIsolated { seen(id, name: name, rssi: rssi) }
    }

    private func seen(_ id: UUID, name: String?, rssi: Int) {
        guard scanning, let handoff else { return }
        if let token = ProximityToken.parse(name) { tokens[id] = token }
        let now = Date().timeIntervalSince1970
        let fire = detector.observe(id.uuidString, rssi: rssi, at: now)
        if now - lastLog > 0.5 {
            lastLog = now
            let level = detector.smoothed(id.uuidString) ?? rssi, enter = detector.config.enterRSSI, hasToken = tokens[id] != nil
            debugLine = "iPhone \(level) dBm · close at \(enter)"
            log.debug("proximity rssi \(rssi, privacy: .public) smoothed \(level, privacy: .public) token \(hasToken, privacy: .public)")
        }
        guard fire, let token = tokens[id] else { return }
        log.info("proximity held close, reporting")
        handoff.server.send(["type": "proximity.seen", "token": token])
    }

    private func receive(_ m: [String: Any]) {
        guard let message = ProximityMessage(m) else { return }
        switch message {
        case let .result(accepted, reason):
            log.info("proximity result \(accepted, privacy: .public) \(reason, privacy: .public)")
            // Refused (another account's token, a stale one…): the next approach may try again; the detector keeps its cooldown.
            if !accepted { detector.reset(); tokens = [:] }
        case .moved(to: .mac):
            stopScan()
            guard enabled else { return }
            celebrate()
        default: break
        }
    }

    /// The Mac's half of the moment: the same Connected chime the iPhone plays, and the toast.
    private func celebrate() {
        moment += 1; let id = moment
        if let url = Bundle.main.url(forResource: "GenitaHandoffConnected", withExtension: "caf"), let player = try? AVAudioPlayer(contentsOf: url) {
            player.volume = 0.35; player.prepareToPlay(); player.play(); chime = player
        }
        showToast()
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in if self?.moment == id { self?.hideToast() } }
    }

    private func showToast() {
        let panel = toastWindow ?? {
            let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 320, height: 72), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            p.isOpaque = false; p.backgroundColor = .clear; p.hasShadow = false; p.level = .floating
            p.ignoresMouseEvents = true; p.isReleasedWhenClosed = false
            p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            p.contentView = NSHostingView(rootView: ProximityToast(text: "Continued from your iPhone", symbol: "iphone").padding(14))
            return p
        }()
        toastWindow = panel
        let size = panel.contentView?.fittingSize ?? NSSize(width: 320, height: 72)
        if let screen = NSScreen.main {
            let f = screen.visibleFrame
            panel.setFrame(NSRect(x: f.midX - size.width / 2, y: f.maxY - size.height - 12, width: size.width, height: size.height), display: true)
        }
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { $0.duration = 0.25; panel.animator().alphaValue = 1 }
    }

    private func hideToast() {
        guard let panel = toastWindow else { return }
        NSAnimationContext.runAnimationGroup({ $0.duration = 0.25; panel.animator().alphaValue = 0 }, completionHandler: { panel.orderOut(nil) })
    }
}
