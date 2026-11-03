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
}
