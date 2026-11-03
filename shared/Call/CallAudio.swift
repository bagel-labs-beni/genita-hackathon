import AVFoundation
import os

/// F4-L10 · Call audio: echo-cancelled mic → PCM s16le 24 kHz 80 ms frames, and a playback queue for the
/// companion's PCM chunks that can be flushed at once (barge-in).
///
/// The mic is opened only while the user has it on. Voice processing (echo cancellation) lives on the
/// engine's I/O unit, so turning the mic on rebuilds the engine with it; turning the mic off mutes the
/// uplink at once and releases the hardware as soon as nothing is playing.
@MainActor final class CallAudio {
    /// 80 ms mic frames, called on the audio thread.
    var onMicFrame: (@Sendable (Data) -> Void)?
    /// The first chunk of an utterance went to the speaker.
    var onPlaybackStarted: ((Int) -> Void)?
    /// Every chunk of a finished utterance has played (send `playback_done`).
    var onUtterancePlayed: ((Int) -> Void)?
    /// Phone call, Siri or another app took the audio session.
    var onInterrupted: (() -> Void)?

    private(set) var micOpen = false
    private(set) var voiceProcessing = false
    var isPlaying: Bool { queuedBuffers > 0 }

    private var engine = AVAudioEngine()
    private var player = AVAudioPlayerNode()
    /// Convo P1 #345: a soft listening cue ("mm-hm") played beside the reply queue — never a reply, never counted
    /// in `isPlaying`, never flushed by barge-in bookkeeping. Same engine, so it goes through echo cancellation.
    private var cuePlayer = AVAudioPlayerNode()
    private let playFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(GenitaProtocol.sampleRate), channels: 1, interleaved: false)!
    private var engineHasMic = false
    private var pipeline: MicPipeline?
    private var generation = 0
    private var queuedBuffers = 0
    private var queuedByUtterance: [Int: Int] = [:]
    private var startedUtterances: Set<Int> = []
    private var completeUtterances: Set<Int> = []
    /// Player sample time where each utterance's first chunk starts, and where the queue currently ends.
    private var utteranceStart: [Int: AVAudioFramePosition] = [:]
    private var scheduledEnd: AVAudioFramePosition = 0
    /// Buffers on the player that have not played back yet, in play order. An engine rebuild (the mic turning on
    /// needs voice processing, a route change) moves what is left of them to the new player (AU-48).
    private var scheduled: [PlaybackCarry.Entry<AVAudioPCMBuffer>] = []
    private var observers: [NSObjectProtocol] = []
    private let log = Logger(subsystem: "ai.thebeni.genita", category: "call-audio")

    init() {}

    /// Playback-only engine; the mic is not touched.
    func start() {
        configureSession()
        buildEngine(withMic: false)
        observe()
    }

    func stop() {
        flush()
        micOpen = false
        pipeline?.enabled = false
        if engineHasMic { engine.inputNode.removeTap(onBus: 0) }
        player.stop()
        engine.stop()
        engineHasMic = false
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }

    // MARK: mic

    /// Call after permission is granted. Returns false if no input is available.
    @discardableResult func openMic() -> Bool {
        if micOpen { return true }
        if !engineHasMic { buildEngine(withMic: true) }
        guard engineHasMic else { return false }
        if voiceProcessing { engine.inputNode.isVoiceProcessingInputMuted = false }
        micOpen = true
        pipeline?.enabled = true
        return true
    }

    func closeMic() {
        guard micOpen else { return }
        micOpen = false
        pipeline?.enabled = false
        if voiceProcessing { engine.inputNode.isVoiceProcessingInputMuted = true }
        releaseMicIfIdle()
    }

    // MARK: playback

    /// Queues one TTS chunk (s16le 24 kHz mono) for an utterance.
    func enqueue(pcm: Data, utteranceId: Int) {
        // a reply never plays over a cue (Codex #475 P2)
        if queuedBuffers == 0 { stopCue() }
        let floats = PCM.floats(fromS16LE: pcm)
        guard !floats.isEmpty, let buffer = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(floats.count)) else { return }
        buffer.frameLength = AVAudioFrameCount(floats.count)
        floats.withUnsafeBufferPointer { buffer.floatChannelData![0].update(from: $0.baseAddress!, count: floats.count) }
        if !engine.isRunning { try? engine.start() }
        guard engine.isRunning else { log.error("engine not running; chunk dropped"); return }
        let begin = schedule(buffer, utteranceId: utteranceId)
        if utteranceStart[utteranceId] == nil { utteranceStart[utteranceId] = begin }
        if startedUtterances.insert(utteranceId).inserted { onPlaybackStarted?(utteranceId) }
    }

    /// Puts one buffer at the end of the player's queue; returns the sample time it starts at.
    @discardableResult private func schedule(_ buffer: AVAudioPCMBuffer, utteranceId: Int) -> AVAudioFramePosition {
        if !player.isPlaying { player.play() }
        let begin = max(scheduledEnd, nowSample() ?? 0)
        scheduledEnd = begin + AVAudioFramePosition(buffer.frameLength)
        let gen = generation
        queuedBuffers += 1
        queuedByUtterance[utteranceId, default: 0] += 1
        scheduled.append(.init(utteranceId: utteranceId, start: begin, frames: AVAudioFramePosition(buffer.frameLength), buffer: buffer))
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in self?.played(utteranceId: utteranceId, generation: gen) }
        }
        return begin
    }

    /// Stops a playing cue and ends its uplink window (a reply starts, flush, reset, the user speaks up).
    func stopCue() {
        if cuePlayer.engine != nil, cuePlayer.isPlaying { cuePlayer.stop() }
        pipeline?.clearSilence()
    }

    /// Convo P1 #345: plays a short backchannel cue (s16le 24 kHz mono, ≤ 1.5 s) at once, quietly, while the user is
    /// mid-turn. The uplink is silenced for its length + 300 ms. Skipped while a reply is playing.
    func playCue(pcm: Data) {
        let floats = PCM.floats(fromS16LE: pcm)
        guard !floats.isEmpty, floats.count <= GenitaProtocol.sampleRate * 3 / 2, queuedBuffers == 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(floats.count)) else { return }
        buffer.frameLength = AVAudioFrameCount(floats.count)
        floats.withUnsafeBufferPointer { buffer.floatChannelData![0].update(from: $0.baseAddress!, count: floats.count) }
        if !engine.isRunning { try? engine.start() }
        guard engine.isRunning else { return }
        pipeline?.silence(for: Double(floats.count) / playFormat.sampleRate + 0.3)
        if !cuePlayer.isPlaying { cuePlayer.play() }
        cuePlayer.scheduleBuffer(buffer, at: nil, options: .interrupts, completionHandler: nil)
    }

    /// Where the playhead is in this utterance's audio (ms from its first sample), for lip worker mouth frames.
    func playbackPositionMs(utteranceId: Int) -> Double? {
        guard let start = utteranceStart[utteranceId], let now = nowSample() else { return nil }
        return Double(now - start) * 1000 / playFormat.sampleRate
    }

    private func nowSample() -> AVAudioFramePosition? {
        guard player.isPlaying, let node = player.lastRenderTime, let t = player.playerTime(forNodeTime: node) else { return nil }
        return t.sampleTime
    }

    /// The server sent the whole reply; report when its last chunk has played.
    func markComplete(utteranceId: Int) {
        completeUtterances.insert(utteranceId)
        checkDone(utteranceId)
    }

    /// Utterance IDs are unique only within a server session, unlike an ordinary barge-in flush.
    func resetSession() {
        flush()
        startedUtterances.removeAll()
    }

    /// Stop now and drop everything queued (utterance.cancelled, disconnect, background).
    func flush() {
        stopCue()
        generation += 1
        if player.engine != nil { player.stop() }   // before start() the node has no engine
        queuedBuffers = 0
        queuedByUtterance.removeAll()
        completeUtterances.removeAll()
        utteranceStart.removeAll()
        scheduled.removeAll()
        scheduledEnd = 0
        if engine.isRunning { player.play() }
        releaseMicIfIdle()
    }

    private func played(utteranceId: Int, generation gen: Int) {
        guard gen == generation else { return }
        if let i = scheduled.firstIndex(where: { $0.utteranceId == utteranceId }) { scheduled.remove(at: i) }
        queuedBuffers = max(0, queuedBuffers - 1)
        queuedByUtterance[utteranceId, default: 1] -= 1
        checkDone(utteranceId)
        releaseMicIfIdle()
    }

    private func checkDone(_ utteranceId: Int) {
        guard completeUtterances.contains(utteranceId), (queuedByUtterance[utteranceId] ?? 0) <= 0 else { return }
        completeUtterances.remove(utteranceId)
        queuedByUtterance[utteranceId] = nil
        utteranceStart[utteranceId] = nil
        onUtterancePlayed?(utteranceId)
    }

    // MARK: engine

    private func configureSession() {
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
            try session.setPreferredIOBufferDuration(0.02)
            try session.setActive(true)
        } catch {
            log.error("audio session: \(error.localizedDescription, privacy: .public)")
        }
        #endif
    }

    /// Rebuilds the graph. With the mic, voice processing (AEC) is turned on first; if the platform refuses
    /// (some simulators), the mic still works without it and `voiceProcessing` says so.
    private func buildEngine(withMic: Bool) {
        // AU-48: what is still to be heard survives the rebuild (the greeting goes on when the mic turns on)
        // the render clock runs ahead of the speaker by the output latency: only what reached the speaker was heard
        let latency = AVAudioFramePosition((engine.outputNode.presentationLatency * playFormat.sampleRate).rounded())
        let carry = PlaybackCarry.remaining(scheduled, playedTo: nowSample().map { max(0, $0 - max(0, latency)) })
        let startOf = utteranceStart
        scheduled.removeAll()
        generation += 1
        if engineHasMic { engine.inputNode.removeTap(onBus: 0) }
        engine.stop()
        engine = AVAudioEngine()
        player = AVAudioPlayerNode()
        cuePlayer = AVAudioPlayerNode()
        utteranceStart.removeAll()
        scheduledEnd = 0
        queuedBuffers = 0
        queuedByUtterance.removeAll()
        engineHasMic = false
        voiceProcessing = false
        pipeline = nil
        if withMic {
            let input = engine.inputNode
            do {
                try input.setVoiceProcessingEnabled(true)
                voiceProcessing = true
            } catch {
                log.error("voice processing unavailable: \(error.localizedDescription, privacy: .public)")
            }
            let format = input.outputFormat(forBus: 0)
            if format.sampleRate > 0, format.channelCount > 0 {
                let pipeline = MicPipeline(input: format)
                pipeline.enabled = micOpen
                // the user spoke up over a cue: stop the cue at once (Codex #475 P1)
                pipeline.onSpeechDuringCue = { [weak self] in Task { @MainActor in self?.stopCue() } }
                self.pipeline = pipeline
                let sink = onMicFrame
                input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(format.sampleRate / 50), format: format) { buffer, _ in
                    for frame in pipeline.process(buffer) { sink?(frame) }
                }
                engineHasMic = true
            }
        }
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: playFormat)
        engine.attach(cuePlayer)
        engine.connect(cuePlayer, to: engine.mainMixerNode, format: playFormat)
        cuePlayer.volume = 0.6
        engine.prepare()
        do { try engine.start(); player.play() } catch { log.error("engine start: \(error.localizedDescription, privacy: .public)") }
        log.info("engine built mic=\(self.engineHasMic) aec=\(self.voiceProcessing)")
        resume(carry, startOf: startOf)
    }

    /// Schedules the carried buffers on the new player, the first one cut where the old player stopped, and keeps
    /// each utterance's playhead (lips) continuous. Utterances that finished meanwhile report done.
    private func resume(_ carry: [PlaybackCarry.Entry<AVAudioPCMBuffer>], startOf: [Int: AVAudioFramePosition]) {
        if engine.isRunning {
            for entry in carry {
                guard let buffer = entry.skip == 0 ? entry.buffer : Self.tail(of: entry.buffer, from: entry.skip) else { continue }
                let begin = schedule(buffer, utteranceId: entry.utteranceId)
                if utteranceStart[entry.utteranceId] == nil {
                    let heard = startOf[entry.utteranceId].map { entry.start + entry.skip - $0 } ?? 0
                    utteranceStart[entry.utteranceId] = begin - heard
                }
            }
            if !carry.isEmpty { log.info("engine rebuild kept \(carry.count) buffer(s) of playback") }
        }
        for id in completeUtterances { checkDone(id) }
    }

    private static func tail(of buffer: AVAudioPCMBuffer, from skip: AVAudioFramePosition) -> AVAudioPCMBuffer? {
        let left = AVAudioFrameCount(max(0, AVAudioFramePosition(buffer.frameLength) - skip))
        guard left > 0, let out = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: left),
              let src = buffer.floatChannelData, let dst = out.floatChannelData else { return nil }
        out.frameLength = left
        for ch in 0..<Int(buffer.format.channelCount) { dst[ch].update(from: src[ch] + Int(skip), count: Int(left)) }
        return out
    }

    private func releaseMicIfIdle() {
        guard engineHasMic, !micOpen, queuedBuffers == 0 else { return }
        buildEngine(withMic: false)
    }

    private func observe() {
        guard observers.isEmpty else { return }
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main) { [weak self] note in
            MainActor.assumeIsolated {
                guard let self, (note.object as? AVAudioEngine) === self.engine else { return }
                // Route or format changed (headphones, AirPods). Rebuild with the same mic state.
                let mic = self.engineHasMic
                self.buildEngine(withMic: mic)
                if self.micOpen, !self.engineHasMic { self.micOpen = false }
            }
        })
        #if os(iOS)
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let began = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init) == .began
            MainActor.assumeIsolated { if began { self?.onInterrupted?() } }
        })
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.configureSession()
                self.buildEngine(withMic: self.micOpen)
            }
        })
        #endif
    }
}

