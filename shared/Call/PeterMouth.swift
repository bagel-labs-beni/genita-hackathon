import Foundation

/// F4-L18 hook · Peter mouth crops (binary kind 2) waiting for their moment in the reply's audio.
///
/// Frame k belongs to audio time k × 40 ms (25 fps). Audio is never delayed for them: the face keeps the
/// silent loop until an utterance has `jitterMs` of crops buffered ahead of the playhead, then shows crops
/// for that utterance. A cancelled utterance drops its crops (late ones included) and the loop returns.
/// The compositing view (paste the 256 px crop at `lip.changed.peter.pasteDy`) is F4-L18's; it asks
/// `CallController.mouthFrame()` each display frame.
struct PeterMouthBuffer {
    var fps = 25
    var jitterMs = 300
    private var frames: [Int: [UInt32: Data]] = [:]
    private var showing: Set<Int> = []
    private var dropped: Set<Int> = []

    private var frameMs: Double { 1000 / Double(fps) }

    mutating func add(utteranceId: Int, frame: UInt32, jpeg: Data) {
        guard !dropped.contains(utteranceId) else { return }
        frames[utteranceId, default: [:]][frame] = jpeg
    }

    /// Barge-in or text cancel: nothing more from this utterance is shown.
    mutating func cancel(_ utteranceId: Int) {
        frames[utteranceId] = nil
        showing.remove(utteranceId)
        dropped.insert(utteranceId)
    }

    /// The reply finished playing.
    mutating func finish(_ utteranceId: Int) {
        frames[utteranceId] = nil
        showing.remove(utteranceId)
    }

    func count(_ utteranceId: Int) -> Int { frames[utteranceId]?.count ?? 0 }

    /// The crop to show at `positionMs` of this utterance's audio, or nil to keep the silent loop.
    mutating func frame(utteranceId: Int, positionMs: Double) -> Data? {
        guard let crops = frames[utteranceId], positionMs >= 0 else { return nil }
        let k = UInt32(positionMs / frameMs)
        if !showing.contains(utteranceId) {
            let ahead = UInt32((Double(jitterMs) / frameMs).rounded(.up))
            guard crops[k + ahead] != nil || crops.keys.contains(where: { $0 > k + ahead }) else { return nil }
            showing.insert(utteranceId)
        }
        // Exact frame, else the nearest earlier one within 3 frames (a late batch), else the loop.
        for back in 0...min(k, 3) { if let jpeg = crops[k - back] { return jpeg } }
        return nil
    }
}
