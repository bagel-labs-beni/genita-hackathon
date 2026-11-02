import AppKit
import SwiftUI
#if canImport(Sparkle)
import Sparkle
#endif

/// Mac auto-update (Sparkle 2, lane 업데이트·모션). Feed + EdDSA public key live in mac-app/Info.plist
/// (`SUFeedURL`, `SUPublicEDKey`); device-test.yml signs each notarized DMG with `sign_update` and publishes the
/// appcast on GitHub Pages (bagel-labs-beni/genita-legal /mac/appcast.xml).
///
/// Behaviour: check at launch and every 24 h (`SUScheduledCheckInterval`), download silently
/// (`SUAutomaticallyUpdate`), then instead of waiting for quit we show a small "Restart to update" pill on the
/// window; tapping it installs and relaunches. If the user ignores it, Sparkle installs on the next quit.
/// `/v1/app-config` `updates.mac.minBuild` above this build triggers an immediate background check.
/// DEBUG builds and UI tests never self-update.
final class MacUpdater: NSObject {
    static let shared = MacUpdater()
    #if canImport(Sparkle)
    private var controller: SPUStandardUpdaterController?
    #endif
    private var installNow: (() -> Void)?
    private var readyVersion: String?
    private var panel: NSPanel?
    private var activeObserver: NSObjectProtocol?

    static var installedBuild: Int? { GenitaAppConfigStore.installedBuild }

    @MainActor func start() {
        #if canImport(Sparkle) && !DEBUG
        guard controller == nil, !ProcessInfo.processInfo.arguments.contains("--uitesting") else { return }
        let controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: nil)
        self.controller = controller
        checkInBackground() // at launch; Sparkle schedules the daily checks itself
        watchMinBuild()
        activeObserver = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.showPillIfReady() }
        }
        #endif
    }

    @MainActor private func checkInBackground() {
        #if canImport(Sparkle)
        guard let updater = controller?.updater, !updater.sessionInProgress, installNow == nil else { return }
        updater.checkForUpdatesInBackground()
        #endif
    }

    /// Server says this build is too old → check now instead of waiting for the daily check.
    @MainActor private func watchMinBuild() {
        let minBuild = withObservationTracking {
            GenitaAppConfigStore.shared.config.updates.mac.minBuild
        } onChange: { [weak self] in
            Task { @MainActor in self?.watchMinBuild() }
        }
        if let installed = Self.installedBuild, minBuild > installed { checkInBackground() }
    }

    // MARK: "Restart to update" pill (a borderless child panel on the main window — no change to the window's views)

    @MainActor private func showPillIfReady() {
        guard let version = readyVersion, installNow != nil, panel == nil,
              let window = NSApp.windows.first(where: { $0.isVisible && !($0 is NSPanel) && $0.contentView != nil }) else { return }
        let config = GenitaAppConfigStore.shared.config
        let pill = UpdateReadyPill(
            title: config.text("mac.update.ready"),
            action: config.text("mac.update.restart"),
            version: version,
            restart: { [weak self] in self?.restart() },
            later: { [weak self] in self?.hidePill() }
        )
        let host = NSHostingView(rootView: pill)
        host.frame.size = host.fittingSize
        let size = host.fittingSize
        let panel = NSPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.contentView = host
        let frame = window.frame
        panel.setFrameOrigin(NSPoint(x: frame.midX - size.width / 2, y: frame.maxY - size.height - 38))
        window.addChildWindow(panel, ordered: .above)
        self.panel = panel
    }

    @MainActor private func hidePill() {
        guard let panel else { return }
        panel.parent?.removeChildWindow(panel)
        panel.orderOut(nil)
        self.panel = nil
    }

    @MainActor private func restart() {
        hidePill()
        installNow?() // Sparkle installs the downloaded update and relaunches
    }
}

#if canImport(Sparkle)
extension MacUpdater: SPUUpdaterDelegate {
    /// The update is downloaded and would install on quit: take over and offer an immediate restart.
    func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem, immediateInstallationBlock immediateInstallHandler: @escaping () -> Void) -> Bool {
        let version = item.displayVersionString
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                self.installNow = immediateInstallHandler
                self.readyVersion = version
                self.showPillIfReady()
            }
        }
        return true
    }
}
#endif

/// Glass pill: "Update ready · Restart to update". Springs in; Reduce Motion → fade.
struct UpdateReadyPill: View {
    var title: String
    var action: String
    var version: String
    var restart: () -> Void
    var later: () -> Void
    @State private var shown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "sparkles").font(.system(size: 13, weight: .semibold)).foregroundStyle(.white.opacity(0.9))
                .symbolEffect(.bounce, options: .nonRepeating, value: shown)
            Text("\(title) · \(version)").font(.system(size: 12.5, weight: .medium)).foregroundStyle(.white)
            Button(action: restart) {
                Text(action).font(.system(size: 12.5, weight: .semibold)).padding(.horizontal, 11).padding(.vertical, 5)
                    .background(.white, in: Capsule()).foregroundStyle(.black)
            }.buttonStyle(.plain).accessibilityIdentifier("macUpdateRestart")
            Button(action: later) { Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.white.opacity(0.7)) }
                .buttonStyle(.plain).accessibilityLabel("Later")
        }
        .padding(.leading, 14).padding(.trailing, 10).padding(.vertical, 7)
        .background(Capsule().fill(.black.opacity(0.78)))
        .overlay(Capsule().strokeBorder(.white.opacity(0.18), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.25), radius: 14, y: 6)
        .padding(12)
        .scaleEffect(shown || reduceMotion ? 1 : 0.92)
        .offset(y: shown || reduceMotion ? 0 : -10)
        .opacity(shown ? 1 : 0)
        .onAppear { withAnimation(reduceMotion ? .easeOut(duration: 0.2) : .spring(response: 0.45, dampingFraction: 0.72)) { shown = true } }
    }
}