/// Converts whatever the input node delivers (often 48 kHz float, sometimes several channels under voice
/// processing) to 24 kHz mono s16 and cuts 80 ms frames. Runs on the audio thread only.
final class MicPipeline: @unchecked Sendable {
    private let converter: AVAudioConverter?
    private let output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(GenitaProtocol.sampleRate), channels: 1, interleaved: true)!
    private var framer = PCMFramer()
    private let lock = NSLock()
    private var _enabled = false
    /// Frames are dropped (not sent) while false, even if the hardware is still running.
    var enabled: Bool {
        get { lock.withLock { _enabled } }
        set { lock.withLock { _enabled = newValue; if !newValue { framer.reset() } } }
    }

    private var silencedUntil: TimeInterval = 0
    /// The user spoke up during a cue window (called on the audio thread).
    var onSpeechDuringCue: (@Sendable () -> Void)?
    /// Convo P1 #345: while a backchannel cue plays (+ a 300 ms tail) the uplink is sent untouched (the user's words are
    /// never dropped, Codex #475 P1 ×2); echo cancellation removes the cue and the server drops any "mm-hm" left in that
    /// turn's transcript. A frame loud enough to be their voice stops the cue at once.
    func silence(for seconds: TimeInterval) {
        lock.withLock { silencedUntil = max(silencedUntil, ProcessInfo.processInfo.systemUptime + seconds) }
    }
    func clearSilence() { lock.withLock { silencedUntil = 0 } }
    /// RMS (int16 units) above which a frame in the cue window counts as the user's voice (stops the cue)
    static let cueVoiceRMS: Double = 500

    init(input: AVAudioFormat) {
        converter = AVAudioConverter(from: input, to: output)
        // Voice processing can report several channels; channel 0 is the processed voice.
        if input.channelCount > 1 { converter?.channelMap = [0] }
    }

    func process(_ buffer: AVAudioPCMBuffer) -> [Data] {
        guard let converter, enabled else { return [] }
        let ratio = output.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { return [] }
        var fed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, out.frameLength > 0, let samples = out.int16ChannelData?[0] else { return [] }
        let chunk = Array(UnsafeBufferPointer(start: samples, count: Int(out.frameLength)))
        var resumed = false
        let frames: [Data] = lock.withLock {
            if ProcessInfo.processInfo.systemUptime < silencedUntil {
                let sum = chunk.reduce(0.0) { $0 + Double($1) * Double($1) }
                let rms = chunk.isEmpty ? 0 : (sum / Double(chunk.count)).squareRoot()
                if rms >= MicPipeline.cueVoiceRMS { silencedUntil = 0; resumed = true }
            }
            return framer.append(chunk)
        }
        if resumed { onSpeechDuringCue?() }
        return frames
    }
}

/// AU-48: which part of the player's queue is still to be heard when the engine is rebuilt.
enum PlaybackCarry {
    struct Entry<Buffer> {
        var utteranceId: Int
        /// player sample time the buffer starts at, and its length in frames
        var start: Int64
        var frames: Int64
        var buffer: Buffer
        /// frames of it already heard
        var skip: Int64 = 0
    }

    /// Drops buffers that already played through `playedTo` and marks how much of the one playing was heard.
    /// No playhead (the player was not running) keeps everything from its start.
    static func remaining<B>(_ entries: [Entry<B>], playedTo now: Int64?) -> [Entry<B>] {
        guard let now else { return entries }
        return entries.compactMap { e in
            guard e.start + e.frames > now else { return nil }
            var kept = e
            kept.skip = max(0, now - e.start)
            return kept
        }
    }
}
