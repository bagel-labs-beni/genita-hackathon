import AVFoundation
import CoreAudio

/// F8-L4 · Where Genita's voice goes during Mac call interpretation (INT-M1/M2):
///   whisper — the translation of the other person, for the user only: the system
///             output (their headphones), quieter than normal speech.
///   speaker — the user's reply in the other language, for the other person: the
///             Mac's built-in speakers, which the call app's mic picks up.
/// The session's TTS frames are PCM s16le mono 24 kHz; route each utterance with
/// InterpretBoard.route(utteranceId:).
final class InterpretAudioOutput {
    enum Target { case whisper, speaker }

    private let whisper: PCMPlayer
    private let speaker: PCMPlayer

    init(whisperVolume: Float = 0.55) {
        whisper = PCMPlayer(device: nil, volume: whisperVolume)
        speaker = PCMPlayer(device: AudioDevices.builtInSpeaker(), volume: 1)
    }

    /// False when the system output is the built-in speaker: the whisper would go into the call (INT-M0 note).
    static var headphonesLikely: Bool {
        guard let out = AudioDevices.defaultOutput(), let built = AudioDevices.builtInSpeaker() else { return true }
        return out != built
    }

    func play(_ pcm: Data, to target: Target) {
        (target == .whisper ? whisper : speaker).play(pcm)
    }

    /// utterance.cancelled: drop whatever is queued on both.
    func flush() {
        whisper.flush()
        speaker.flush()
    }

    func stop() {
        whisper.stop()
        speaker.stop()
    }
}

/// One AVAudioEngine pinned to an output device (nil = system default), playing queued s16le mono 24 kHz.
final class PCMPlayer {
    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    private let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000, channels: 1, interleaved: false)!
    private let device: AudioDeviceID?
    private let volume: Float
    private var started = false

    init(device: AudioDeviceID?, volume: Float) {
        self.device = device
        self.volume = volume
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: format)
    }

    private func ensureStarted() {
        // An output-device change (sample rate, unplugged headphones) stops the engine behind our back.
        if started, !engine.isRunning { started = false }
        guard !started else { return }
        if var id = device, let unit = engine.outputNode.audioUnit {
            AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &id, UInt32(MemoryLayout<AudioDeviceID>.size))
        }
        node.volume = volume
        do {
            try engine.start()
            started = playSafely()
        } catch {
            started = false
        }
    }

    /// AVAudioPlayerNode.play() raises an Objective-C exception (SIGABRT) on a stopped engine (TF 331 CRASH-1;
    /// Codex #684 found the same path here): play only on a running engine, and catch it if it raises anyway.
    private func playSafely() -> Bool {
        guard engine.isRunning, node.engine === engine else { return false }
        return GenitaCatchObjC({ node.play() }) == nil
    }

    func play(_ pcm: Data) {
        let frames = pcm.count / 2
        guard frames > 0, let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else { return }
        buf.frameLength = AVAudioFrameCount(frames)
        let dst = buf.floatChannelData![0]
        pcm.withUnsafeBytes { raw in
            let src = raw.bindMemory(to: Int16.self)
            for i in 0..<frames { dst[i] = Float(Int16(littleEndian: src[i])) / 32768 }
        }
        ensureStarted()
        node.scheduleBuffer(buf)
    }

    func flush() {
        guard started else { return }
        node.stop()
        if !playSafely() { started = false }   // the next play(_:) restarts the engine
    }

    func stop() {
        node.stop()
        engine.stop()
        started = false
    }
}

enum AudioDevices {
    static func defaultOutput() -> AudioDeviceID? {
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        return AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id) == noErr ? id : nil
    }

    /// The Mac's own speakers: built-in transport with output streams.
    static func builtInSpeaker() -> AudioDeviceID? {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { return nil }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return nil }
        return ids.first { id in
            var transport: UInt32 = 0
            var tsize = UInt32(MemoryLayout<UInt32>.size)
            var taddr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyTransportType, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            guard AudioObjectGetPropertyData(id, &taddr, 0, nil, &tsize, &transport) == noErr, transport == kAudioDeviceTransportTypeBuiltIn else { return false }
            var saddr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioDevicePropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
            var ssize: UInt32 = 0
            return AudioObjectGetPropertyDataSize(id, &saddr, 0, nil, &ssize) == noErr && ssize > 0
        }
    }
}
