import XCTest
@testable import Genita

final class LaunchAuthSnapshotTests: XCTestCase {
    func testLateMeSuccessCannotReAdoptAfterLogoutOrAnotherLogin() {
        let request = LaunchAuthSnapshot(token: "token-a", generation: 0)
        XCTAssertTrue(request.accepts(LaunchAuthSnapshot(token: "token-a", generation: 0)))
        XCTAssertFalse(request.accepts(LaunchAuthSnapshot(token: nil, generation: 1)), "A logged out before /me succeeded")
        XCTAssertFalse(request.accepts(LaunchAuthSnapshot(token: "token-b", generation: 2)), "B signed in before A's /me succeeded")
        XCTAssertFalse(request.accepts(LaunchAuthSnapshot(token: "token-a", generation: 3)), "Signing back into A must not revive its earlier request")
    }

    func testTokenChangesInvalidateMeEvenBeforeTheAuthCallback() {
        let request = LaunchAuthSnapshot(token: "token-a", generation: 0)
        XCTAssertFalse(request.accepts(LaunchAuthSnapshot(token: nil, generation: 0)))
        XCTAssertFalse(request.accepts(LaunchAuthSnapshot(token: "token-b", generation: 0)))
        let signedOut = LaunchAuthSnapshot(token: nil, generation: 0)
        XCTAssertFalse(signedOut.accepts(signedOut), "An unauthenticated snapshot never authorizes adoption")
    }
}
