import XCTest
@testable import Genita

/// MC-01 (lead 11/4): opening the Mac app never starts the call by itself; only a live move does.
final class ResumePolicyTests: XCTestCase {
    func testColdLaunchWaitsForTheTap() {
        XCTAssertFalse(ResumePolicy.opensCall(.coldLaunch))
    }
    func testConnectTimeSyncWaitsForTheTap() {
        // connect-time copies and this Mac's own claims echoed back (a reconnect re-sends them) never open it
        for trigger in [nil, "current", "sync", "continue", "move", "touch", "button", "start"] {
            XCTAssertEqual(ResumePolicy.arrival(localClaim: false, serverTrigger: trigger), .syncedClaim, "\(trigger ?? "nil")")
            XCTAssertFalse(ResumePolicy.opensCall(ResumePolicy.arrival(localClaim: false, serverTrigger: trigger)))
        }
    }
    func testLiveMoveOpensTheCall() {
        // this Mac's own claim: the iPhone's Move to Mac (server moveRequested / link moveRequest), touch, Continue here
        XCTAssertTrue(ResumePolicy.opensCall(ResumePolicy.arrival(localClaim: true, serverTrigger: nil)))
        // the server moved it here by itself (proximity)
        XCTAssertTrue(ResumePolicy.opensCall(ResumePolicy.arrival(localClaim: false, serverTrigger: "proximity")))
    }

    // Demo S4: a call that moves here from the iPhone with the camera on keeps showing the outfit on the Mac.
    func testCameraFollowsAHandoffWhenTheUserLeftItOn() {
        XCTAssertTrue(HandoffCameraPolicy.startsCamera(fromPhone: true, cameraRemembered: true, cameraAuthorized: true))
    }
    func testFreshCallNeverStartsTheCamera() {
        // privacy: a call opened on the Mac itself (cold launch Continue here, a new call) starts with the camera off
        XCTAssertFalse(HandoffCameraPolicy.startsCamera(fromPhone: false, cameraRemembered: true, cameraAuthorized: true))
    }
    func testHandoffKeepsTheCameraOffWhenTheUserTurnedItOff() {
        XCTAssertFalse(HandoffCameraPolicy.startsCamera(fromPhone: true, cameraRemembered: false, cameraAuthorized: true))
    }
    func testHandoffWithoutCameraPermissionDoesNothingNew() {
        // not granted (denied, restricted or never asked): no auto start, so no system dialog and no new sheet
        XCTAssertFalse(HandoffCameraPolicy.startsCamera(fromPhone: true, cameraRemembered: true, cameraAuthorized: false))
    }
}
