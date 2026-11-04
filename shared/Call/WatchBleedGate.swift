import Foundation

/// b16 (391 Mac QA): during a watch-together share, the shared YouTube plays from the Mac's speakers and the mic hears
/// it; voice processing only cancels Genita's own output, so the bleed reached the server as the user's speech (3 false
/// turns in 3 minutes, and a barge-in on the companion).
///
/// While the shared audio is playing (its level above `sharedFloor` in the last `sharedHoldS`), a mic frame goes up
/// only once the mic has been at speech level (≥ −30 dBFS) for 250 ms; until then it is sent as silence (same length,
/// so the stream keeps its timing). The frames held during those 250 ms go up as they were once the gate opens, so the
/// start of what the person says is not lost. Without shared audio nothing changes.
///
/// macOS only, `genita.mac.watchBleedGate` (default on): `defaults write ai.thebeni.genita.mac genita.mac.watchBleedGate -bool NO`.
final class WatchBleedGate: @unchecked Sendable {
    static let shared = WatchBleedGate()

    /// int16 RMS of −30 dBFS: the person speaking into the mic
    static let speechFloor: Double = 1036
    /// int16 RMS of about −50 dBFS: the shared video is making sound
    static let sharedFloor: Double = 104
    /// shared audio counts as playing this long after its last loud chunk
    static let sharedHoldS: TimeInterval = 0.3
    /// how long the mic must stay at speech level before frames go up
    static let openAfterS: TimeInterval = 0.25

    static var enabled: Bool {
        #if os(macOS)
        return UserDefaults.standard.object(forKey: "genita.mac.watchBleedGate") as? Bool ?? true
        #else
        return false
        #endif
    }

    private let lock = NSLock()
    private var sharedUntil: TimeInterval = 0
    /// b16 Mac split playback: the companion's own voice plays on an engine without voice processing, so its echo is
    /// gated the same way while it plays and 300 ms after (`noteOwnVoice`).
    private var ownUntil: TimeInterval = 0
    private var loudFor: TimeInterval = 0
    private var held: [Data] = []
    private var _suppressed = 0
    /// Frames sent as silence since launch (the mic log prints it).
    var suppressed: Int { lock.withLock { _suppressed } }

    /// The shared stream's audio (int16 mono, any length), from ScreenCaptureKit.
    func noteShared(rms: Double, now: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        guard rms >= Self.sharedFloor else { return }
        lock.withLock { sharedUntil = max(sharedUntil, now + Self.sharedHoldS) }
    }

    /// The share ended: nothing is playing any more.
    func sharedStopped() { lock.withLock { sharedUntil = 0; if ownUntil == 0 { loudFor = 0; held = [] } } }

    /// Our reply is queued to play until `end` (system uptime); its echo counts until 300 ms after that.
    func noteOwnVoice(until end: TimeInterval) { lock.withLock { ownUntil = max(ownUntil, end + Self.sharedHoldS) } }
    /// The reply was cut (barge-in, flush): only the 300 ms tail of what already left the speaker is left.
    func ownVoiceStopped(now: TimeInterval = ProcessInfo.processInfo.systemUptime) { lock.withLock { ownUntil = min(ownUntil, now + Self.sharedHoldS) } }
    /// Whether the gate holds mic frames right now (shared audio or our own voice playing), for the log.
    func active(now: TimeInterval = ProcessInfo.processInfo.systemUptime) -> Bool { lock.withLock { now < max(sharedUntil, ownUntil) } }

    /// Mic frames (int16 mono at `sampleRate`), in order → what to send.
    func filter(_ frames: [Data], sampleRate: Double, now: TimeInterval = ProcessInfo.processInfo.systemUptime) -> [Data] {
        guard Self.enabled, !frames.isEmpty else { return frames }
        return lock.withLock {
            guard now < max(sharedUntil, ownUntil) else {
                loudFor = 0
                // the shared sound stopped while frames were held: they go up as they were
                let out = held + frames; held = []
                return out
            }
            var out: [Data] = []
            for f in frames {
                let frameS = Double(f.count / 2) / max(1, sampleRate)
                if Self.rms(int16: f) >= Self.speechFloor { loudFor += frameS } else { loudFor = 0 }
                if loudFor >= Self.openAfterS {
                    out += held; held = []
                    out.append(f)
                } else if loudFor > 0 {
                    held.append(f)   // maybe the person: kept back until it has lasted 250 ms
                } else {
                    // the bleed (or quiet): silence in its place, and anything held was not speech after all
                    _suppressed += 1 + held.count
                    out += held.map { Data(count: $0.count) }; held = []
                    out.append(Data(count: f.count))
                }
            }
            return out
        }
    }

    static func rms(int16 data: Data) -> Double {
        let n = data.count / 2
        guard n > 0 else { return 0 }
        let sum: Double = data.withUnsafeBytes { raw in
            raw.bindMemory(to: Int16.self).prefix(n).reduce(0.0) { $0 + Double($1) * Double($1) }
        }
        return (sum / Double(n)).squareRoot()
    }
}
