import SwiftUI

@main struct GenitaApp: App {
    @State private var model = AppState(reset: ProcessInfo.processInfo.arguments.contains("--uitesting"))
    var body: some Scene {
        WindowGroup {
            RootView(model: model)
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
        }
    }
}
