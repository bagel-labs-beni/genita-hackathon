#if DEBUG
import Foundation

/// Debug builds only. GENITA_PROFILE_CHIP=1: once the call is live, the call gets a `profile.updated`
/// ("Updated: no cilantro") as if the user had corrected their profile by voice (D48 ①), for the UI test's screenshot.
extension CallController {
    func installProfileChipFixture(environment env: [String: String] = ProcessInfo.processInfo.environment) {
        guard env["GENITA_PROFILE_CHIP"] == "1" else { return }
        Task { [weak self] in
            for _ in 0..<80 where self?.link != .live { try? await Task.sleep(for: .milliseconds(100)) }
            try? await Task.sleep(for: .milliseconds(500))
            self?.handle(.profileUpdated(.init(text: "Updated: no cilantro", fields: ["likes"])))
        }
    }
}
#endif
