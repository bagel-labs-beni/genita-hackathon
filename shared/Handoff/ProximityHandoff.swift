import Foundation

/// Proximity handoff, the rules both apps share (genita-server PROTOCOL.md "Handoff → Proximity").
///
/// Bring the iPhone close to the Mac during a call and the conversation moves by itself: no code, no tap.
/// Both apps are signed in to the same account, so the server already knows they belong together.
/// The iPhone (owner, live call) advertises a short server-issued token over Bluetooth LE; the Mac scans,
/// and when one token's signal stays strong for half a second it reports it; the server checks that the
/// token is this account's and moves the conversation. Pure logic lives here so it is unit tested;
/// the Bluetooth parts are `PhoneProximity` (iOS) and `MacProximity` (macOS).

/// Visible UI and sound are a design change, so the whole feature is off until Chelsea OKs it.
/// On with the launch env `GENITA_PROXIMITY_HANDOFF=1`, `defaults write <bundle id> genita.proximity.handoff -bool YES`,
/// or the server app-config flag `proximityHandoff` (no app update needed).
enum ProximityHandoffFlag {
    static let defaultsKey = "genita.proximity.handoff"
    static func enabled(environment: [String: String] = ProcessInfo.processInfo.environment, defaults: UserDefaults = .standard, remote: Bool? = nil) -> Bool {
        if let v = environment["GENITA_PROXIMITY_HANDOFF"] { return ["1", "true", "yes", "on"].contains(v.lowercased()) }
        if defaults.object(forKey: defaultsKey) != nil { return defaults.bool(forKey: defaultsKey) }
        return remote ?? false
    }
}

enum ProximityToken {
    /// Genita's handoff service. Scanning filters on it, so only Genita iPhones are ever looked at.
    static let serviceUUID = "6E1D0001-7A2B-4C3D-9E4F-6A656E697461"
    static let alphabet = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
    static let length = 8
    /// The BLE local name an iPhone advertises, if it is a token (anything else nearby is ignored).
    static func parse(_ name: String?) -> String? {
        guard let name, name.count == length, name.allSatisfy({ alphabet.contains($0) }) else { return nil }
        return name
    }
}

/// What `/v1/presence` sends about proximity. Other types are not proximity's business.
enum ProximityMessage: Equatable {
    case token(String, expiresIn: Double)
    case unavailable(reason: String)
    case result(accepted: Bool, reason: String, token: String? = nil, requestID: String? = nil)
    /// An ownership change made by a proximity move (trigger `proximity`).
    case moved(to: ConversationDevice)
    /// Mac: this account's iPhone is (not) advertising a token right now.
    case peer(armed: Bool)

    init?(_ m: [String: Any]) {
        switch m["type"] as? String {
        case "proximity.token":
            guard let t = ProximityToken.parse(m["token"] as? String) else { return nil }
            self = .token(t, expiresIn: (m["expiresIn"] as? NSNumber)?.doubleValue ?? 60)
        case "proximity.unavailable": self = .unavailable(reason: m["reason"] as? String ?? "")
        case "proximity.peer":
            guard let armed = m["armed"] as? Bool else { return nil }
            self = .peer(armed: armed)
        case "proximity.result":
            guard let accepted = m["accepted"] as? Bool else { return nil }
            self = .result(accepted: accepted, reason: m["reason"] as? String ?? "",
                           token: ProximityToken.parse(m["token"] as? String), requestID: m["requestId"] as? String)
        case "ownership":
            guard m["trigger"] as? String == "proximity", let to = ConversationDevice(serverName: m["owner"] as? String) else { return nil }
            self = .moved(to: to)
        default: return nil
        }
    }
}

