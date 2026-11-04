import SwiftUI
import UIKit
import CoreBluetooth
import AVFoundation
import os

/// Proximity handoff on the iPhone (rules: shared/Handoff/ProximityHandoff.swift, server: PROTOCOL.md "Proximity").
///
/// While this iPhone holds the conversation in a live call and the same account's Mac app is open, it asks the
/// server for a short token and advertises it over Bluetooth LE (re-armed every 30 s). The Mac moves the call when
/// it sees the token held close; here that arrives as an `ownership` with trigger `proximity`, and the iPhone plays
/// its half of the moment: a haptic, the call screen gliding up toward the Mac, a one-line toast (the chime is the
/// existing Connected sound PhoneHandoff plays on every move to the Mac).
///
/// Bluetooth is asked for the first time it is useful (in a call, Mac open), never at launch. Off or denied →
/// nothing advertises and Move to Mac in the menu works as before. Off entirely unless `ProximityHandoffFlag`.
@MainActor final class PhoneProximity: NSObject, ObservableObject, CBPeripheralManagerDelegate {
    static let shared = PhoneProximity()
    /// The call screen as it was when the move landed, gliding away (nil when no moment is running).
    @Published private(set) var glide: UIImage?
    @Published private(set) var glideProgress = 0.0
    @Published private(set) var toast = false
    private weak var handoff: PhoneHandoff?
    private var manager: CBPeripheralManager?
    private var token: String?
    private var advertised: String?
    private var armedAt = -Double.infinity
    private var timer: Timer?
    private var moment = 0
    private let log = Logger(subsystem: "ai.thebeni.genita", category: "proximity")

