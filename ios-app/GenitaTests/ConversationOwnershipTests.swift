import XCTest
@testable import Genita

final class ConversationOwnershipTests: XCTestCase {
    private final class Wire: OwnershipTransport {
        var sent = [OwnershipClaim]()
        func publish(_ claim: OwnershipClaim) { sent.append(claim) }
    }
    private func device(_ device: ConversationDevice, _ store: UserDefaults? = nil) -> (OwnershipCoordinator, Wire) {
        let coordinator = OwnershipCoordinator(device: device, store: store ?? UserDefaults(suiteName: UUID().uuidString)!)
        let wire = Wire(); coordinator.transport = wire
        return (coordinator, wire)
    }
    func testConversationStartsOnThePhone() {
        XCTAssertEqual(ConversationOwnership().owner, .phone)
        XCTAssertEqual(ConversationOwnership().epoch, 0)
    }
    func testEachClaimRaisesTheEpochAndNewestClaimWins() {
        var state = ConversationOwnership()
        let first = state.claim(for: .mac), second = state.claim(for: .phone)
        XCTAssertEqual(first.epoch, 1); XCTAssertEqual(second.epoch, 2)
        var other = ConversationOwnership()
        XCTAssertTrue(other.apply(second))
        XCTAssertFalse(other.apply(first), "An older claim arriving late must not take the conversation back")
        XCTAssertEqual(other.owner, .phone); XCTAssertEqual(other.epoch, 2)
    }
    func testEqualEpochConflictConvergesOnBothDevices() {
        var phone = ConversationOwnership(), mac = ConversationOwnership()
        let toPhone = phone.claim(for: .phone), toMac = mac.claim(for: .mac)
        phone.apply(toMac); mac.apply(toPhone)
        XCTAssertEqual(phone, mac)
    }
    func testLinkLossKeepsTheOwnerAndOnlyChangesTheWaitingScreen() {
        var state = ConversationOwnership()
        _ = state.claim(for: .mac)
        XCTAssertEqual(state.surface(on: .mac, peerReachable: true), .active)
        XCTAssertEqual(state.surface(on: .mac, peerReachable: false), .active, "The Mac keeps talking when the iPhone leaves")
        XCTAssertEqual(state.surface(on: .phone, peerReachable: true), .waiting)
        XCTAssertEqual(state.surface(on: .phone, peerReachable: false), .waitingPeerUnreachable)
        XCTAssertEqual(state.owner, .mac)
    }
    func testIPhoneUnreachableWhileOwnerShowsMacUnreachableSheet() {
        let state = ConversationOwnership()
        XCTAssertEqual(state.surface(on: .mac, peerReachable: false), .waitingPeerUnreachable)
        XCTAssertEqual(state.surface(on: .phone, peerReachable: false), .active)
    }
    func testTapClaimsAtOnceWithoutALinkAndStaleDeviceWaitsAfterReconnect() {
        let (phone, phoneWire) = device(.phone), (mac, macWire) = device(.mac)
        // The conversation moves to the Mac.
        mac.claimHere(); phone.receive(macWire.sent.last!)
        XCTAssertFalse(phone.isOwner)
        // The link is down. The Mac keeps its state, the iPhone taps Continue here.
        phone.claimHere()
        XCTAssertTrue(phone.isOwner); XCTAssertEqual(phone.surface(peerReachable: false), .active)
        XCTAssertTrue(mac.isOwner, "The Mac has not heard the claim yet")
        // Reconnect: both publish, and the newest claim wins on both.
        phone.publishCurrent(); mac.publishCurrent()
        phone.receive(macWire.sent.last!); mac.receive(phoneWire.sent.last!)
        XCTAssertTrue(phone.isOwner)
        XCTAssertFalse(mac.isOwner)
        XCTAssertEqual(mac.surface(peerReachable: true), .waiting)
    }
    func testOnChangeReportsTheMoveOnlyForNewClaims() {
        let (mac, _) = device(.mac)
        var changes = [ConversationDevice]()
        mac.onChange = { _, new in changes.append(new) }
        mac.receive(OwnershipClaim(owner: .mac, epoch: 3))
        mac.receive(OwnershipClaim(owner: .phone, epoch: 2))
        mac.receive(OwnershipClaim(owner: .phone, epoch: 4))
        XCTAssertEqual(changes, [.mac, .phone])
    }
    func testOwnershipSurvivesARestart() {
        let store = UserDefaults(suiteName: UUID().uuidString)!
        let (phone, _) = device(.phone, store)
        phone.receive(OwnershipClaim(owner: .mac, epoch: 7))
        let (reopened, _) = device(.phone, store)
        XCTAssertEqual(reopened.state.owner, .mac); XCTAssertEqual(reopened.state.epoch, 7)
        XCTAssertFalse(reopened.isOwner, "Opening the app does not move the conversation")
    }
    func testClaimMessageRoundTrip() {
        let claim = OwnershipClaim(owner: .mac, epoch: 12)
        XCTAssertEqual(OwnershipClaim(claim.message), claim)
        XCTAssertNil(OwnershipClaim(["type": "ownership", "owner": "tablet", "epoch": 1]))
    }
    /// E01 / E02 use the companion's name, never a hardcoded one.
    func testPermissionSheetsUseTheCompanionName() {
        XCTAssertEqual(MediaPermissionSheet.lines(kind: .camera, name: "Mira")[1], "to show Mira what you see.")
        XCTAssertEqual(MediaPermissionSheet.lines(kind: .microphone, name: "Mira")[1], "to talk with Mira.")
        XCTAssertEqual(MediaPermissionSheet.lines(kind: .camera, name: " ")[1], "to show your companion what you see.")
        XCTAssertFalse(MediaPermissionSheet.lines(kind: .microphone, name: "Mira").joined().contains("Jin"))
    }
    func testApprovedCopy() {
        XCTAssertEqual(HandoffCopy.phone(.active), nil)
        XCTAssertEqual(HandoffCopy.phone(.waiting)?.title, "Continue on your Mac.")
        XCTAssertEqual(HandoffCopy.phone(.waitingPeerUnreachable)?.title, "Mac not responding.")
        XCTAssertEqual(HandoffCopy.mac(.waiting, sharingStopped: false)?.lines, ["Your Mac is ready when you are."])
        XCTAssertEqual(HandoffCopy.mac(.waiting, sharingStopped: true)?.lines.first, "Screen sharing stopped.")
        XCTAssertEqual(HandoffCopy.mac(.waitingPeerUnreachable, sharingStopped: true)?.title, "iPhone not responding.")
    }
}