/// Thresholds. Defaults follow the brief (≈ −45 dBm held 0.5 s, 10 s cooldown); QA can tune them on a Mac with
/// `defaults write ai.thebeni.genita.mac genita.proximity.enterRSSI -int -50` (and exitRSSI, holdSeconds).
struct ProximityConfig: Equatable {
    /// "Close": the smoothed RSSI is at or above this.
    var enterRSSI = -45
    /// Hysteresis: after a trigger the phone must drop below this before it can trigger again.
    var exitRSSI = -55
    /// How long "close" must hold.
    var holdSeconds = 0.5
    /// No second trigger this soon after one.
    var cooldownSeconds = 10.0
    /// A gap between readings longer than this breaks the hold (the phone moved away, or advertising paused).
    var maxGapSeconds = 0.6
    /// Readings needed inside the hold, so one lucky packet can't move a call.
    var minSamples = 3

    static func current(defaults: UserDefaults = .standard) -> ProximityConfig {
        var c = ProximityConfig()
        if let v = defaults.object(forKey: "genita.proximity.enterRSSI") as? Int, (-90 ... -20).contains(v) { c.enterRSSI = v }
        if let v = defaults.object(forKey: "genita.proximity.exitRSSI") as? Int, (-100 ... -25).contains(v) { c.exitRSSI = v }
        if let v = defaults.object(forKey: "genita.proximity.holdSeconds") as? Double, (0.2 ... 3).contains(v) { c.holdSeconds = v }
        c.exitRSSI = min(c.exitRSSI, c.enterRSSI - 1)
        return c
    }
}

/// Turns a stream of (peripheral, RSSI, time) readings into at most one trigger per approach.
///
/// - The RSSI is smoothed with the median of the last 3 readings (one spike doesn't count).
/// - "Close" must hold continuously for `holdSeconds` with at least `minSamples` readings; a reading below
///   `enterRSSI` or a gap over `maxGapSeconds` restarts the hold.
/// - After a report (unless rejected) nothing triggers again until *that* phone is seen below `exitRSSI` (hysteresis: it really left),
///   and not for `cooldownSeconds`. Another phone far away never re-arms it. If that phone's Bluetooth identity goes
///   silent for `forgetFiredSeconds` (address rotation, or it left range), the first phone then seen *not* close re-arms. This survives `reset()` and scan restarts, so "Continue here" with the
///   iPhone still lying next to the Mac never bounces the call back.
/// - A hold only completes while the peripheral's token is known (`canReport`); until then it keeps counting.
struct ProximityDetector {
    var config: ProximityConfig
    private struct Track { var recent: [Int] = []; var lastAt: Double; var closeSince: Double?; var samples = 0; var lastFarAt: Double?; var farSince: Double? }
    private var tracks: [String: Track] = [:]
    private var cooldownUntil = -Double.infinity
    private var rejectedTokens: [String: Double] = [:]
    /// the peripheral that triggered last, until it is seen leaving
    private var fired: (key: String, lastAt: Double)?
    static let forgetFiredSeconds = 20.0
    static let rejectedTokenCooldownSeconds = 3.0
    /// b18 (411 QA 04:06–04:07, ping-pong): after a move to the iPhone the phone must really leave — settled far
    /// readings (3-reading median at or below `exitRSSI`), with no near one and no gap, for this long — before the Mac
    /// may take the call again.
    static let leaveSeconds = 3.0
    /// b18: a move needs an approach: that phone was seen far (at or below `exitRSSI`) at most this long before its
    /// close hold began. A phone lying next to the Mac never qualifies.
    static let approachSeconds = 6.0
    /// set by a move to the iPhone (`requireLeave`): no trigger until no phone has been near for `leaveSeconds`
    private var leaveLatch = false
    /// the phones heard near while the latch is set: each of them must leave (its own 3 s far run with no gap), or go
    /// silent for `forgetFiredSeconds` (Codex r2: another phone's far readings never clear it)
    private var leaveNear: [String: Double] = [:]   // key → when it was last heard (kept across scan restarts)
    /// set by `startScan` / `requireLeave`: a trigger needs an approach (`approachSeconds`)
    private var approachRequired = false

    init(config: ProximityConfig = ProximityConfig()) { self.config = config }

    /// Smoothed RSSI of a peripheral (for the debug status line).
    func smoothed(_ key: String) -> Int? { tracks[key].map { Self.median($0.recent) } }

