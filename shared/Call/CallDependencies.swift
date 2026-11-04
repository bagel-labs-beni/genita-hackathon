import Foundation

/// Keep reconnect tests independent of audio hardware, installed voices and the network.
@MainActor protocol CallAudioPlaying: AnyObject {
    var onMicFrame: (@Sendable (Data) -> Void)? { get set }
    var onPlaybackStarted: ((Int) -> Void)? { get set }
    var onUtterancePlayed: ((Int) -> Void)? { get set }
    var onInterrupted: (() -> Void)? { get set }
    var isPlaying: Bool { get }
    func start()
    /// b16: the call turns the mic on at once (B12): build the first engine with the mic (default: plain start)
    func start(preparingMic: Bool)
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
    /// b16: the call is back (scene active, interpretation ended): recover the engine if it is not playing (default: nothing)
    func resume(_ why: String)
    /// Motion details: the user's voice and the reply's loudness 0…1 right now (default: silent)
    var inputLevel: Float { get }
    var outputLevel: Float { get }
}

extension CallAudioPlaying {
    func start(preparingMic: Bool) { start() }
    func playCue(pcm: Data) {}
    func resume(_ why: String) {}
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
    /// Ends the call from the app side: `stop`, then a normal close (a hang-up).
    func close()
    /// Closes without `stop`: the conversation goes on in a new session (handoff return).
    func disconnect()
}

extension CallAudio: CallAudioPlaying {}
extension DeviceVoice: CallVoiceRendering {}
extension CallSocket: CallConnection {}
