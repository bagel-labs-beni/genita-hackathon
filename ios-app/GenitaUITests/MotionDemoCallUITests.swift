import XCTest

/// Motion lane evidence only (not in the CI `-only-testing` lists): drives the call surface slowly with every motion on
/// (`--motion-demo` beats `--uitesting`'s still mode) so a screen recording shows motion details cards 1, 2, 3 and 10.
/// Needs the call replay servers (8788 recorded session, 8789 live session) like CallScreenUITests.
final class MotionDemoCallUITests: XCTestCase {
    private var faceSetDir: String {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "shared/GenitaKit/Tests/GenitaKitTests/Fixtures/face-animal").path
    }

    /// Cards 10 → 1: the face clears and the controls rise, then the pill goes listening → thinking → talking.
    func testMotion1And10CallPill() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", "--motion-demo"]
        app.launchEnvironment = [
            "GENITA_REVIEW_STAGE": "conversation",
            "GENITA_SERVER_URL": "ws://127.0.0.1:8788/v1/session",
            "GENITA_FIXTURE_SCRIPT": "none",
            "GENITA_CALL_AUTOMIC": "1",
            "GENITA_FACE_SET_DIR": faceSetDir,
        ]
        app.launch()
        XCTAssertTrue(app.buttons["micToggle"].waitForExistence(timeout: 15))
        // the recorded session (scale 3) reaches its first reply after a while: stay until the talking bars have played
        let cue = app.descendants(matching: .any).matching(identifier: "callCue").firstMatch
        let end = Date().addingTimeInterval(90)
        while Date() < end, !(cue.exists && cue.label.contains("talking")) { Thread.sleep(forTimeInterval: 0.25) }
        Thread.sleep(forTimeInterval: 8)
    }

    /// Card 2: press the mic off and on; the ring follows a stand-in voice (GENITA_MOTION_DEMO_LEVEL, DEBUG only).
    func testMotion2MicButton() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", "--motion-demo"]
        app.launchEnvironment = [
            "GENITA_REVIEW_STAGE": "conversation",
            "GENITA_SERVER_URL": "ws://127.0.0.1:8789/v1/session",
            "GENITA_FIXTURE_SCRIPT": "none",
            "GENITA_CALL_AUTOMIC": "1",
            "GENITA_MOTION_DEMO_LEVEL": "1",
        ]
        app.launch()
        let mic = app.buttons["micToggle"]
        XCTAssertTrue(mic.waitForExistence(timeout: 15))
        Thread.sleep(forTimeInterval: 4)
        for _ in 0..<2 {
            mic.press(forDuration: 0.35); Thread.sleep(forTimeInterval: 1.5)
            mic.press(forDuration: 0.35); Thread.sleep(forTimeInterval: 4)
        }
    }

    /// Card 3: GK-1 "Getting to know you" then CC-1 "Noted: quiet company" drops in, draws its check, and leaves.
    func testMotion3NotedChip() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", "--motion-demo"]
        app.launchEnvironment = [
            "GENITA_REVIEW_STAGE": "conversation",
            "GENITA_SERVER_URL": "ws://127.0.0.1:8789/v1/session",
            "GENITA_PROFILE_CHIP": "asking",
        ]
        app.launch()
        let noted = app.descendants(matching: .any).matching(identifier: "profileChip").firstMatch
        XCTAssertTrue(noted.waitForExistence(timeout: 30))
        Thread.sleep(forTimeInterval: 4)
    }
}