    /// Returns true when this reading completes a hold: report the peripheral's token now.
    mutating func observe(_ key: String, rssi: Int, at now: Double, canReport: Bool = true, token: String? = nil) -> Bool {
        // 127 = "RSSI not available" in CoreBluetooth; 0 and positives are not real readings either.
        guard rssi < 0 else { return false }
        rejectedTokens = rejectedTokens.filter { $0.value > now }
        if let token, rejectedTokens[token] != nil {
            tracks[key] = nil
            return false
        }
        var t = tracks[key] ?? Track(lastAt: now)
        // a gap also drops the far reading an approach would lean on (Codex r1: no approach across a gap)
        if now - t.lastAt > config.maxGapSeconds { t.recent = []; t.closeSince = nil; t.samples = 0; t.lastFarAt = nil; t.farSince = nil }
        t.lastAt = now
        t.recent = Array((t.recent + [rssi]).suffix(3))
        let level = Self.median(t.recent)
        // b18: "far" and "left" are read from 3 readings, never one raw sample after a gap (−60 once cleared the latch)
        let settled = t.recent.count >= 3
        if level > config.exitRSSI { t.farSince = nil; if leaveLatch { leaveNear[key] = now } }
        else if settled { t.lastFarAt = now; t.farSince = t.farSince ?? now }
        if leaveLatch {
            if leaveNear[key] != nil { leaveNear[key] = now }
            tracks[key] = t
            // left = its own far run spans 3 s of its own readings (silence never counts, Codex r3), or it has been
            // silent for `forgetFiredSeconds`; a phone whose track is gone (scan restart) counts only by its silence
            let known = tracks, heard = leaveNear
            let left = { (k: String) -> Bool in
                if let tr = known[k] {
                    return (tr.farSince.map { tr.lastAt - $0 >= Self.leaveSeconds } ?? false) || now - tr.lastAt >= Self.forgetFiredSeconds
                }
                return now - (heard[k] ?? now) >= Self.forgetFiredSeconds
            }
            if leaveNear.isEmpty ? left(key) : leaveNear.keys.allSatisfy(left) { leaveLatch = false; leaveNear = [:] }
        }
        var fire = false
        if let f = fired {
            if key == f.key {
                fired?.lastAt = now
                if settled, level < config.exitRSSI { fired = nil }
            } else if now - f.lastAt > Self.forgetFiredSeconds, level < config.enterRSSI {
                fired = nil
            }
        }
        if level >= config.enterRSSI {
            if t.closeSince == nil { t.closeSince = now; t.samples = 0 }
            t.samples += 1
            let approached = !approachRequired || (t.lastFarAt.map { far in t.closeSince.map { $0 - far <= Self.approachSeconds } ?? false } ?? false)
            if fired == nil, !leaveLatch, approached, canReport, now >= cooldownUntil, let since = t.closeSince, now - since >= config.holdSeconds, t.samples >= config.minSamples {
                fire = true
                fired = (key, now)
                cooldownUntil = now + config.cooldownSeconds
            }
        } else {
            t.closeSince = nil; t.samples = 0
        }
        tracks[key] = t
        // forget peripherals not heard for a while (tokens rotate, so keys come and go)
        if tracks.count > 16 { tracks = tracks.filter { now - $0.value.lastAt < 5 } }
        return fire
    }

    /// A refusal did not move the call, so it must not require any phone to leave range.
    mutating func reject(token: String, reason: String, at now: Double) {
        tracks = [:]
        fired = nil
        if reason == "unknown_token" {
            rejectedTokens[token] = now + Self.rejectedTokenCooldownSeconds
            // Let this account's phone try promptly, while respecting the server's 200 ms report rate limit.
            cooldownUntil = now + 0.25
        }
    }

    /// Scan restarted: forget the readings, keep token exclusions, the cooldown and the
    /// "must leave first" latch (the next move needs the phone taken away and brought back).
    mutating func reset() { tracks = [:] }

