import AVFoundation
import Foundation

// MARK: - hold to say ("What's off?" C2)

/// b17 (Chelsea 11/5, hackathon rule: every AI model in Genita is Meta's): the mic records while it is held and the
/// clip goes to genita-server `POST /v1/transcribe` (Muse Voice Transcribe) on release. Apple's speech recognition
/// (SFSpeechRecognizer) is gone. Any failure (no mic permission, no network, the server's switch off → 404, a slow
/// answer past 8 s, nothing heard) ends in one neutral line and the field stays typeable; the mic and the audio
/// session are always released, and a closed sheet or a backgrounded app drops the clip.
///
/// Debug UI tests: GENITA_FAKE_DICTATION="a line" "hears" that line without the mic or the server (C2 screenshot,
/// stays listening 2.5 s after the finger lifts); GENITA_FAKE_DICTATION_AUDIO=1 records 1 s of silence without the
/// mic and sends it to the real endpoint (the error-path test, against the onboarding stub).
@MainActor @Observable final class HoldToSay {
    enum Phase: Equatable { case idle, starting, listening, transcribing }

    private(set) var phase: Phase = .idle
    var listening: Bool { phase == .listening }
    var starting: Bool { phase == .starting }
    var transcribing: Bool { phase == .transcribing }
    /// One clip's words. A new id every time (the same words twice still reach the field); the sheet appends them to
    /// what the field holds when they arrive, so typing during "Transcribing…" is kept.
    struct Heard: Equatable { let id: Int; let words: String }
    private(set) var heard: Heard?
    /// a one-line reason the clip gave nothing (shown under the field); nil = the normal hint
    private(set) var note: String?

    static let failedLine = "Couldn’t catch that. Type it instead."
    static let micLine = "Turn on the microphone for Genita in Settings to say it."
    /// the server takes at most 30 s; the recording stops itself there
    static let maxClip: Duration = .seconds(30)
    /// 250 ms of 24 kHz s16 (the server's own floor)
    static let minClipBytes = GenitaProtocol.sampleRate * 2 / 4

    /// how long the transcript may take after the finger lifts
    @ObservationIgnored var timeout: Duration = .seconds(8)
    private let recorder: any HoldToSayRecording
    @ObservationIgnored private var transcribe: (@Sendable (Data) async throws -> String)?
    /// the finger is still on the mic: the permission answer only starts recording while this is true
    @ObservationIgnored private var held = false
    /// bumped by every start and cancel: a late answer from an older hold changes nothing
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var work: Task<Void, Never>?
    @ObservationIgnored private var cap: Task<Void, Never>?
    @ObservationIgnored private var fakeStop: Task<Void, Never>?

    init(recorder: (any HoldToSayRecording)? = nil) {
        self.recorder = recorder ?? HoldToSay.defaultRecorder()
    }

    private static func defaultRecorder() -> any HoldToSayRecording {
        #if DEBUG
        if ProcessInfo.processInfo.environment["GENITA_FAKE_DICTATION_AUDIO"] == "1" { return SilentClipRecorder() }
        #endif
        return MicClipRecorder()
    }

    private var fake: String? {
        #if DEBUG
        return ProcessInfo.processInfo.environment["GENITA_FAKE_DICTATION"]
        #else
        return nil
        #endif
    }

    /// Finger down. `transcribe` sends the clip (24 kHz mono s16 PCM) and returns the words.
    func start(transcribe: @escaping @Sendable (Data) async throws -> String) {
        // `held`: the finger is still down from a hold that already ended (no mic, 30 s cap) — wait for it to lift
        guard phase == .idle, !held else { return }
        self.transcribe = transcribe
        note = nil
        held = true
        generation += 1
        let g = generation
        if let fake {
            fakeStop?.cancel()
            phase = .listening
            heard = Heard(id: g, words: fake)
            return
        }
        phase = .starting
        work = Task { [weak self] in
            guard let self else { return }
            let granted = await self.recorder.requestPermission()
            guard g == self.generation, self.phase == .starting else { return }
            guard granted else { self.phase = .idle; self.note = HoldToSay.micLine; return }
            guard self.held else { self.phase = .idle; return }   // let go while the prompt was up
            do {
                try self.recorder.start()
            } catch {
                self.recorder.cancel()
                self.phase = .idle
                self.note = HoldToSay.failedLine
                return
            }
            self.phase = .listening
            self.cap = Task { [weak self] in
                try? await Task.sleep(for: HoldToSay.maxClip)
                guard let self, !Task.isCancelled, g == self.generation, self.phase == .listening else { return }
                self.finish()
            }
        }
    }

