import XCTest
@testable import Genita

/// CL-03 (#576, replaces #561): the call's still is the account's own picture or the dark ground, never a bundled face.
final class CallStillSourceTests: XCTestCase {
    func testServerStillComesFirst() {
        XCTAssertEqual(CallStillSource.pick(hasServerStill: true, hasHandoffProfile: true), .serverStill)
        XCTAssertEqual(CallStillSource.pick(hasServerStill: true, hasHandoffProfile: false), .serverStill)
    }
    func testThenTheIPhoneHandoffProfile() {
        XCTAssertEqual(CallStillSource.pick(hasServerStill: false, hasHandoffProfile: true), .handoffProfile)
    }
    func testOtherwiseTheDarkGroundNeverABundledFace() {
        XCTAssertEqual(CallStillSource.pick(hasServerStill: false, hasHandoffProfile: false), .ground)
    }
}