    /// b18: the Mac starts scanning (the iPhone holds the call): readings start over and a move needs an approach, so a
    /// phone already lying next to the Mac when its call starts or comes back is never taken.
    mutating func startScan() { reset(); approachRequired = true }

    /// b18 (411 QA ping-pong: Continue here on the iPhone, or Move to iPhone, undone 2 s later or right after the
    /// cooldown): the conversation moved to the iPhone. No trigger until no phone has been near for `leaveSeconds`, and
    /// then only on an approach. A refusal (`reject`) does not clear this.
    mutating func requireLeave(at now: Double) {
        leaveLatch = true
        leaveNear = [:]
        for k in tracks.keys { tracks[k]?.farSince = nil }
        approachRequired = true
    }

    private static func median(_ v: [Int]) -> Int {
        let s = v.sorted()
        return s.isEmpty ? Int.min : s[s.count / 2]
    }
}

/// When each side should be running its Bluetooth part. Pure, so the "never move a call unexpectedly"
/// rules are unit tested: only during a live call on the iPhone, only with this account's Mac app open.
/// b18 ("징", Chelsea: like the interaction demo): a proximity move plays the touch path's DUO wipe (Dyno's effect,
/// shared/Handoff/EffectSource) on both devices: the iPhone its outgoing half, the Mac its incoming half. There is no
/// touch reading and no local `prepare`/`start`, so each device starts it from its own clock on the same server event
/// (`ownership` trigger `proximity`), with the touch path's lead. Reduce Motion keeps the glide (iPhone) and the fade
/// (Mac). Off with launch env `GENITA_PROXIMITY_WIPE=0`.
enum HandoffProximityMotion {
    /// the touch path's lead between the Mac's `start` and the wipe (MacHandoff `ready`: start = now + 0.8)
    static let lead: Double = 0.8
    /// as if the iPhone met the Mac's right edge, where the call window rests (MacHandoff.placeAtRest)
    static let right = true
    /// the Mac clears its effect this long after it is set (touch path: 4 s)
    static let macHold: Double = 4
    static var enabled: Bool { ProcessInfo.processInfo.environment["GENITA_PROXIMITY_WIPE"] != "0" }
    static func plays(reduceMotion: Bool, enabled: Bool = HandoffProximityMotion.enabled) -> Bool { enabled && !reduceMotion }
    /// A server claim that lands while an effect runs waits 1.2 s (the touch path's effect is driven by the local link,
    /// and the server's copy of the same claim must not cut into it). A proximity move's claim is the move itself:
    /// held, the call would stay on the iPhone (and off the Mac) for 1.2 s under the wipe.
    static func holdsServerClaim(effectRunning: Bool, trigger: String?) -> Bool { effectRunning && trigger != "proximity" }
    /// The Mac's incoming half: `reverse` as the touch path computes it, `(!pending.outgoing) != right` → `right`.
    static func macPayload(id: String, image: String, now: Double) -> TransitionPayload {
        TransitionPayload(id: id, image: image, start: now + lead, outgoing: false, reverse: false != right)
    }
}

enum ProximityPolicy {
    /// iPhone: advertise while it holds the conversation in a live call, in front, with the Mac app online.
    static func phoneShouldAdvertise(enabled: Bool, inFront: Bool, owner: Bool, callLive: Bool, serverConnected: Bool, macOnline: Bool) -> Bool {
        enabled && inFront && owner && callLive && serverConnected && macOnline
    }
    /// Mac: scan while the iPhone has the conversation, is in front and is advertising (the server says so:
    /// it is in a live call), and this Mac's screen is unlocked. So the Mac asks for Bluetooth during a call too.
    static func macShouldScan(enabled: Bool, macOwner: Bool, serverConnected: Bool, phoneActive: Bool, phoneArmed: Bool, screenUnlocked: Bool) -> Bool {
        enabled && !macOwner && serverConnected && phoneActive && phoneArmed && screenUnlocked
    }
    /// The iPhone re-arms (rotates the token) this often; the server keeps a token 60 s.
    static let rotateSeconds = 30.0
}
