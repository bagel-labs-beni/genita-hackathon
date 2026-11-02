import AVFoundation
import os

/// Device voice mode (genita-server PROTOCOL.md "Device voice mode"): the server sends each reply sentence as
/// `say` text and the app speaks it with the system voice.
///
/// The speech is not played by AVSpeechSynthesizer itself: `write` renders it to PCM, which goes into the call's
/// own player (`CallAudio.enqueue`). So the voice-processing echo cancellation still covers it, barge-in flushes it
/// like server audio, and `playback_done` fires from the same place. When the server speaks (`ready.tts` = server,
/// e.g. the GPU voice service), no `say` arrives and this class stays idle.
@MainActor final class DeviceVoice {
    /// PCM s16le 24 kHz mono for an utterance, in sentence order.
    var onPCM: ((Data, Int) -> Void)?
    /// Every sentence of the utterance has been rendered and its `reply` has arrived: mark it complete.
    var onRendered: ((Int) -> Void)?

    private let synthesizer = AVSpeechSynthesizer()
    private var queue: [ServerEvent.Say] = []
    private var current: ServerEvent.Say?
    private var generation = 0
    private var replied: Set<Int> = []
    private var watchdog: Task<Void, Never>?
    /// Mouth level (0…1) every `levelStepMs` of each utterance's rendered audio, for a mouth layer.
    private(set) var levels: [Int: [Float]] = [:]
    static let levelStepMs = 40
    private let log = Logger(subsystem: "ai.thebeni.genita", category: "device-voice")

    init() {}

    /// One `say` event: queue it; sentences are rendered one at a time, in order.
    func say(_ s: ServerEvent.Say) {
        guard !s.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        queue.append(s)
        next()
    }

    /// The server's `reply` for this utterance arrived: no more `say` will come for it.
    func replyArrived(_ utteranceId: Int) {
        replied.insert(utteranceId)
        checkRendered(utteranceId)
    }

    /// Barge-in, cancel, disconnect: stop rendering now and drop everything queued.
    func cancel() {
        generation += 1
        queue.removeAll()
        current = nil
        replied.removeAll()
        levels.removeAll()
        watchdog?.cancel()
        watchdog = nil
        synthesizer.stopSpeaking(at: .immediate)
    }

    /// Mouth openness at `positionMs` into the utterance's audio, or nil when nothing is known.
    func mouthLevel(utteranceId: Int, positionMs: Double) -> Float? {
        guard let l = levels[utteranceId], positionMs >= 0 else { return nil }
        let i = Int(positionMs) / Self.levelStepMs
        return i < l.count ? l[i] : nil
    }

    func forget(_ utteranceId: Int) { levels[utteranceId] = nil }

    // MARK: rendering

    private func next() {
        guard current == nil, !queue.isEmpty else { return }
        let s = queue.removeFirst()
        current = s
        let utterance = AVSpeechUtterance(string: s.text)
        utterance.voice = Self.voice(for: s.lang)
        utterance.prefersAssistiveTechnologySettings = false
        let gen = generation
        let render = SpeechRender(sampleRate: Double(GenitaProtocol.sampleRate), stepMs: Self.levelStepMs)
        armWatchdog(gen, ms: 6000) // the first buffer can wait on loading the voice
        synthesizer.write(utterance) { [weak self] buffer in
            // Called off the main thread; convert right away (the buffer may be reused after we return).
            guard let pcm = buffer as? AVAudioPCMBuffer else { return }
            let ended = pcm.frameLength == 0
            // the end buffer drains what the resampler still holds (~30 ms), so sentence tails aren't cut
            let out = ended ? render.finish() : render.convert(pcm)
            Task { @MainActor in self?.rendered(out, ended: ended, say: s, generation: gen) }
        }
    }

    private func rendered(_ out: SpeechRender.Output?, ended: Bool, say s: ServerEvent.Say, generation gen: Int) {
        guard gen == generation, current == s else { return }
        if let out, !out.pcm.isEmpty {
            levels[s.utteranceId, default: []].append(contentsOf: out.levels)
            onPCM?(out.pcm, s.utteranceId)
            armWatchdog(gen)
        }
        if ended { sentenceDone(s) }
    }

