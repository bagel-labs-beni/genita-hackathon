import Foundation
import Testing
@testable import GenitaKit

/// s16le mono 24 kHz: a 220 Hz tone of `amplitude` (0…1) for `ms`.
func lipTestPCM(amplitude: Double, ms: Int) -> Data {
    let n = ms * 24
    var out = Data(capacity: n * 2)
    for i in 0..<n {
        let v = Int16(clamping: Int((sin(Double(i) * 2 * .pi * 220 / 24_000) * amplitude * 32_767).rounded()))
        withUnsafeBytes(of: v.littleEndian) { out.append(contentsOf: $0) }
    }
    return out
}

private func dominant(_ f: LipFrame) -> LipViseme {
    f.weights.max { $0.value < $1.value || ($0.value == $1.value && $0.key.rawValue > $1.key.rawValue) }!.key
}

private func weightSum(_ f: LipFrame) -> Float { f.weights.values.reduce(0, +) }

struct LipGraphemeTests {
    @Test func lettersMapToTheTenShapeSet() {
        #expect(LipGraphemes.visemes(in: "map") == [.MBP, .A, .MBP])
        #expect(LipGraphemes.visemes(in: "the") == [.TH, .EI])
        #expect(LipGraphemes.visemes(in: "we") == [.WQ, .EI])
        #expect(LipGraphemes.visemes(in: "food") == [.FV, .U, .CDG])
        #expect(LipGraphemes.visemes(in: "photo") == [.FV, .O, .CDG, .O])
        #expect(LipGraphemes.visemes(in: "she") == [.CDG, .EI])
        #expect(LipGraphemes.visemes(in: "hello") == [.EI, .L, .O])
    }

    @Test func silentFinalEIsDroppedAndRepeatsCollapse() {
        #expect(LipGraphemes.visemes(in: "make") == [.MBP, .A, .CDG])
        #expect(LipGraphemes.visemes(in: "love") == [.L, .O, .FV])
        #expect(LipGraphemes.visemes(in: "bubble") == [.MBP, .U, .MBP, .L, .EI])
    }

    @Test func punctuationAndCaseAreIgnored() {
        #expect(LipGraphemes.visemes(in: "Map!") == [.MBP, .A, .MBP])
        #expect(LipGraphemes.visemes(in: "...").isEmpty)
    }

    @Test func hangulSyllablesUseTheirJamo() {
        #expect(LipGraphemes.visemes(in: "마") == [.MBP, .A])
        #expect(LipGraphemes.visemes(in: "밥") == [.MBP, .A, .MBP])
        #expect(LipGraphemes.visemes(in: "우리") == [.U, .L, .EI])
    }

    @Test func legacyMouthLettersMapOntoTheNewSet() {
        #expect(LipViseme(legacy: .X) == .rest)
        #expect(LipViseme(legacy: .M) == .MBP)
        #expect(LipViseme(legacy: .E) == .EI)
        #expect(LipViseme(legacy: .F) == .FV)
        #expect(LipViseme(legacy: .S) == .CDG)
    }

    @Test func arpabetAndIPAPhonemesMap() {
        #expect(LipViseme(phoneme: "M") == .MBP)
        #expect(LipViseme(phoneme: "AA1") == .A)
        #expect(LipViseme(phoneme: "UW") == .U)
        #expect(LipViseme(phoneme: "DH") == .TH)
        #expect(LipViseme(phoneme: "θ") == .TH)
        #expect(LipViseme(phoneme: "f") == .FV)
    }
}

struct LipTimelineTests {
    @Test func wordTimingsSpreadTheWordsShapesAcrossItsDuration() {
        let t = LipTimeline()
        t.appendWords([LipWordTiming(text: "map", startMs: 0, endMs: 300)])
        #expect(dominant(t.sample(atMs: 40)) == .MBP)
        #expect(dominant(t.sample(atMs: 150)) == .A)
        #expect(dominant(t.sample(atMs: 260)) == .MBP)
        #expect(dominant(t.sample(atMs: 420)) == .rest)
    }

    @Test func crossfadeWeightsSumToOneAndBlendAtABoundary() {
        let t = LipTimeline()
        t.appendWords([LipWordTiming(text: "ma", startMs: 0, endMs: 200)])
        for ms in stride(from: -50.0, through: 300, by: 7) {
            #expect(abs(weightSum(t.sample(atMs: ms)) - 1) < 1e-4, "t=\(ms)")
        }
        // "ma": MBP weight 1, A weight 2 → boundary at 200/3.
        let mid = t.sample(atMs: 200.0 / 3)
        #expect(abs((mid.weights[.MBP] ?? 0) - 0.5) < 0.05)
        #expect(abs((mid.weights[.A] ?? 0) - 0.5) < 0.05)
        // 60 ms crossfade: 30 ms past the boundary it is all A.
        #expect((t.sample(atMs: 200.0 / 3 + 31).weights[.A] ?? 0) > 0.99)
    }

    @Test func mbpForcesTheMouthClosedWhileOpenVowelsOpenIt() {
        let t = LipTimeline()
        t.appendPCM(lipTestPCM(amplitude: 0.4, ms: 800), offsetMs: 0)
        t.appendWords([LipWordTiming(text: "mmm", startMs: 0, endMs: 400), LipWordTiming(text: "aaa", startMs: 400, endMs: 800)])
        #expect(t.sample(atMs: 200).openness < 0.05)
        #expect(t.sample(atMs: 600).openness > 0.5)
    }

