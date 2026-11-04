import Foundation

/// No on-device speech, in any situation (Chelsea 11/4, TF 341: "robot voice"). A `say` sentence is shown as a
/// caption only (LiveCaptions reads `.say` on its own) and is never spoken with the system voice. The utterance
/// completes as soon as its `reply` arrives, so the server still gets `playback_done` and the turn moves on.
/// The companion is heard only in its own server voice (`audio` frames). DeviceVoice stays in the tree, unused.
@MainActor final class CaptionOnlyVoice: CallVoiceRendering {
    var onPCM: ((Data, Int) -> Void)?
    var onRendered: ((Int) -> Void)?
    /// utterances that had `say` text (kept only so cancel/forget mirror DeviceVoice)
    private(set) var captioned: Set<Int> = []

    init() {}

    func say(_ sentence: ServerEvent.Say) { captioned.insert(sentence.utteranceId) }

    func replyArrived(_ utteranceId: Int) {
        captioned.remove(utteranceId)
        onRendered?(utteranceId)
    }

    func cancel() { captioned.removeAll() }

    func forget(_ utteranceId: Int) { captioned.remove(utteranceId) }

    func mouthLevel(utteranceId: Int, positionMs: Double) -> Float? { nil }
}
