import SwiftUI

struct ConnectingView: View {
    @Bindable var model: AppState
    var body: some View {
        // Figma C02: the conversation screen with a "Connecting…" pill, not a separate orb screen.
        ConversationView(model: model, connecting: true).task {
            #if DEBUG
            if ProcessInfo.processInfo.environment["GENITA_REVIEW_STAGE"] == "connecting" { return }
            #endif
            do { try await Task.sleep(for: .milliseconds(700)) } catch { return }
            if model.stage == .connecting { model.complete() }
        }
    }
}
