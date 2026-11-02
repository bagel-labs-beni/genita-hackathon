#if DEBUG
import CoreGraphics
import Foundation
import ImageIO

/// Debug builds only. End-to-end runs on the simulator, where the mic is the Mac's: speech comes from
/// raw PCM files (s16le, mono, 24 kHz) fed into the uplink in real time, as the mic would.
///
///   GENITA_FIXTURE_SCRIPT = "/a.pcm@mic+3;/b.pcm@play+1.5;/c.pcm@done+3"
///     mic+N  N s after the mic turns on · play+N  N s after the next reply starts playing (barge-in)
///     done+N N s after the next reply finished playing
///   GENITA_FIXTURE_CAMERA = /photo.jpg | bundle:<name>   stands in for the camera
///   GENITA_CALL_AUTOMIC = 1 / GENITA_CALL_AUTOCAMERA = 1   turn them on when the session is ready
@MainActor final class FixtureMic {
    enum Trigger: String { case mic, play, done }
    struct Step { let name: String; let pcm: Data; let voicedEnd: Int; let trigger: Trigger; let delay: Double }

    var enabled = false
    private var steps: [Step]
    private var current: (step: Step, offset: Int, endReported: Bool)?
    private var loop: Task<Void, Never>?
    private let send: (Data) -> Void
    private let ended: (Date) -> Void
    private let frameBytes = GenitaProtocol.micFrameSamples * 2

    init(steps: [Step], send: @escaping (Data) -> Void, ended: @escaping (Date) -> Void) {
        self.steps = steps
        self.send = send
        self.ended = ended
    }

    static func parse(_ script: String) -> [Step] {
        script.split(separator: ";").compactMap { item in
            let parts = item.split(separator: "@", maxSplits: 1).map(String.init)
            guard parts.count == 2, let data = FileManager.default.contents(atPath: parts[0]) else { return nil }
            let trig = parts[1].split(separator: "+", maxSplits: 1).map(String.init)
            guard let trigger = Trigger(rawValue: trig[0]) else { return nil }
            return Step(name: (parts[0] as NSString).lastPathComponent, pcm: data, voicedEnd: voicedEnd(data), trigger: trigger, delay: Double(trig.count > 1 ? trig[1] : "0") ?? 0)
        }
    }

    /// Byte offset just after the last voiced 20 ms window (same rule as genita-server's smoke test).
    static func voicedEnd(_ pcm: Data) -> Int {
        let win = GenitaProtocol.sampleRate * 2 * 20 / 1000
        var rms: [Double] = []
        pcm.withUnsafeBytes { raw in
            let s = raw.bindMemory(to: Int16.self)
            var o = 0
            while (o + win) / 2 <= s.count {
                var sum = 0.0
                for i in (o / 2)..<((o + win) / 2) { let v = Double(Int16(littleEndian: s[i])); sum += v * v }
                rms.append((sum / Double(win / 2)).squareRoot())
                o += win
            }
        }
        guard let peak = rms.max(), peak > 0 else { return pcm.count }
        var last = rms.count - 1
        while last > 0, rms[last] <= peak * 0.08 { last -= 1 }
        return (last + 1) * win
    }

    /// Real-time sender: 80 ms frames, silence between utterances, like an open mic.
    func run() {
        loop?.cancel()
        loop = Task { [weak self] in
            let clock = ContinuousClock()
            var next = clock.now
            while !Task.isCancelled {
                next = next.advanced(by: .milliseconds(80))
                self?.tick()
                try? await clock.sleep(until: next)
            }
        }
    }

    func stop() { loop?.cancel(); loop = nil }

    func micTurnedOn() { fire(.mic) }
    func playbackStarted() { fire(.play) }
    func utteranceDone() { fire(.done) }

    private func fire(_ trigger: Trigger) {
        guard let step = steps.first, step.trigger == trigger else { return }
        steps.removeFirst()
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(step.delay))
            guard let self else { return }
            Logger.fixture.info("fixture speaks \(step.name, privacy: .public)")
            self.current = (step, 0, false)
        }
    }

    private func tick() {
        guard enabled else { return }
        guard var cur = current else { send(Data(count: frameBytes)); return }
        let end = min(cur.offset + frameBytes, cur.step.pcm.count)
        var frame = cur.step.pcm.subdata(in: cur.offset..<end)
        if frame.count < frameBytes { frame.append(Data(count: frameBytes - frame.count)) }
        cur.offset = end
        if !cur.endReported, cur.offset >= cur.step.voicedEnd { cur.endReported = true; ended(Date()) }
        send(frame)
        current = cur.offset >= cur.step.pcm.count ? nil : cur
    }
}

import os
extension Logger { static let fixture = Logger(subsystem: "ai.thebeni.genita", category: "fixture") }

extension CallController {
    func installFixtures(environment env: [String: String] = ProcessInfo.processInfo.environment) {
        if let path = env["GENITA_FIXTURE_CAMERA"] {
            // "bundle:<name>" = a bundled .jpg (UI tests); anything else is a file path
            let url = path.hasPrefix("bundle:") ? Bundle.main.url(forResource: String(path.dropFirst(7)), withExtension: "jpg") : URL(fileURLWithPath: path)
            if let url, let source = CGImageSourceCreateWithURL(url as CFURL, nil) { camera.fixture = CGImageSourceCreateImageAtIndex(source, 0, nil) }
        }
        if let script = env["GENITA_FIXTURE_SCRIPT"] {
            let steps = FixtureMic.parse(script)
            log.info("fixture mic with \(steps.count) utterances")
            let mic = FixtureMic(steps: steps, send: { [weak self] in self?.sendFixtureAudio($0) }, ended: { [weak self] in self?.fixtureUtteranceEnded(at: $0) })
            fixture = mic
            mic.run()
        }
        let autoMic = env["GENITA_CALL_AUTOMIC"] == "1", autoCamera = env["GENITA_CALL_AUTOCAMERA"] == "1"
        guard autoMic || autoCamera else { return }
        Task { [weak self] in
            while let self, self.link != .live { try? await Task.sleep(for: .milliseconds(100)) }
            try? await Task.sleep(for: .milliseconds(1500))
            if autoCamera { self?.toggleCamera() }
            if autoMic { self?.toggleMic() }
        }
    }
}
#endif
