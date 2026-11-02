import Foundation

/// PREP-1 "Bringing {name} to life" (PRD D38) and the in-call prep indicator S09-PREP, as data:
/// copy, button and stage rows for each state of `GET /v1/companion/prep`.
/// Figma rp1wR9pxV0IsgyjvOcwo92: 182:51 scene · 182:3 scene done · 182:96 ready · 182:142 failed · 228:543 S09-PREP.
public struct PrepScreen: Equatable, Sendable {
    public enum Phase: Equatable, Sendable {
        /// still making; Start talking turns on once the scene exists
        case working
        /// everything done: no button, the screen moves on to S07 by itself
        case ready
        /// a stage didn't finish: Try again (POST /v1/companion/prep/retry) or Continue with the photo (S09-PF)
        case failed(PrepProgress.Stage)
    }

    public struct Row: Equatable, Sendable {
        public var stage: PrepProgress.Stage
        public var title: String
        public var status: PrepProgress.Status
        /// right-hand label: "Done" · "Working…" · "Didn’t finish" · "" (pending)
        public var detail: String
    }

    public var phase: Phase
    public var title: String
    public var subtitle: String
    /// nil = no button (ready)
    public var primary: String?
    public var primaryEnabled: Bool
    /// the text button under the primary (failed only)
    public var secondary: String?
    public var rows: [Row]

    public static let stageTitles: [PrepProgress.Stage: String] = [.scene: "Scene", .expressions: "Expressions", .mouth: "Mouth"]

    public init(_ prep: PrepProgress?, name: String) {
        // no answer yet: the server starts with the scene
        let stages = prep?.stages ?? [.scene: .running, .expressions: .pending, .mouth: .pending]
        // Only `status: failed` is final: the runner retries a failed step on its own until MAX_PREP_ATTEMPTS,
        // so a step that failed while the prep still runs shows as working.
        let final = prep?.isFailed == true
        let failed: PrepProgress.Stage? = final ? (prep?.failedStage ?? prep?.current ?? .scene) : nil
        rows = PrepProgress.Stage.allCases.map { stage in
            var s = prep?.isReady == true ? .done : (stages[stage] ?? .pending)
            if s == .failed && !final { s = .running }
            let detail: String
            switch s {
            case .done: detail = "Done"
            case .running: detail = "Working…"
            case .failed: detail = "Didn’t finish"
            case .pending: detail = ""
            }
            return Row(stage: stage, title: Self.stageTitles[stage] ?? "", status: s, detail: detail)
        }
        if prep?.isReady == true {
            phase = .ready; title = "\(name) is ready."; subtitle = "Saying hi…"
            primary = nil; primaryEnabled = false; secondary = nil
        } else if let failed {
            phase = .failed(failed); title = "Bringing \(name)\nto life"
            subtitle = "The \((Self.stageTitles[failed] ?? "face").lowercased()) didn’t come together. Try once more."
            primary = "Try again"; primaryEnabled = true; secondary = "Continue with the photo"
        } else {
            phase = .working; title = "Bringing \(name)\nto life"
            let canStart = prep?.canStartCall ?? false
            subtitle = canStart ? "About 1–2 minutes. You can start now — the rest finishes during the call."
                                : "About 1–2 minutes. Keep Genita open."
            primary = "Start talking"; primaryEnabled = canStart; secondary = nil
        }
    }

    /// S09-PREP pill on the call (228:543): the stage still being made, nil when ready, failed or unknown.
    public static func callIndicator(_ prep: PrepProgress?) -> String? {
        guard let prep, !prep.isReady, !prep.isFailed, let stage = prep.current else { return nil }
        return "Getting the \((stageTitles[stage] ?? "face").lowercased()) ready"
    }
}
