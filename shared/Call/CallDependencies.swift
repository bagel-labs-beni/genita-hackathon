import Foundation

/// Keep reconnect tests independent of audio hardware, installed voices and the network.
@MainActor protocol CallAudioPlaying: AnyObject {
    var onMicFrame: (@Sendable (Data) -> Void)? { get set }
    var onPlaybackStarted: ((Int) -> Void)? { get set }
    var onUtterancePlayed: ((Int) -> Void)? { get set }
    var onInterrupted: (() -> Void)? { get set }
    var isPlaying: Bool { get }
    func start()
    func stop()
    func openMic() -> Bool
    func closeMic()
    func enqueue(pcm: Data, utteranceId: Int)
    func markComplete(utteranceId: Int)
    func flush()
    func resetSession()
    func playbackPositionMs(utteranceId: Int) -> Double?
    /// Convo P1 #345: a soft backchannel cue while the user talks (default: ignored)
    func playCue(pcm: Data)
    /// Motion details: the user's voice and the reply's loudness 0…1 right now (default: silent)
    var inputLevel: Float { get }
    var outputLevel: Float { get }
}

extension CallAudioPlaying {
    func playCue(pcm: Data) {}
    var inputLevel: Float { 0 }
    var outputLevel: Float { 0 }
}

@MainActor protocol CallVoiceRendering: AnyObject {
    var onPCM: ((Data, Int) -> Void)? { get set }
    var onRendered: ((Int) -> Void)? { get set }
    func say(_ sentence: ServerEvent.Say)
    func replyArrived(_ utteranceId: Int)
    func cancel()
    func forget(_ utteranceId: Int)
    func mouthLevel(utteranceId: Int, positionMs: Double) -> Float?
}

protocol CallConnection: AnyObject, Sendable {
    var onOpen: (@MainActor () -> Void)? { get set }
    var onMessage: (@MainActor (CallSocket.Incoming) -> Void)? { get set }
    var onClose: (@MainActor (CallSocket.Closure) -> Void)? { get set }
    func connect(url: URL, token: String?)
    func send(_ message: ClientMessage)
    func send(audio: Data)
    func close()
}

extension CallAudio: CallAudioPlaying {}
extension DeviceVoice: CallVoiceRendering {}
extension CallSocket: CallConnection {}
