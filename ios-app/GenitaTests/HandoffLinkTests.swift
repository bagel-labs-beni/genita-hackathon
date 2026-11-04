import XCTest
import MultipeerConnectivity
@testable import Genita

@MainActor final class HandoffLinkTests: XCTestCase {
    func testInvitationFromAnArbitraryDelegateQueueIsAnsweredOnMainQueue() async {
        let suite = "handoff-invitation-" + UUID().uuidString
        let store = UserDefaults(suiteName: suite)!
        defer { store.removePersistentDomain(forName: suite) }
        let link = HandoffLink(store: store)
        // No advertising or browsing: an invitation from an inactive advertiser must be rejected.
        let advertiser = MCNearbyServiceAdvertiser(peer: MCPeerID(displayName: "Mac"), discoveryInfo: nil, serviceType: "genita-handoff")
        let phone = MCPeerID(displayName: "iPhone")
        let answered = expectation(description: "Invitation answered on the account transition queue")
        DispatchQueue.global().async {
            link.advertiser(advertiser, didReceiveInvitationFromPeer: phone, withContext: Data("token:old-account".utf8)) { accepted, session in
                XCTAssertTrue(Thread.isMainThread, "Validation and approval must share the account transition queue")
                XCTAssertFalse(accepted)
                XCTAssertNil(session)
                answered.fulfill()
            }
        }
        await fulfillment(of: [answered], timeout: 3)
    }

    /// MV-02 (AU-85): the code invitation is bound to the account, without revealing the account id.
    func testCodeInvitationIsBoundToTheAccount() {
        let mine = HandoffLink.codeContext("482918", account: "user-a")
        XCTAssertEqual(mine, HandoffLink.codeContext("482918", account: "user-a"))
        XCTAssertNotEqual(mine, HandoffLink.codeContext("482918", account: "user-b"), "another account's iPhone is turned away")
        XCTAssertNotEqual(mine, "code:482918", "a bare code no longer pairs")
        XCTAssertFalse(mine.contains("user-a"))
        XCTAssertTrue(mine.hasPrefix("code:482918|acct:"))
    }
}
