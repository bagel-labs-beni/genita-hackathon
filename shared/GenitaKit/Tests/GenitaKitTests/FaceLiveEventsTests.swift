import CoreGraphics
import Foundation
import Testing
@testable import GenitaKit

/// DEMO P0 (11/4 16:00, TF 331): "the face doesn't move while it speaks". One reply's server events (reply.delta,
/// audio + PCM, audio.timing, expression) go through the driver exactly as the display link draws them
/// (`renderLiveFrame`), and the mouth, the expression stills and the alive motion each change the picture.
@MainActor
struct FaceLiveEventsTests {
    private static let set: FaceSet = try! FaceSet(directory: Bundle.module.url(forResource: "face-animal", withExtension: nil, subdirectory: "Fixtures")!)
    private let size = CGSize(width: 90, height: 160)

    private func bytes(_ image: CGImage?) -> [UInt8] {
        guard let image, let data = image.dataProvider?.data else { return [] }
        return [UInt8](data as Data)
    }

    private func meanDiff(_ a: [UInt8], _ b: [UInt8]) -> Double {
        guard a.count == b.count, !a.isEmpty else { return .infinity }
        var s = 0.0
        for i in 0..<a.count { s += abs(Double(a[i]) - Double(b[i])) }
        return s / Double(a.count)
    }

    /// The events one Seamless reply sends (utterance 7, 2 s of audio, aligner words + phonemes, one expression).
    private func reply(_ d: FaceDriver, expression: Bool) throws {
        let delta = try JSONDecoder().decode(ServerEvent.self, from: Data(#"{"type":"reply.delta","utteranceId":7,"text":"Oh wow, that looks amazing"}"#.utf8))
        let audio = try JSONDecoder().decode(ServerEvent.self, from: Data(#"{"type":"audio","utteranceId":7,"seq":1,"sentence":0,"offsetMs":0,"durationMs":2000,"sampleRate":24000,"model":"seamless-m4t-v2","words":[]}"#.utf8))
        guard case let .replyDelta(r) = delta, case let .audio(a) = audio else { Issue.record("decode"); return }
        d.handle(replyDelta: r)
        d.handle(audio: a, pcm: lipTestPCM(amplitude: 0.4, ms: 2000))
        d.handle(timing: 7, words: [LipWordTiming(text: "wow", startMs: 0, endMs: 700), LipWordTiming(text: "amazing", startMs: 800, endMs: 2000)],
                 phonemes: [LipPhonemeTiming(phoneme: "W", startMs: 0, endMs: 200), LipPhonemeTiming(phoneme: "AW", startMs: 200, endMs: 700),
                            LipPhonemeTiming(phoneme: "AH", startMs: 800, endMs: 1100), LipPhonemeTiming(phoneme: "M", startMs: 1100, endMs: 1300),
                            LipPhonemeTiming(phoneme: "EY", startMs: 1300, endMs: 1700), LipPhonemeTiming(phoneme: "IH", startMs: 1700, endMs: 2000)])
        if expression { d.handle(expression: "surprised", intensity: 1, startMs: 0, endMs: 1800, utteranceId: 7) }
    }

    /// Plays the reply for `seconds` at 25 fps on the audio clock; returns the last frame.
    private func play(_ d: FaceDriver, seconds: Double) -> [UInt8] {
        var last: CGImage?
        for i in 0...Int(seconds * 25) {
            let t = Double(i) / 25
            last = d.renderLiveFrame(at: t, playbackMs: t * 1000)
        }
        return bytes(last)
    }

    @Test func theMouthMovesWithTheReplysAudio() throws {
        let d = FaceDriver(faceSet: Self.set, outputSize: size, reduceMotion: true, seed: 3)
        try reply(d, expression: false)
        let rest = bytes(d.renderLiveFrame(at: 0.9, playbackMs: nil))
        let talking = bytes(d.renderLiveFrame(at: 0.9, playbackMs: 900))   // "AH"
        print(String(format: "P0 mouth: %.3f", meanDiff(rest, talking)))
        #expect(meanDiff(rest, talking) > 0.05, "the mouth opens on the reply's audio")
    }

    @Test func anExpressionEventShowsOnTheFace() throws {
        let with = FaceDriver(faceSet: Self.set, outputSize: size, reduceMotion: true, seed: 3)
        let without = FaceDriver(faceSet: Self.set, outputSize: size, reduceMotion: true, seed: 3)
        try reply(with, expression: true)
        try reply(without, expression: false)
        let a = play(with, seconds: 1.5), b = play(without, seconds: 1.5)
        print(String(format: "P0 expression: %.3f", meanDiff(a, b)))
        #expect(meanDiff(a, b) > 0.05, "the surprised still swells in during the reply")
    }

    @Test func theAliveMotionRunsWhileItSpeaks() throws {
        let live = FaceDriver(faceSet: Self.set, outputSize: size, reduceMotion: false, seed: 3)
        let still = FaceDriver(faceSet: Self.set, outputSize: size, reduceMotion: true, seed: 3)
        try reply(live, expression: false)
        try reply(still, expression: false)
        let a = play(live, seconds: 1.5), b = play(still, seconds: 1.5)
        print(String(format: "P0 alive: %.3f", meanDiff(a, b)))
        #expect(meanDiff(a, b) > 0.05, "the head sways with the speech (reduce motion holds it still)")
    }
}
