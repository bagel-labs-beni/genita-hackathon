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

    /// A frame's pixels; a missing or wrong-size frame fails the test (Codex P2: never "different" by being absent).
    private func bytes(_ image: CGImage?) throws -> [UInt8] {
        let image = try #require(image, "the driver drew a frame")
        #expect(image.width == Int(size.width) && image.height == Int(size.height))
        let data = try #require(image.dataProvider?.data)
        return [UInt8](data as Data)
    }

    private func meanDiff(_ a: [UInt8], _ b: [UInt8]) -> Double {
        guard a.count == b.count, !a.isEmpty else { Issue.record("frames differ in size: \(a.count) vs \(b.count)"); return 0 }
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
    private func play(_ d: FaceDriver, seconds: Double) throws -> [UInt8] {
        var last: CGImage?
        for i in 0...Int(seconds * 25) {
            let t = Double(i) / 25
            last = d.renderLiveFrame(at: t, playbackMs: t * 1000)
        }
        return try bytes(last)
    }

    @Test func theMouthMovesWithTheReplysAudio() throws {
        let d = FaceDriver(faceSet: Self.set, outputSize: size, reduceMotion: true, seed: 3)
        try reply(d, expression: false)
        let rest = try bytes(d.renderLiveFrame(at: 0.9, playbackMs: nil))
        let talking = try bytes(d.renderLiveFrame(at: 0.9, playbackMs: 900))   // "AH"
        print(String(format: "P0 mouth: %.3f", meanDiff(rest, talking)))
        #expect(meanDiff(rest, talking) > 0.05, "the mouth opens on the reply's audio")
    }

    @Test func anExpressionEventShowsOnTheFace() throws {
        let with = FaceDriver(faceSet: Self.set, outputSize: size, reduceMotion: true, seed: 3)
        let without = FaceDriver(faceSet: Self.set, outputSize: size, reduceMotion: true, seed: 3)
        try reply(with, expression: true)
        try reply(without, expression: false)
        let a = try play(with, seconds: 1.5), b = try play(without, seconds: 1.5)
        print(String(format: "P0 expression: %.3f", meanDiff(a, b)))
        #expect(meanDiff(a, b) > 0.05, "the surprised still swells in during the reply")
    }

    /// Same driver, same zoom, same (resting) mouth, two moments of the reply: only the alive motion can tell them
    /// apart (Codex P2: comparing against reduce motion would pass on its overscan alone). Reduce motion is the control.
    @Test func theAliveMotionRunsWhileItSpeaks() throws {
        func drift(reduceMotion: Bool) throws -> Double {
            let d = FaceDriver(faceSet: Self.set, outputSize: size, reduceMotion: reduceMotion, seed: 3)
            try reply(d, expression: false)
            _ = try play(d, seconds: 1.0)
            let a = try bytes(d.renderLiveFrame(at: 1.04, playbackMs: nil))
            let b = try bytes(d.renderLiveFrame(at: 1.6, playbackMs: nil))
            return meanDiff(a, b)
        }
        let live = try drift(reduceMotion: false), held = try drift(reduceMotion: true)
        print(String(format: "P0 alive: %.3f (reduce motion %.3f)", live, held))
        #expect(live > 0.05, "the face moves between two moments of the reply")
        #expect(held < live / 2, "and that movement is the alive motion (reduce motion holds it)")
    }
}
