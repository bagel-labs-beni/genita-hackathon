import SwiftUI

@main struct GenitaApp: App {
    @State private var model = AppState(reset: ProcessInfo.processInfo.arguments.contains("--uitesting"))
    @State private var appConfig = GenitaAppConfigStore.shared
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            Group {
                if ProcessInfo.processInfo.arguments.contains("--handoff-demo") { ConversationView(model:model) }
                else { RootView(model:model) }
            }
                .onAppear {
                    #if DEBUG
                    if ProcessInfo.processInfo.arguments.contains("--fixture-image"), let url = Bundle.main.url(forResource: "companion", withExtension: "png") { model.setup.imageData = try? Data(contentsOf: url) }
                    if ProcessInfo.processInfo.arguments.contains("--fixture-personality") {
                        model.setup.stage = .depth
                        model.setup.name = "QA"
                        model.setup.response = "Communication style: clear and warm."
                        model.setup.voice = 0
                    }
                    #endif
                }
                .preferredColorScheme(model.stage == .signIn ? .dark : .light)
                // server-driven config (GET /v1/app-config): launch + every foreground; bundled defaults offline
                .overlay(alignment: .top) { UpdateBanner(config: appConfig.config) }
                .task { await appConfig.refreshUnlessTesting(force: true) }
                .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await appConfig.refreshUnlessTesting() } } }
        }
    }
}