    func attach(_ handoff: PhoneHandoff) {
        guard self.handoff == nil else { return }
        self.handoff = handoff
        handoff.server.onMessage = { [weak self] m in self?.receive(m) }
        #if DEBUG
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "--proximity-moment"), args.indices.contains(i + 1) {
            // CI review only: the moment without Bluetooth or a server, frozen mid-glide or at the toast.
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.reviewMoment(args[i + 1]) }
            return
        }
        #endif
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in Task { @MainActor in self?.tick() } }
    }

    private var enabled: Bool { ProximityHandoffFlag.enabled(remote: GenitaAppConfigStore.shared.config.flag("proximityHandoff", default: false)) }

    private func tick() {
        guard let handoff else { return }
        let wanted = ProximityPolicy.phoneShouldAdvertise(
            enabled: enabled, inFront: UIApplication.shared.applicationState == .active, owner: handoff.ownership.isOwner,
            callLive: CallController.shared.link == .live, serverConnected: handoff.server.connected, macOnline: handoff.server.peerActive)
        guard wanted else { return disarm() }
        // First time it is useful: this creates the Bluetooth permission prompt (NSBluetoothAlwaysUsageDescription).
        guard let manager else {
            manager = CBPeripheralManager(delegate: self, queue: .main, options: [CBPeripheralManagerOptionShowPowerAlertKey: false])
            return
        }
        guard manager.state == .poweredOn else { return disarm() }
        let now = Date().timeIntervalSince1970
        if now - armedAt >= ProximityPolicy.rotateSeconds {
            armedAt = now
            handoff.server.send(["type": "proximity.arm"])
        }
    }

    /// Stop advertising and tell the server this iPhone's tokens no longer count.
    private func disarm() {
        if manager?.isAdvertising == true { manager?.stopAdvertising() }
        if armedAt.isFinite || token != nil { handoff?.server.send(["type": "proximity.disarm"]) }
        advertised = nil; token = nil; armedAt = -.infinity
    }

    private func receive(_ m: [String: Any]) {
        guard let message = ProximityMessage(m) else { return }
        switch message {
        case let .token(t, _):
            // an answer to an arm that was since cancelled (disarm, flag off, call ended): don't advertise it
            guard armedAt.isFinite, enabled else { return }
            token = t; advertise()
        case let .unavailable(reason):
            log.info("proximity unavailable: \(reason, privacy: .public)")
            if manager?.isAdvertising == true { manager?.stopAdvertising() }
            advertised = nil; token = nil
        case .result, .peer: break
        case .moved(to: .mac):
            guard enabled else { return }
            celebrate()
        case .moved: break
        }
    }

    private func advertise() {
        guard let manager, manager.state == .poweredOn, let token, advertised != token else { return }
        if manager.isAdvertising { manager.stopAdvertising() }
        // iOS fits one 128-bit service UUID + an 8-byte local name in a foreground advertisement.
        manager.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [CBUUID(string: ProximityToken.serviceUUID)], CBAdvertisementDataLocalNameKey: token])
        advertised = token
        log.info("proximity advertising \(String(token.prefix(2)), privacy: .public)…")
    }

    nonisolated func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        MainActor.assumeIsolated {
            log.info("bluetooth state \(peripheral.state.rawValue, privacy: .public)")
            if peripheral.state == .poweredOn { advertise() } else { advertised = nil }
        }
    }

    nonisolated func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        guard let error else { return }
        MainActor.assumeIsolated { log.error("advertising failed: \(error.localizedDescription, privacy: .public)"); advertised = nil }
    }

    /// The iPhone's half of the moment. Runs as the `ownership` arrives, before PhoneHandoff switches to R1, so the
    /// snapshot is still the live call screen.
    private func celebrate() {
        disarm()
        moment += 1; let id = moment
        let shot = Self.snapshot()
        // b18 ("징" like the interaction demo): the same DUO wipe the touch path plays, its outgoing half here; the
        // haptics and sounds come with it (HandoffFeedback). Reduce Motion, or no picture: the glide below, as before.
        if HandoffProximityMotion.plays(reduceMotion: UIAccessibility.isReduceMotionEnabled),
           let png = shot?.pngData()?.base64EncodedString(), handoff?.playProximityDeparture(image: png) == true {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in withAnimation(.spring(duration: 0.35, bounce: 0.2)) { self?.toast = true } }
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                guard self?.moment == id else { return }
                withAnimation(.easeOut(duration: 0.25)) { self?.toast = false }
            }
            return
        }
        glide = shot; glideProgress = 0
        // Haptics are muted while an audio session records unless this is set. It changes no category or route.
        try? AVAudioSession.sharedInstance().setAllowHapticsAndSystemSoundsDuringRecording(true)
        let soft = UIImpactFeedbackGenerator(style: .soft), firm = UIImpactFeedbackGenerator(style: .rigid)
        soft.prepare(); firm.prepare()
        soft.impactOccurred(intensity: 0.55)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { firm.impactOccurred(intensity: 1) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) { [weak self] in
            withAnimation(.timingCurve(0.4, 0, 0.2, 1, duration: 0.7)) { self?.glideProgress = 1 }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in withAnimation(.spring(duration: 0.35, bounce: 0.2)) { self?.toast = true } }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in if self?.moment == id { self?.glide = nil } }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            guard self?.moment == id else { return }
            withAnimation(.easeOut(duration: 0.25)) { self?.toast = false }
        }
    }

    private static func snapshot() -> UIImage? {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        guard let window = windows.first(where: \.isKeyWindow) ?? windows.first else { return nil }
        return UIGraphicsImageRenderer(bounds: window.bounds).image { _ in _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: false) }
    }

    #if DEBUG
    private func reviewMoment(_ phase: String) {
        guard let handoff else { return }
        glide = Self.snapshot()
        handoff.debugPeerReachable = true  // R1 "Continue on your Mac." behind the toast, as with a real Mac online
        let mac = OwnershipClaim(owner: .mac, epoch: handoff.ownership.state.epoch + 1)
        handoff.ownership.receive(mac)
        toast = true
        glideProgress = phase == "glide" ? 0.4 : 1
        if phase != "glide" { glide = nil }
    }
    #endif
}

/// Drawn over the call by PhoneHandoffOverlay. Never takes touches.
struct ProximityMomentView: View {
    @ObservedObject private var proximity = PhoneProximity.shared
    var body: some View {
        ZStack(alignment: .top) {
            Color.clear
            if let image = proximity.glide {
                Image(uiImage: image).resizable().ignoresSafeArea()
                    .modifier(ProximityGlideModifier(progress: proximity.glideProgress))
            }
            if proximity.toast {
                ProximityToast(text: "Moved to your Mac", symbol: "laptopcomputer")
                    .padding(.top, 12)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .allowsHitTesting(false)
    }
}
