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
    func testOnlyAMoveFromAnIPhoneCallCounts() {
        // the iPhone in a call: the move carries the call (and its camera)
        XCTAssertTrue(HandoffCameraPolicy.movedFromPhoneCall(previousOwner: .phone, peerInCall: true))
        // Codex P1: taking the conversation while the iPhone is on its home screen is a new call on the Mac
        XCTAssertFalse(HandoffCameraPolicy.movedFromPhoneCall(previousOwner: .phone, peerInCall: false))
        XCTAssertFalse(HandoffCameraPolicy.movedFromPhoneCall(previousOwner: .mac, peerInCall: true))
        // older server that doesn't report calls: unknown is off (privacy)
        XCTAssertFalse(HandoffCameraPolicy.movedFromPhoneCall(previousOwner: .phone, peerInCall: nil))
    }
    // b14 (Chelsea 11/4): the first move to a Mac paired a moment ago, iPhone camera on.
    func testPairedIPhoneSaysItsCallOverTheLocalLink() {
        XCTAssertTrue(HandoffCameraPolicy.movedFromPhoneCall(previousOwner: .phone, peerInCall: nil, linkInCall: true))
        XCTAssertFalse(HandoffCameraPolicy.movedFromPhoneCall(previousOwner: .phone, peerInCall: nil, linkInCall: false))
        XCTAssertFalse(HandoffCameraPolicy.movedFromPhoneCall(previousOwner: .mac, peerInCall: nil, linkInCall: true))
    }
    func testIPhoneCameraOnStartsTheMacCameraWithoutARememberedTap() {
        XCTAssertTrue(HandoffCameraPolicy.startsCamera(fromPhone: true, phoneCamera: true, cameraRemembered: false, cameraAuthorized: true))
        // never asked on this Mac yet: the iPhone's camera-on may ask once
        XCTAssertTrue(HandoffCameraPolicy.startsCamera(fromPhone: true, phoneCamera: true, cameraRemembered: false, cameraAuthorized: false, cameraUndetermined: true))
        // denied stays off
        XCTAssertFalse(HandoffCameraPolicy.startsCamera(fromPhone: true, phoneCamera: true, cameraRemembered: true, cameraAuthorized: false))
        // the user turned it off on the iPhone: off here too, whatever the last tap on the Mac
        XCTAssertFalse(HandoffCameraPolicy.startsCamera(fromPhone: true, phoneCamera: false, cameraRemembered: true, cameraAuthorized: true))
        // a call opened on the Mac itself never starts it
        XCTAssertFalse(HandoffCameraPolicy.startsCamera(fromPhone: false, phoneCamera: true, cameraRemembered: true, cameraAuthorized: true))
        // without the iPhone's word an unasked Mac never shows a dialog by itself
        XCTAssertFalse(HandoffCameraPolicy.startsCamera(fromPhone: true, cameraRemembered: true, cameraAuthorized: false, cameraUndetermined: true))
    }
}