    /// Finger up: the clip goes to the server; the field gets the words, or the neutral line shows.
    func stop() {
        held = false
        if fake != nil {
            guard phase == .listening else { return }
            fakeStop?.cancel()
            fakeStop = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(2500))
                guard let self, !Task.isCancelled, self.phase == .listening else { return }
                self.phase = .idle
            }
            return
        }
        // still asking for the mic: `held` is false now, so the answer ends the hold without recording
        finish()
    }

    /// the clip → the server (finger up, or the 30 s cap with the finger still down)
    private func finish() {
        guard phase == .listening else { return }
        cap?.cancel(); cap = nil
        let clip = recorder.stop()
        // under a quarter second is a tap, not words: no request
        guard let transcribe, clip.count >= HoldToSay.minClipBytes else { phase = .idle; note = HoldToSay.failedLine; return }
        phase = .transcribing
        let g = generation
        let deadline = timeout
        work = Task { [weak self] in
            let heard = await HoldToSay.within(deadline) { try await transcribe(clip) }
            guard let self, g == self.generation, self.phase == .transcribing else { return }
            self.phase = .idle
            let words = heard?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if words.isEmpty { self.note = HoldToSay.failedLine } else { self.heard = Heard(id: g, words: words) }
        }
    }

    /// The sheet closes, Save, or the app goes to the background: nothing more comes of this hold, the mic is off.
    func cancel() {
        held = false
        generation += 1
        work?.cancel(); work = nil
        cap?.cancel(); cap = nil
        fakeStop?.cancel(); fakeStop = nil
        if phase == .starting || phase == .listening { recorder.cancel() }
        phase = .idle
    }

    /// `op`'s answer, or nil when it throws or takes longer than `limit`.
    nonisolated static func within(_ limit: Duration, _ op: @escaping @Sendable () async throws -> String) async -> String? {
        await withTaskGroup(of: String?.self) { group in
            group.addTask { try? await op() }
            group.addTask { try? await Task.sleep(for: limit); return nil }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }

    /// the field after a clip: what it holds now, then the words
    static func append(_ words: String, to field: String) -> String {
        let kept = field.trimmingCharacters(in: .whitespacesAndNewlines)
        return kept.isEmpty ? words : kept + " " + words
    }
}

// MARK: - recorders

/// What a hold records with.
@MainActor protocol HoldToSayRecording: AnyObject {
    /// the mic permission (asks the first time)
    func requestPermission() async -> Bool
    /// opens the mic; throws when it can't (the caller then calls `cancel`)
    func start() throws
    /// closes the mic and releases the audio session; the clip as 24 kHz mono s16 PCM
    func stop() -> Data
    /// closes the mic and releases the audio session; the clip is dropped
    func cancel()
}

enum MicClipError: Error { case noInput }

/// The clip so far, written on the audio thread. Holds at most 31 s (the server takes 30).
final class ClipBuffer: @unchecked Sendable {
    static let maxBytes = GenitaProtocol.sampleRate * 2 * 31
    private let lock = NSLock()
    private var data = Data()
    func append(_ frame: Data) { lock.withLock { if data.count + frame.count <= ClipBuffer.maxBytes { data.append(frame) } } }
    func take() -> Data { lock.withLock { let d = data; data = Data(); return d } }
}

/// The real mic: its own AVAudioEngine and the call's MicPipeline (any input format → 24 kHz mono s16, as the call
/// sends). It never touches the call's audio engine (this sheet is in onboarding, before any call), and it hands the
/// audio session back (`setActive(false)`) when it stops, so the next call sets up its own session from scratch.
@MainActor final class MicClipRecorder: HoldToSayRecording {
    private var engine: AVAudioEngine?
    private var clip = ClipBuffer()
    private var sessionActive = false

    func requestPermission() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return true
        case .denied: return false
        default: return await AVAudioApplication.requestRecordPermission()
        }
    }

    func start() throws {
        teardown()
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        sessionActive = true
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw MicClipError.noInput }
        let clip = ClipBuffer()
        let pipeline = MicPipeline(input: format)
        pipeline.enabled = true
        input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(format.sampleRate / 50), format: format, block: Self.tap(pipeline, clip))
        self.engine = engine
        self.clip = clip
        engine.prepare()
        try engine.start()
    }

    func stop() -> Data {
        let d = clip.take()
        teardown()
        return d
    }

    func cancel() {
        _ = clip.take()
        teardown()
    }

    private func teardown() {
        if let engine {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        engine = nil
        if sessionActive {
            sessionActive = false
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    /// built outside the main actor: the tap runs on the audio thread
    nonisolated private static func tap(_ pipeline: MicPipeline, _ clip: ClipBuffer) -> AVAudioNodeTapBlock {
        { buffer, _ in for frame in pipeline.process(buffer) { clip.append(frame) } }
    }
}

#if DEBUG
/// UI tests: 1 s of silence, no mic, no permission prompt.
@MainActor final class SilentClipRecorder: HoldToSayRecording {
    func requestPermission() async -> Bool { true }
    func start() throws {}
    func stop() -> Data { Data(count: GenitaProtocol.sampleRate * 2) }
    func cancel() {}
}
#endif
