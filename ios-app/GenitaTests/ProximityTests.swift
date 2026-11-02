import XCTest
@testable import Genita

/// Proximity handoff: the parts CI can test without Bluetooth — the token, the threshold + hysteresis + hold +
/// cooldown, the presence messages, the flag, and when each side may run at all.
final class ProximityTests: XCTestCase {
    /// Readings every 50 ms (iOS foreground advertising is faster than that) at a fixed RSSI.
    private func feed(_ d: inout ProximityDetector, _ key: String = "p", rssi: Int, from t0: Double, seconds: Double, every step: Double = 0.05) -> Double? {
        var t = t0
        while t <= t0 + seconds + 1e-9 {
            if d.observe(key, rssi: rssi, at: t) { return t }
            t += step
        }
        return nil
    }

    func testTokenParse() {
        XCTAssertEqual(ProximityToken.parse("7K2M9QXA"), "7K2M9QXA")
        XCTAssertNil(ProximityToken.parse("7K2M9QX"), "too short")
        XCTAssertNil(ProximityToken.parse("7K2M9QXAB"), "too long")
        XCTAssertNil(ProximityToken.parse("7k2m9qxa"), "lowercase is not a token")
        XCTAssertNil(ProximityToken.parse("ILOU1234"), "I L O U are not in the alphabet")
        XCTAssertNil(ProximityToken.parse("Chelsea’s iPhone"), "a device name nearby is ignored")
        XCTAssertNil(ProximityToken.parse(nil))
    }

    func testHeldCloseForHalfASecondTriggersOnce() {
        var d = ProximityDetector()
        let fired = feed(&d, rssi: -40, from: 0, seconds: 2)
        XCTAssertNotNil(fired)
        XCTAssertGreaterThanOrEqual(fired!, 0.5 - 1e-9, "not before the hold")
        XCTAssertLessThan(fired!, 0.6)
        XCTAssertNil(feed(&d, rssi: -40, from: 2.05, seconds: 20), "still close: latched, never a second move")
    }

    func testPassingByOrNotCloseEnoughNeverTriggers() {
        var d = ProximityDetector()
        XCTAssertNil(feed(&d, rssi: -40, from: 0, seconds: 0.4), "0.4 s close is a pass-by")
        XCTAssertNil(feed(&d, rssi: -60, from: 0.45, seconds: 1), "moved away: the hold restarts")
        XCTAssertNil(feed(&d, rssi: -48, from: 1.5, seconds: 5), "on the desk next to the Mac (−48) is not close")
        var e = ProximityDetector()
        // a single spike to −30 among −60 readings: the median ignores it
        var t = 0.0
        for i in 0..<40 { XCTAssertFalse(e.observe("p", rssi: i % 5 == 0 ? -30 : -60, at: t)); t += 0.05 }
    }

    func testGapBreaksTheHold() {
        var d = ProximityDetector()
        XCTAssertFalse(d.observe("p", rssi: -40, at: 0))
        XCTAssertFalse(d.observe("p", rssi: -40, at: 0.1))
        XCTAssertFalse(d.observe("p", rssi: -40, at: 0.9), "0.8 s without a reading: the hold starts again here")
        XCTAssertFalse(d.observe("p", rssi: -40, at: 1.0))
        XCTAssertFalse(d.observe("p", rssi: -40, at: 1.3))
        XCTAssertTrue(d.observe("p", rssi: -40, at: 1.45), "0.55 s of continuous close readings since 0.9")
    }

    func testTooFewReadingsDoNotTrigger() {
        var d = ProximityDetector()
        XCTAssertFalse(d.observe("p", rssi: -40, at: 0))
        XCTAssertFalse(d.observe("p", rssi: -40, at: 0.55), "two readings over 0.55 s is not a hold")
    }

    func testHysteresisAndCooldown() {
        var d = ProximityDetector()
        XCTAssertNotNil(feed(&d, rssi: -40, from: 0, seconds: 1))
        // drops to −50: between exit (−55) and enter (−45) → still latched
        XCTAssertNil(feed(&d, rssi: -50, from: 1.05, seconds: 1))
        XCTAssertNil(feed(&d, rssi: -40, from: 2.1, seconds: 1), "back close without leaving: no second move")
        // leaves (−70) and comes back, but inside the 10 s cooldown
        XCTAssertNil(feed(&d, rssi: -70, from: 3.2, seconds: 0.5))
        XCTAssertNil(feed(&d, rssi: -40, from: 3.8, seconds: 2), "cooldown")
        XCTAssertNil(feed(&d, "other", rssi: -40, from: 6, seconds: 2), "the cooldown holds for every phone")
        XCTAssertNil(feed(&d, rssi: -70, from: 8.1, seconds: 0.5))
        let again = feed(&d, rssi: -40, from: 10.1, seconds: 2)
        XCTAssertNotNil(again, "after 10 s and a real departure it can move again")
        XCTAssertGreaterThanOrEqual(again!, 10.0)
    }

    func testHysteresisWithoutCooldown() {
        var c = ProximityConfig(); c.cooldownSeconds = 0
        var d = ProximityDetector(config: c)
        XCTAssertNotNil(feed(&d, rssi: -40, from: 0, seconds: 1))
        XCTAssertNil(feed(&d, rssi: -50, from: 1.05, seconds: 0.5), "dips to −50 (above exit −55)")
        XCTAssertNil(feed(&d, rssi: -40, from: 1.6, seconds: 1), "latched until it really leaves")
        XCTAssertNil(feed(&d, rssi: -60, from: 2.65, seconds: 0.3))
        XCTAssertNotNil(feed(&d, rssi: -40, from: 3.0, seconds: 1), "left below −55, so it re-arms")
    }