    @Test func silenceMeansRestAndClosed() {
        let t = LipTimeline()
        var pcm = lipTestPCM(amplitude: 0.4, ms: 400)
        pcm.append(lipTestPCM(amplitude: 0, ms: 400))
        t.appendPCM(pcm, offsetMs: 0)
        t.appendWords([LipWordTiming(text: "aaaa", startMs: 0, endMs: 800)])
        let quiet = t.sample(atMs: 650)
        #expect(quiet.openness == 0)
        #expect((quiet.weights[.rest] ?? 0) > 0.99)
        #expect(dominant(t.sample(atMs: 200)) == .A)
    }

    @Test func opennessFollowsLoudnessNormalisedPerUtterance() {
        let t = LipTimeline()
        var pcm = lipTestPCM(amplitude: 0.1, ms: 400)
        pcm.append(lipTestPCM(amplitude: 0.5, ms: 400))
        t.appendPCM(pcm, offsetMs: 1000)
        let soft = t.sample(atMs: 1200).openness, loud = t.sample(atMs: 1600).openness
        #expect(soft > 0.05)
        #expect(loud > soft + 0.2)
        #expect(loud <= 1)
        #expect(t.sample(atMs: 500).openness == 0) // before the first chunk
    }

    @Test func chunksInAnyOrderGiveTheSameFrames() {
        let whole = LipTimeline(), parts = LipTimeline()
        let pcm = lipTestPCM(amplitude: 0.3, ms: 600)
        whole.appendPCM(pcm, offsetMs: 0)
        let bytesPerMs = 48
        parts.appendPCM(pcm.subdata(in: (250 * bytesPerMs)..<pcm.count), offsetMs: 250)
        parts.appendPCM(pcm.subdata(in: 0..<(250 * bytesPerMs)), offsetMs: 0)
        for ms in stride(from: 0.0, through: 600, by: 13) {
            #expect(abs(whole.sample(atMs: ms).openness - parts.sample(atMs: ms).openness) < 1e-5, "t=\(ms)")
        }
    }

    @Test func fallbackAllotsVoicedAudioToWordsByLetterCount() {
        let t = LipTimeline()
        t.appendText("Ma ")
        t.appendText("ooo")
        var pcm = lipTestPCM(amplitude: 0.4, ms: 400)
        pcm.append(lipTestPCM(amplitude: 0, ms: 200))
        pcm.append(lipTestPCM(amplitude: 0.4, ms: 600))
        t.appendPCM(pcm, offsetMs: 0)
        t.finishAudio()
        #expect(dominant(t.sample(atMs: 20)) == .MBP)
        #expect(dominant(t.sample(atMs: 300)) == .A)
        #expect(dominant(t.sample(atMs: 500)) == .rest)
        #expect(dominant(t.sample(atMs: 900)) == .O)
        #expect(t.hasTimings == false)
    }

    @Test func fallbackPacesWordsBeforeAllAudioHasArrived() {
        let t = LipTimeline()
        t.appendText("ma ma ma ma ma ma ma ma ma ma")
        t.appendPCM(lipTestPCM(amplitude: 0.4, ms: 200), offsetMs: 0)
        // Only 200 ms of a long sentence arrived: the first word must not be squeezed into
        // one window and the whole sentence must not be crammed into 200 ms.
        let shapes = Set(stride(from: 0.0, to: 200, by: 10).map { dominant(t.sample(atMs: $0)) })
        #expect(shapes == [.MBP, .A])
    }

    @Test func legacyMouthCuesHoldUntilTheNextCue() {
        let t = LipTimeline()
        t.appendMouthCues([MouthCue(t: 0, v: .M), MouthCue(t: 100, v: .A), MouthCue(t: 200, v: .X)])
        #expect(dominant(t.sample(atMs: 50)) == .MBP)
        #expect(dominant(t.sample(atMs: 150)) == .A)
        #expect(dominant(t.sample(atMs: 260)) == .rest)
    }

    @Test func phonemesWinOverWords() {
        let t = LipTimeline()
        t.appendWords([LipWordTiming(text: "aaa", startMs: 0, endMs: 300)])
        t.appendPhonemes([LipPhonemeTiming(phoneme: "UW", startMs: 0, endMs: 300)])
        #expect(dominant(t.sample(atMs: 150)) == .U)
    }

    @Test func aWordSplitAcrossTwoChunksIsMergedNotDoubled() {
        let t = LipTimeline()
        t.appendWords([LipWordTiming(text: "map", startMs: 0, endMs: 150)])
        t.appendWords([LipWordTiming(text: "map", startMs: 0, endMs: 300)])
        #expect(dominant(t.sample(atMs: 150)) == .A)
    }

    @Test func serverAudioEventFeedsPCMAndTimings() throws {
        let json = #"{"type":"audio","utteranceId":4,"seq":1,"sentence":0,"offsetMs":200,"durationMs":300,"sampleRate":24000,"model":"m","words":[{"w":"map","s":200,"e":500}]}"#
        guard case let .audio(audio) = try JSONDecoder().decode(ServerEvent.self, from: Data(json.utf8)) else {
            Issue.record("not audio"); return
        }
        let t = LipTimeline()
        t.append(audio, pcm: lipTestPCM(amplitude: 0.4, ms: 300))
        #expect(t.hasTimings)
        #expect(dominant(t.sample(atMs: 350)) == .A)
        #expect(t.sample(atMs: 350).openness > 0.3)
        #expect(t.sample(atMs: 100).openness == 0)
    }

    @Test func resetClearsTheUtterance() {
        let t = LipTimeline()
        t.appendPCM(lipTestPCM(amplitude: 0.4, ms: 400), offsetMs: 0)
        t.appendWords([LipWordTiming(text: "aaa", startMs: 0, endMs: 400)])
        t.appendText("aaa")
        t.reset()
        let f = t.sample(atMs: 200)
        #expect(f.openness == 0)
        #expect((f.weights[.rest] ?? 0) > 0.99)
        #expect(t.hasTimings == false)
    }
}
