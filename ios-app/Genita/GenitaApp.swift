import SwiftUI

@main struct GenitaApp: App {
    @State private var model = AppState(reset: GenitaApp.resetOnLaunch, onHandoffAccountChange: { PhoneHandoff.shared.setAccount($0) })
    @State private var appConfig = GenitaAppConfigStore.shared
    @Environment(\.scenePhase) private var scenePhase
    /// UI tests start clean. So does the Appetize browser preview (`--browser-preview`, Debug builds only, see BrowserPreview.swift).
    private static var resetOnLaunch: Bool {
        #if DEBUG
        BrowserPreview.prepare()
        if BrowserPreview.isActive { return true }
        #endif
        return ProcessInfo.processInfo.arguments.contains("--uitesting")
    }
    @ObservedObject private var handoff = PhoneHandoff.shared
    init() {
        // AU-12: a reinstall starts signed out (the keychain outlives the app); before the splash reads it
        AppState.forgetEarlierInstall { KeychainTokenStore().clear() }
    }
    /// R1 dims the image behind the status bar, so the status bar turns light, as in the design.
    /// PF-1b / r03 full: a full Finds sheet leaves a dark band under the status bar, so it turns light too.
    /// S09 call screens (춘식이 11/4 re-check): the call sits on #0E0F11 ink (connecting, the wait stage, the edges of a
    /// stepped-back face), so the status bar text is white there too; the menu panel and Settings stay light.
    private var darkStatusBar: Bool { model.launchRouting || model.stage == .signIn || model.stage == .bringing || CallController.shared.finds.state == .full || (model.stage == .conversation && !model.menuOpen && !model.settingsOpen && !handoff.settings) || (handoff.surface != .active && handoff.motion == nil && !model.menuOpen && !model.settingsOpen && !handoff.settings) }
    var body: some Scene {
        WindowGroup {
            Group {
                if ProcessInfo.processInfo.arguments.contains("--handoff-demo") { ConversationView(model:model) }
                else { RootView(model:model) }
            }
                .genitaSplash() // launch: the mark draws, the eye opens, wakes into the first screen (3.3 s from its first frame; 0.9 s when signed in; tap skips)
                .onAppear {
                    #if DEBUG
                    if ProcessInfo.processInfo.arguments.contains("--fixture-image"), let url = Bundle.main.url(forResource: "companion", withExtension: "png") { model.setup.imageData = try? Data(contentsOf: url) }
                    if ProcessInfo.processInfo.arguments.contains("--fixture-personality") {
                        model.setup.stage = .depth
                        model.setup.name = "QA"
                        model.setup.response = "Communication style: clear and warm."
                        model.setup.voice = 0
                    }
                    // D99 review shots: the Settings C1 card with a fixed companion. "long" = a long voice name + a date, "none" = no date.
                    if let i = ProcessInfo.processInfo.arguments.firstIndex(of: "--fixture-companion-card"), ProcessInfo.processInfo.arguments.indices.contains(i + 1) {
                        let long = ProcessInfo.processInfo.arguments[i + 1] == "long"
                        model.setup.companionName = "Jin"; model.setup.companionCreated = true; model.setup.voiceId = "72"
                        model.setup.voiceName = long ? "Warm baritone, unhurried" : "Tara"
                        model.setup.companionSince = long || ProcessInfo.processInfo.arguments[i + 1] == "dated"
                            ? ISO8601DateFormatter().string(from: Date().addingTimeInterval(-12 * 86400)) : nil
                    }
                    if let i = ProcessInfo.processInfo.arguments.firstIndex(of: "--media-state"), ProcessInfo.processInfo.arguments.indices.contains(i + 1) {
                        PhoneHandoff.shared.media.showDeniedForReview(ProcessInfo.processInfo.arguments[i + 1] == "camera-denied" ? .camera : .microphone)
                    }
                    #endif
                }
                #if DEBUG
                .overlay { BrowserPreviewMenu(model: model) } // Preview tab; nothing unless launched with --browser-preview
                #endif
                .preferredColorScheme(darkStatusBar ? .dark : .light)
                // server-driven config (GET /v1/app-config): launch + every foreground; bundled defaults offline
                .overlay(alignment: .top) { UpdateBanner(config: appConfig.config) }
                .task { await appConfig.refreshUnlessTesting(force: true) }
                .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await appConfig.refreshUnlessTesting() } } }
        }
    }
}