    func testRSSINotAvailableIsIgnored() {
        var d = ProximityDetector()
        XCTAssertNil(feed(&d, rssi: 127, from: 0, seconds: 2))
        XCTAssertNil(feed(&d, rssi: 0, from: 2.1, seconds: 2))
    }

    func testConfigOverridesAreClamped() {
        let defaults = UserDefaults(suiteName: "proximity-tests")!
        defaults.removePersistentDomain(forName: "proximity-tests")
        XCTAssertEqual(ProximityConfig.current(defaults: defaults), ProximityConfig())
        defaults.set(-52, forKey: "genita.proximity.enterRSSI")
        defaults.set(-50, forKey: "genita.proximity.exitRSSI")
        defaults.set(9.0, forKey: "genita.proximity.holdSeconds")
        let c = ProximityConfig.current(defaults: defaults)
        XCTAssertEqual(c.enterRSSI, -52)
        XCTAssertEqual(c.exitRSSI, -53, "exit always below enter, so hysteresis can't invert")
        XCTAssertEqual(c.holdSeconds, 0.5, "out-of-range hold is ignored")
        defaults.removePersistentDomain(forName: "proximity-tests")
    }

    func testMessages() {
        XCTAssertEqual(ProximityMessage(["type": "proximity.token", "token": "7K2M9QXA", "expiresIn": 60]), .token("7K2M9QXA", expiresIn: 60))
        XCTAssertNil(ProximityMessage(["type": "proximity.token", "token": "bad"]), "a malformed token is never advertised")
        XCTAssertEqual(ProximityMessage(["type": "proximity.unavailable", "reason": "not_in_call"]), .unavailable(reason: "not_in_call"))
        XCTAssertEqual(ProximityMessage(["type": "proximity.result", "accepted": false, "reason": "cooldown"]), .result(accepted: false, reason: "cooldown"))
        XCTAssertEqual(ProximityMessage(["type": "ownership", "owner": "mac", "epoch": 4, "trigger": "proximity"]), .moved(to: .mac))
        XCTAssertNil(ProximityMessage(["type": "ownership", "owner": "mac", "epoch": 4, "trigger": "button"]), "a button move has no proximity moment")
        XCTAssertNil(ProximityMessage(["type": "peer", "device": "mac", "online": true]))
    }

    func testFlagIsOffByDefault() {
        let defaults = UserDefaults(suiteName: "proximity-flag")!
        defaults.removePersistentDomain(forName: "proximity-flag")
        XCTAssertFalse(ProximityHandoffFlag.enabled(environment: [:], defaults: defaults))
        XCTAssertTrue(ProximityHandoffFlag.enabled(environment: [:], defaults: defaults, remote: true), "server app-config flag")
        XCTAssertTrue(ProximityHandoffFlag.enabled(environment: ["GENITA_PROXIMITY_HANDOFF": "1"], defaults: defaults))
        defaults.set(false, forKey: ProximityHandoffFlag.defaultsKey)
        XCTAssertFalse(ProximityHandoffFlag.enabled(environment: [:], defaults: defaults, remote: true), "a local NO wins over the server")
        XCTAssertFalse(ProximityHandoffFlag.enabled(environment: ["GENITA_PROXIMITY_HANDOFF": "0"], defaults: defaults, remote: true))
        defaults.removePersistentDomain(forName: "proximity-flag")
    }

    func testOnlyDuringALiveCallWithTheMacOpen() {
        XCTAssertTrue(ProximityPolicy.phoneShouldAdvertise(enabled: true, inFront: true, owner: true, callLive: true, serverConnected: true, macOnline: true))
        XCTAssertFalse(ProximityPolicy.phoneShouldAdvertise(enabled: false, inFront: true, owner: true, callLive: true, serverConnected: true, macOnline: true), "flag off")
        XCTAssertFalse(ProximityPolicy.phoneShouldAdvertise(enabled: true, inFront: true, owner: true, callLive: false, serverConnected: true, macOnline: true), "no call")
        XCTAssertFalse(ProximityPolicy.phoneShouldAdvertise(enabled: true, inFront: true, owner: false, callLive: true, serverConnected: true, macOnline: true), "already on the Mac")
        XCTAssertFalse(ProximityPolicy.phoneShouldAdvertise(enabled: true, inFront: false, owner: true, callLive: true, serverConnected: true, macOnline: true), "locked or in the background")
        XCTAssertFalse(ProximityPolicy.phoneShouldAdvertise(enabled: true, inFront: true, owner: true, callLive: true, serverConnected: true, macOnline: false), "Mac app closed: no Bluetooth prompt, no advertising")
        XCTAssertTrue(ProximityPolicy.macShouldScan(enabled: true, macOwner: false, serverConnected: true, phoneActive: true))
        XCTAssertFalse(ProximityPolicy.macShouldScan(enabled: true, macOwner: true, serverConnected: true, phoneActive: true), "the conversation is already here")
        XCTAssertFalse(ProximityPolicy.macShouldScan(enabled: true, macOwner: false, serverConnected: true, phoneActive: false), "the iPhone is locked")
    }
}
