import XCTest
@testable import Genita

/// b18 ("징", Chelsea: like the interaction demo): a proximity move plays the touch path's DUO wipe on both devices.
@MainActor final class ProximityWipeTests: XCTestCase {
    func testPolicy() {
        XCTAssertTrue(HandoffProximityMotion.plays(reduceMotion: false, enabled: true))
        XCTAssertFalse(HandoffProximityMotion.plays(reduceMotion: true, enabled: true), "Reduce Motion: the glide / fade")
        XCTAssertFalse(HandoffProximityMotion.plays(reduceMotion: false, enabled: false), "GENITA_PROXIMITY_WIPE=0")
        // the proximity claim is the move: never held behind its own wipe; a touch move's server copy still waits
        XCTAssertFalse(HandoffProximityMotion.holdsServerClaim(effectRunning: true, trigger: "proximity"))
        XCTAssertTrue(HandoffProximityMotion.holdsServerClaim(effectRunning: true, trigger: "touch"))
        XCTAssertTrue(HandoffProximityMotion.holdsServerClaim(effectRunning: true, trigger: nil))
        XCTAssertFalse(HandoffProximityMotion.holdsServerClaim(effectRunning: false, trigger: "touch"))
    }

    /// The Mac's incoming half is the touch path's payload for a dock on the right (MacHandoff `ready`):
    /// outgoing false, reverse = (!pending.outgoing) != right, starting the touch path's 0.8 s later.
    func testMacPayloadMatchesTheTouchPath() {
        let p = HandoffProximityMotion.macPayload(id: "m", image: "png", now: 100)
        XCTAssertFalse(p.outgoing)
        XCTAssertEqual(p.reverse, (!true) != HandoffProximityMotion.right)
        XCTAssertEqual(p.start, 100.8, accuracy: 1e-9)
        XCTAssertEqual(p.image, "png")
    }

    /// The iPhone's half: the proximity moment starts the outgoing wipe (the overlay draws DuoTransition for it).
    func testProximityDeparturePlaysTheOutgoingWipe() throws {
        let handoff = PhoneHandoff.shared
        handoff.cancelMotion()
        defer { handoff.cancelMotion() }
        XCTAssertFalse(handoff.playProximityDeparture(image: ""), "no picture: the glide plays instead")
        XCTAssertNil(handoff.motion)
        let t0 = Date().timeIntervalSince1970
        XCTAssertTrue(handoff.playProximityDeparture(image: "iVBORw0KGgo="))
        let m = try XCTUnwrap(handoff.motion, "the wipe runs")
        XCTAssertTrue(m.outgoing, "the iPhone plays the outgoing half")
        XCTAssertEqual(m.reverse, (!true) != HandoffProximityMotion.right, "the touch path's reverse for a right-edge dock")
        XCTAssertEqual(m.start, t0 + HandoffProximityMotion.lead, accuracy: 0.25)
        XCTAssertEqual(m.image, "iVBORw0KGgo=", "the call screen it was given (now), not a connect-time snapshot")
        XCTAssertFalse(handoff.playProximityDeparture(image: "iVBORw0KGgo="), "one effect at a time")
        handoff.cancelMotion()
        XCTAssertNil(handoff.motion)
    }
}