    /// `write` ends with an empty buffer. If it never comes, 3 s without a buffer (6 s before the first) stops that render and skips the sentence.
    private func armWatchdog(_ gen: Int, ms: Int = 3000) {
        watchdog?.cancel()
        watchdog = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(ms))
            guard !Task.isCancelled, let self, gen == self.generation, let s = self.current else { return }
            // Give up on this sentence: stop the stuck render (so the next sentence isn't queued behind it) and
            // drop any late buffers from it; the reply still completes so the call doesn't hang on "speaking".
            self.log.error("render stalled for utterance=\(s.utteranceId) sentence=\(s.sentence); skipping it")
            self.generation += 1
            self.synthesizer.stopSpeaking(at: .immediate)
            self.sentenceDone(s)
        }
    }

    private func sentenceDone(_ s: ServerEvent.Say) {
        guard current == s else { return }
        watchdog?.cancel()
        watchdog = nil
        current = nil
        checkRendered(s.utteranceId)
        next()
    }

    private func checkRendered(_ utteranceId: Int) {
        guard replied.contains(utteranceId), current?.utteranceId != utteranceId,
              !queue.contains(where: { $0.utteranceId == utteranceId }) else { return }
        replied.remove(utteranceId)
        onRendered?(utteranceId)
    }

    /// The best installed voice for the BCP-47 hint (premium > enhanced > default), else en-US.
    static func voice(for lang: String) -> AVSpeechSynthesisVoice? {
        let all = AVSpeechSynthesisVoice.speechVoices()
        let prefix = String(lang.prefix(2))
        let exact = all.filter { $0.language == lang }
        let family = exact.isEmpty ? all.filter { $0.language.hasPrefix(prefix) } : exact
        if let best = family.max(by: { $0.quality.rawValue < $1.quality.rawValue }) { return best }
        return AVSpeechSynthesisVoice(language: lang) ?? AVSpeechSynthesisVoice(language: "en-US")
    }
}

/// Converts the synthesizer's buffers (often 22.05 kHz float or int16) to the call's s16le 24 kHz mono, and
/// measures a mouth level per step. Used from the synthesizer's callback queue only (one render per sentence).
final class SpeechRender: @unchecked Sendable {
    struct Output: Sendable {
        var pcm: Data
        var levels: [Float]
    }

    private let output: AVAudioFormat
    private let stepSamples: Int
    private var converter: AVAudioConverter?
    private var inputFormat: AVAudioFormat?
    private var pending: [Int16] = []
    private let lock = NSLock()

    init(sampleRate: Double, stepMs: Int) {
        output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: true)!
        stepSamples = max(1, Int(sampleRate) * stepMs / 1000)
    }

    func convert(_ buffer: AVAudioPCMBuffer) -> Output? {
        lock.lock(); defer { lock.unlock() }
        return run(buffer)
    }

    /// End of the sentence: flush the samples the converter still holds, plus the last partial level step.
    func finish() -> Output? {
        lock.lock(); defer { lock.unlock() }
        return run(nil)
    }

    private func run(_ buffer: AVAudioPCMBuffer?) -> Output? {
        if buffer == nil {
            guard let converter else { return nil }
            return drain(converter)
        }
        guard let buffer else { return nil }
        if inputFormat != buffer.format {
            inputFormat = buffer.format
            converter = AVAudioConverter(from: buffer.format, to: output)
            if buffer.format.channelCount > 1 { converter?.channelMap = [0] }
        }
        guard let converter else { return nil }
        let ratio = output.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { return nil }
        var fed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, out.frameLength > 0, let samples = out.int16ChannelData?[0] else { return nil }
        return emit(Array(UnsafeBufferPointer(start: samples, count: Int(out.frameLength))), last: false)
    }

    private func drain(_ converter: AVAudioConverter) -> Output? {
        var chunk: [Int16] = []
        for _ in 0..<8 {
            guard let out = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: 4096) else { break }
            var error: NSError?
            let status = converter.convert(to: out, error: &error) { _, s in s.pointee = .endOfStream; return nil }
            if out.frameLength > 0, let samples = out.int16ChannelData?[0] { chunk += UnsafeBufferPointer(start: samples, count: Int(out.frameLength)) }
            if error != nil || status != .haveData || out.frameLength == 0 { break }
        }
        converter.reset()
        return emit(chunk, last: true)
    }

    private func emit(_ chunk: [Int16], last: Bool) -> Output {
        let pcm = chunk.withUnsafeBufferPointer { Data(buffer: $0) }
        // Levels per full step; the remainder waits for the next buffer so steps stay aligned to the audio.
        pending.append(contentsOf: chunk)
        var levels: [Float] = []
        while pending.count >= stepSamples {
            levels.append(Self.level(pending[0..<stepSamples]))
            pending.removeFirst(stepSamples)
        }
        if last, !pending.isEmpty {
            levels.append(Self.level(pending[...]))
            pending.removeAll()
        }
        return Output(pcm: pcm, levels: levels)
    }

    /// RMS mapped to 0…1 (speech RMS of ~0.1 full scale is a wide-open mouth).
    static func level(_ samples: ArraySlice<Int16>) -> Float {
        guard !samples.isEmpty else { return 0 }
        var sum: Float = 0
        for s in samples { let f = Float(s) / 32768; sum += f * f }
        let rms = (sum / Float(samples.count)).squareRoot()
        return min(1, rms / 0.1)
    }
}
