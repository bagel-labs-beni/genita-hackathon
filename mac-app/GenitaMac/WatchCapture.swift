import Foundation
import CoreImage
import CoreMedia
import CoreVideo
import ScreenCaptureKit

/// Turns ScreenCaptureKit buffers into what watch together sends (F5-L7):
/// - a JPEG (≤1024 px, set in the stream config) only when the picture changed, at most 1 per second;
/// - "blank" when the frames are (almost) black — protected windows capture black (MS-3);
/// - the last 3 s of frames kept in memory on the device only;
/// - system audio as PCM s16le mono 24 kHz in 80 ms chunks.
/// Runs on the stream's sample queue; nothing is written to disk.
final class WatchCapture: @unchecked Sendable {
    struct Thumb { var luma: [Float] }
    static let minFrameInterval: TimeInterval = 1.0
    static let changeThreshold: Float = 0.02     // mean abs luma diff (0…1) on a 32×18 thumbnail
    static let blankLuma: Float = 0.035          // mean luma under this, and…
    static let blankSpread: Float = 0.03         // …max − min under this = black frame
    static let ringSeconds: TimeInterval = 3

    var onFrame: ((Data, Bool) -> Void)?
    var onAudio: ((Data) -> Void)?
    var onBlank: ((Bool) -> Void)?

    private let context = CIContext(options: [.cacheIntermediates: false])
    private var lastThumb: Thumb?
    private var lastSent = Date.distantPast
    private var blankRun = 0
    private var blank = false
    private var isBlankSent = false
    private(set) var ring: [(at: Date, jpeg: Data)] = []
    private var audioBuffer = Data()

    func reset() {
        lastThumb = nil; lastSent = .distantPast; blankRun = 0; blank = false; isBlankSent = false; ring = []; audioBuffer = Data()
    }

    /// A static screen may only emit `.idle` after reconnect, so replay its latest JPEG now.
    /// `reset()` discards the ring when sharing stops (including sign-out or ownership transfer).
    func forceNextFrame() {
        if let latest = ring.last { onFrame?(latest.jpeg, isBlankSent) }
        else { lastThumb = nil; lastSent = .distantPast }
    }

    // MARK: frames

    func handleScreen(_ sampleBuffer: CMSampleBuffer, now: Date = Date()) {
        guard Self.isComplete(sampleBuffer), let pixels = sampleBuffer.imageBuffer else { return }
        let image = CIImage(cvPixelBuffer: pixels)
        guard let thumb = thumbnail(image) else { return }
        let isBlank = Self.isBlank(thumb)
        // two black samples in a row (≥ 1 s) before telling anyone: a fade to black is not a protected window
        blankRun = isBlank ? blankRun + 1 : 0
        let nowBlank = blankRun >= 2
        if nowBlank != blank { blank = nowBlank; onBlank?(nowBlank) }
        let changed = lastThumb.map { Self.difference($0, thumb) > Self.changeThreshold } ?? true
        guard changed || (nowBlank != isBlankSent), now.timeIntervalSince(lastSent) >= Self.minFrameInterval else { return }
        guard let jpeg = context.jpegRepresentation(of: image, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!, options: [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): 0.6]) else { return }
        lastThumb = thumb
        lastSent = now
        isBlankSent = nowBlank
        ring.append((now, jpeg))
        ring.removeAll { now.timeIntervalSince($0.at) > Self.ringSeconds }
        onFrame?(jpeg, nowBlank)
    }

    static func isComplete(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int, let status = SCFrameStatus(rawValue: raw) else { return false }
        return status == .complete
    }

    private func thumbnail(_ image: CIImage) -> Thumb? {
        let w = 32, h = 18
        let sx = CGFloat(w) / image.extent.width, sy = CGFloat(h) / image.extent.height
        let small = image.transformed(by: CGAffineTransform(scaleX: sx, y: sy))
        var bytes = [UInt8](repeating: 0, count: w * h * 4)
        context.render(small, toBitmap: &bytes, rowBytes: w * 4, bounds: CGRect(x: 0, y: 0, width: w, height: h), format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB))
        var luma = [Float](repeating: 0, count: w * h)
        for i in 0..<(w * h) {
            luma[i] = (0.2126 * Float(bytes[i * 4]) + 0.7152 * Float(bytes[i * 4 + 1]) + 0.0722 * Float(bytes[i * 4 + 2])) / 255
        }
        return Thumb(luma: luma)
    }

    static func difference(_ a: Thumb, _ b: Thumb) -> Float {
        guard a.luma.count == b.luma.count, !a.luma.isEmpty else { return 1 }
        var sum: Float = 0
        for i in a.luma.indices { sum += abs(a.luma[i] - b.luma[i]) }
        return sum / Float(a.luma.count)
    }

    static func isBlank(_ t: Thumb) -> Bool {
        guard let lo = t.luma.min(), let hi = t.luma.max() else { return false }
        let mean = t.luma.reduce(0, +) / Float(t.luma.count)
        return mean < blankLuma && hi - lo < blankSpread
    }

    // MARK: audio

    /// SCStream delivers Float32 at the configured 24 kHz / 1 channel. Converted to s16le, sent per 80 ms.
    func handleAudio(_ sampleBuffer: CMSampleBuffer) {
        guard let format = sampleBuffer.formatDescription, let asbd = format.audioStreamBasicDescription else { return }
        guard let block = sampleBuffer.dataBuffer else { return }
        let length = CMBlockBufferGetDataLength(block)
        var raw = Data(count: length)
        let ok = raw.withUnsafeMutableBytes { ptr in CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: ptr.baseAddress!) == kCMBlockBufferNoErr }
        guard ok else { return }
        let frames = CMSampleBufferGetNumSamples(sampleBuffer)
        let isFloat = asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0
        let channels = Int(asbd.mChannelsPerFrame)
        let interleaved = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0
        let pcm = Self.toS16Mono(raw, frames: frames, channels: channels, float: isFloat, interleaved: interleaved)
        // SCStream resamples to sampleRate; if it ever ignores it, drop rather than send the wrong rate
        guard Int(asbd.mSampleRate) == 24_000 else { return }
        audioBuffer.append(pcm)
        let chunk = 3_840
        while audioBuffer.count >= chunk {
            onAudio?(audioBuffer.prefix(chunk))
            audioBuffer.removeFirst(chunk)
        }
    }

    /// First channel only (non-interleaved buffers hold channel planes one after another).
    static func toS16Mono(_ raw: Data, frames: Int, channels: Int, float: Bool, interleaved: Bool) -> Data {
        var out = Data(count: frames * 2)
        raw.withUnsafeBytes { src in
            out.withUnsafeMutableBytes { dst in
                let d = dst.bindMemory(to: Int16.self)
                let stride = interleaved ? max(channels, 1) : 1
                if float {
                    let s = src.bindMemory(to: Float32.self)
                    for i in 0..<min(frames, s.count / stride) {
                        let v = max(-1, min(1, s[i * stride]))
                        d[i] = Int16(v * 32_767)
                    }
                } else {
                    let s = src.bindMemory(to: Int16.self)
                    for i in 0..<min(frames, s.count / stride) { d[i] = s[i * stride] }
                }
            }
        }
        return out
    }
}
