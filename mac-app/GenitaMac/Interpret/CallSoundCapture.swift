import AVFoundation
import CoreMedia
import ScreenCaptureKit

/// F8-L4 · The call app's sound (FaceTime or Zoom) as PCM s16le mono 24 kHz, the
/// session's mic format, via ScreenCaptureKit — the same permission as screen
/// sharing (Screen Recording). Only that app's audio is captured, and Genita's own
/// audio is excluded, so her whispered translation never loops back into the
/// interpreter. The app sends each chunk as a client frame of kind 4
/// (PROTOCOL.md, "Frames").
final class CallSoundCapture: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    enum Failure: LocalizedError {
        case appNotRunning(String)
        case noDisplay
        var errorDescription: String? {
            switch self {
            case let .appNotRunning(app): return "Open \(app) and start the call first."
            case .noDisplay: return "No display to capture from."
            }
        }
    }

    static let bundleIDs: [String: [String]] = [
        "FaceTime": ["com.apple.FaceTime"],
        "Zoom": ["us.zoom.xos"],
    ]
    static let sampleRate = 24_000
    /// 80 ms, the chunk size PROTOCOL.md recommends
    static let chunkBytes = sampleRate * 2 * 80 / 1000

    /// Called on a background queue with ≤80 ms chunks of PCM s16le mono 24 kHz.
    var onPCM: (@Sendable (Data) -> Void)?
    var onStop: (@Sendable (Error?) -> Void)?

    private var stream: SCStream?
    private let queue = DispatchQueue(label: "ai.thebeni.genita.call-sound")
    private var pending = Data()

    static var permitted: Bool { CGPreflightScreenCaptureAccess() }

    /// Which of the supported call apps are running right now.
    static func runningApps() async -> Set<String> {
        guard let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false) else { return [] }
        let ids = Set(content.applications.map(\.bundleIdentifier))
        return Set(bundleIDs.filter { !ids.isDisjoint(with: $0.value) }.keys)
    }

    func start(app: String) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else { throw Failure.noDisplay }
        let filter: SCContentFilter
        if let ids = Self.bundleIDs[app] {
            guard let target = content.applications.first(where: { ids.contains($0.bundleIdentifier) }) else { throw Failure.appNotRunning(app) }
            filter = SCContentFilter(display: display, including: [target], exceptingWindows: [])
        } else {
            // any other call app (a browser tab, Meet, Teams): all system sound except Genita's own
            filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        }
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = Self.sampleRate
        config.channelCount = 1
        // SCK always runs a video stream; keep it as small and slow as allowed.
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.showsCursor = false
        let s = SCStream(filter: filter, configuration: config, delegate: self)
        try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        try await s.startCapture()
        stream = s
    }

    func stop() {
        let s = stream
        stream = nil
        queue.async { self.pending.removeAll() }
        if let s { Task { try? await s.stopCapture() } }
    }

    // MARK: SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid, let pcm = Self.int16Mono(sampleBuffer) else { return }
        pending.append(pcm)
        while pending.count >= Self.chunkBytes {
            onPCM?(pending.prefix(Self.chunkBytes))
            pending.removeFirst(Self.chunkBytes)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        self.stream = nil
        onStop?(error)
    }

    /// SCK hands out Float32 (non-interleaved) PCM at the configured rate; mix to mono, clamp to s16le.
    static func int16Mono(_ sb: CMSampleBuffer) -> Data? {
        guard let desc = sb.formatDescription?.audioStreamBasicDescription else { return nil }
        var out = Data()
        try? sb.withAudioBufferList { list, _ in
            let buffers = Array(list)
            guard let first = buffers.first, let base = first.mData else { return }
            let isFloat = desc.mFormatFlags & kAudioFormatFlagIsFloat != 0
            let nonInterleaved = desc.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
            let channels = max(1, Int(desc.mChannelsPerFrame))
            let frames = Int(first.mDataByteSize) / (isFloat ? 4 : 2) / (nonInterleaved ? 1 : channels)
            out.reserveCapacity(frames * 2)
            for f in 0..<frames {
                var sum: Float = 0
                for c in 0..<channels {
                    let v: Float
                    if nonInterleaved {
                        guard c < buffers.count, let p = buffers[c].mData else { continue }
                        v = isFloat ? p.assumingMemoryBound(to: Float.self)[f] : Float(p.assumingMemoryBound(to: Int16.self)[f]) / 32768
                    } else {
                        let i = f * channels + c
                        v = isFloat ? base.assumingMemoryBound(to: Float.self)[i] : Float(base.assumingMemoryBound(to: Int16.self)[i]) / 32768
                    }
                    sum += v
                }
                let s = Int16(max(-1, min(1, sum / Float(channels))) * 32767)
                withUnsafeBytes(of: s.littleEndian) { out.append(contentsOf: $0) }
            }
        }
        return out.isEmpty ? nil : out
    }
}
