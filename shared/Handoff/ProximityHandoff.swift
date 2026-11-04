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
    private struct Track { var recent: [Int] = []; var lastAt: Double; var closeSince: Double?; var samples = 0 }
    private var tracks: [String: Track] = [:]
    private var cooldownUntil = -Double.infinity
    private var rejectedTokens: [String: Double] = [:]
    /// the peripheral that triggered last, until it is seen leaving
    private var fired: (key: String, lastAt: Double)?
    static let forgetFiredSeconds = 20.0
    static let rejectedTokenCooldownSeconds = 3.0

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
        if now - t.lastAt > config.maxGapSeconds { t.recent = []; t.closeSince = nil; t.samples = 0 }
        t.lastAt = now
        t.recent = Array((t.recent + [rssi]).suffix(3))
        let level = Self.median(t.recent)
        var fire = false
        if let f = fired {
            if key == f.key {
                fired?.lastAt = now
                if level < config.exitRSSI { fired = nil }
            } else if now - f.lastAt > Self.forgetFiredSeconds, level < config.enterRSSI {
                fired = nil
            }
        }
        if level >= config.enterRSSI {
            if t.closeSince == nil { t.closeSince = now; t.samples = 0 }
            t.samples += 1
            if fired == nil, canReport, now >= cooldownUntil, let since = t.closeSince, now - since >= config.holdSeconds, t.samples >= config.minSamples {
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

    private static func median(_ v: [Int]) -> Int {
        let s = v.sorted()
        return s.isEmpty ? Int.min : s[s.count / 2]
    }
}

/// When each side should be running its Bluetooth part. Pure, so the "never move a call unexpectedly"
/// rules are unit tested: only during a live call on the iPhone, only with this account's Mac app open.
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
