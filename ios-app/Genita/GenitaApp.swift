import SwiftUI

@main struct GenitaApp: App {
    @State private var model = AppState(reset: ProcessInfo.processInfo.arguments.contains("--uitesting"))
    @State private var appConfig = GenitaAppConfigStore.shared
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject private var handoff = PhoneHandoff.shared
    /// R1 dims the image behind the status bar, so the status bar turns light, as in the design.
    /// PF-1b / r03 full: a full Finds sheet leaves a dark band under the status bar, so it turns light too.
    private var darkStatusBar: Bool { model.stage == .signIn || model.stage == .bringing || CallController.shared.finds.state == .full || (handoff.surface != .active && handoff.motion == nil && !model.menuOpen && !model.settingsOpen && !handoff.settings) }
    var body: some Scene {
        WindowGroup {
            Group {
                if ProcessInfo.processInfo.arguments.contains("--handoff-demo") { ConversationView(model:model) }
                else { RootView(model:model) }
            }
                .genitaSplash() // launch: the mark draws, the eye opens, wakes into the first screen (≤ 1.6 s, tap skips)
                .onAppear {
                    #if DEBUG
                    if ProcessInfo.processInfo.arguments.contains("--fixture-image"), let url = Bundle.main.url(forResource: "companion", withExtension: "png") { model.setup.imageData = try? Data(contentsOf: url) }
                    if ProcessInfo.processInfo.arguments.contains("--fixture-personality") {
                        model.setup.stage = .depth
                        model.setup.name = "QA"
                        model.setup.response = "Communication style: clear and warm."
                        model.setup.voice = 0
                    }
                    if let i = ProcessInfo.processInfo.arguments.firstIndex(of: "--media-state"), ProcessInfo.processInfo.arguments.indices.contains(i + 1) {
                        PhoneHandoff.shared.media.showDeniedForReview(ProcessInfo.processInfo.arguments[i + 1] == "camera-denied" ? .camera : .microphone)
                    }
                    #endif
                }
                .preferredColorScheme(darkStatusBar ? .dark : .light)
                // server-driven config (GET /v1/app-config): launch + every foreground; bundled defaults offline
                .overlay(alignment: .top) { UpdateBanner(config: appConfig.config) }
                .task { await appConfig.refreshUnlessTesting(force: true) }
                .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await appConfig.refreshUnlessTesting() } } }
        }
    }
}
