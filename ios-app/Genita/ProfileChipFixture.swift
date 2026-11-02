#if DEBUG
import Foundation

/// Debug builds only. Once the call is live, the call gets lane 개인화's in-call events as if the server had sent them,
/// for the UI test's screenshots:
///   GENITA_PROFILE_CHIP=1      → `profile.updated` "Updated: no cilantro" (CC-1)
///   GENITA_PROFILE_CHIP=asking → `profile.asking` "How chatty calls should be" (GK-1), then 8 s later the answer
///                                saved: `profile.updated` "Noted: quiet company" (CC-1)
extension CallController {
    func installProfileChipFixture(environment env: [String: String] = ProcessInfo.processInfo.environment) {
        guard let mode = env["GENITA_PROFILE_CHIP"] else { return }
        Task { [weak self] in
            for _ in 0..<80 where self?.link != .live { try? await Task.sleep(for: .milliseconds(100)) }
            try? await Task.sleep(for: .milliseconds(500))
            if mode == "asking" {
                self?.handle(.profileAsking(.init(topic: "How chatty calls should be")))
                try? await Task.sleep(for: .seconds(8))
                self?.handle(.profileUpdated(.init(text: "Noted: quiet company", fields: ["communication"])))
            } else {
                self?.handle(.profileUpdated(.init(text: "Updated: no cilantro", fields: ["likes"])))
            }
        }
    }
}
#endif
