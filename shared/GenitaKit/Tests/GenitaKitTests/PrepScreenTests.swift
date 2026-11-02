import Foundation
import Testing
@testable import GenitaKit

/// The server's real Meta-only prep shape (runner.ts prepView on main, 11/3): `steps.face` is one step for the
/// 3 expressions + 10 visemes (`settled` of `total`), `videos` and `lips` are `skipped`.
private func serverPrep(status: String = "running", scene: String = "done", face: String? = "running", settled: Int = 0) -> String {
    let faceJSON = face.map { #","face":{"status":"\#($0)","settled":\#(settled),"total":13}"# } ?? #","face":null"#
    return #"{"status":"\#(status)","progress":{"done":1,"total":14},"sceneUrl":null,"steps":{"scene":{"status":"\#(scene)"},"videos":{"neutral":{"status":"skipped"},"happy":{"status":"skipped"},"warm":{"status":"skipped"}}\#(faceJSON)},"lips":{"status":"skipped","peter":null}}"#
}

struct MetaOnlyPrepTests {
    private func decode(_ s: String) throws -> PrepProgress { try JSONDecoder().decode(PrepProgress.self, from: Data(s.utf8)) }

    @Test func skippedLipsDoNotMarkTheMouthDone() throws {
        let p = try decode(serverPrep(settled: 1))
        #expect(p.stages == [.scene: .done, .expressions: .running, .mouth: .pending], "mouth waits for the face step, not the skipped Peter lips")
        #expect(p.current == .expressions)
    }

    @Test func mouthRunsOnceTheThreeExpressionsSettled() throws {
        let p = try decode(serverPrep(settled: 5))
        #expect(p.stages == [.scene: .done, .expressions: .done, .mouth: .running])
        #expect(p.current == .mouth)
    }

    @Test func faceFailurePointsAtTheStageThatWasBeingMade() throws {
        let mouth = try decode(serverPrep(face: "failed", settled: 7))
        #expect(mouth.stages[.expressions] == .done && mouth.stages[.mouth] == .failed && mouth.failedStage == .mouth)
        let expr = try decode(serverPrep(face: "failed", settled: 1))
        #expect(expr.stages[.expressions] == .failed && expr.stages[.mouth] == .pending && expr.failedStage == .expressions)
    }

    @Test func faceNotStartedYetIsPending() throws {
        let p = try decode(serverPrep(scene: "running", face: nil))
        #expect(p.stages == [.scene: .running, .expressions: .pending, .mouth: .pending])
    }
}

/// PREP-1 (Figma rp1wR9pxV0IsgyjvOcwo92 182:51 / 182:3 / 182:96 / 182:142) and S09-PREP (228:543) copy and states.
struct PrepScreenTests {
    private func screen(_ stages: [PrepProgress.Stage: PrepProgress.Status], status: String = "running") -> PrepScreen {
        PrepScreen(PrepProgress(status: status, stages: stages), name: "Jin")
    }

    @Test func beforeTheSceneStartTalkingIsOff() {
        let s = screen([.scene: .running, .expressions: .pending, .mouth: .pending])
        #expect(s.phase == .working && s.title == "Bringing Jin\nto life" && s.subtitle == "About 1–2 minutes. Keep Genita open.")
        #expect(s.primary == "Start talking" && !s.primaryEnabled && s.secondary == nil)
        #expect(s.rows.map(\.detail) == ["Working…", "", ""])
    }

    @Test func onceTheSceneExistsTheCallCanStart() {
        let s = screen([.scene: .done, .expressions: .running, .mouth: .pending])
        #expect(s.subtitle == "About 1–2 minutes. You can start now — the rest finishes during the call.")
        #expect(s.primaryEnabled && s.rows.map(\.detail) == ["Done", "Working…", ""])
    }

    @Test func readyHasNoButtonAndSaysHi() {
        let s = screen([:], status: "ready")
        #expect(s.phase == .ready && s.title == "Jin is ready." && s.subtitle == "Saying hi…" && s.primary == nil)
        #expect(s.rows.map(\.detail) == ["Done", "Done", "Done"])
    }

    @Test func aFailedStageOffersTryAgainAndThePhoto() {
        let s = screen([.scene: .done, .expressions: .done, .mouth: .failed], status: "failed")
        #expect(s.phase == .failed(.mouth) && s.subtitle == "The mouth didn’t come together. Try once more.")
        #expect(s.primary == "Try again" && s.primaryEnabled && s.secondary == "Continue with the photo")
        #expect(s.rows.map(\.detail) == ["Done", "Done", "Didn’t finish"])
    }

    @Test func aStepTheServerIsStillRetryingStaysWorking() {
        // runner.ts retries a failed step until MAX_PREP_ATTEMPTS; only `status: failed` is final (PREP-1e)
        let s = screen([.scene: .done, .expressions: .done, .mouth: .failed])
        #expect(s.phase == .working && s.primary == "Start talking" && s.rows.map(\.detail) == ["Done", "Done", "Working…"])
        #expect(PrepScreen.callIndicator(PrepProgress(status: "running", stages: [.scene: .done, .expressions: .done, .mouth: .failed])) == "Getting the mouth ready")
    }

    @Test func failedWithoutAFailedStepPointsAtTheUnfinishedOne() {
        #expect(screen([.scene: .done, .expressions: .running, .mouth: .pending], status: "failed").phase == .failed(.expressions))
    }

    @Test func noAnswerYetShowsTheSceneWorking() {
        let s = PrepScreen(nil, name: "Jin")
        #expect(s.phase == .working && !s.primaryEnabled && s.rows.map(\.status) == [.running, .pending, .pending])
    }

    @Test func inCallIndicatorNamesTheStageStillBeingMade() {
        #expect(PrepScreen.callIndicator(PrepProgress(status: "running", stages: [.scene: .done, .expressions: .done, .mouth: .running])) == "Getting the mouth ready")
        #expect(PrepScreen.callIndicator(PrepProgress(status: "running", stages: [.scene: .done, .expressions: .running, .mouth: .pending])) == "Getting the expressions ready")
        #expect(PrepScreen.callIndicator(PrepProgress(status: "ready", stages: [:])) == nil)
        #expect(PrepScreen.callIndicator(PrepProgress(status: "failed", stages: [.scene: .done, .expressions: .done, .mouth: .failed])) == nil, "failed prep is S09-PF, no spinner")
        #expect(PrepScreen.callIndicator(nil) == nil)
    }
}

/// In OnboardingClientTests' serialized suite: OnbStub's handler is shared.
extension OnboardingClientTests {
    @Test func retryPostsAndReadsTheNewProgress() async throws {
        OnbStub.handler = { req in
            req.httpMethod == "POST" && req.url?.path == "/v1/companion/prep/retry" ? (202, Data(serverPrep(settled: 5).utf8)) : (404, Data())
        }
        let p = try await client.retryPrep()
        #expect(OnbStub.seen.last?.url?.path == "/v1/companion/prep/retry" && p.stages[.mouth] == .running)
    }
}
