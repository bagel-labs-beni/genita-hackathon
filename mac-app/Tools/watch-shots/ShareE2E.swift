// "Share this window" end to end without the picker (11/4): plays a video file through the Mac's real capture and
// uplink code (WatchCapture → WatchUplink → /v1/watch) the way ScreenCaptureKit hands it over — 4 fps BGRA frames
// with SCFrameStatus.complete (long side ≤ 768 px, like ScreenSharingController.configuration) and 24 kHz mono Float32
// system audio — so the server sees exactly what a shared YouTube window would send. Only the picker, the TCC prompt
// and SCStream itself are left out (they need a person at a real Mac).
//
//   mac-app/Tools/watch-shots/share-e2e.sh <video> <ws://host:port> <sessionId> [leadSec] [tailSec]
//
// stdout, one JSON line each: {"ev":"play"} when the clip starts, {"ev":"frame",...} per frame sent,
// {"ev":"reaction"|"state",...} from the server, {"ev":"done",...} at the end. GENITA_SESSION_TOKEN is the bearer
// (never printed).
import AVFoundation
import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

@main struct ShareE2E {
  static func main() async {
    let a = CommandLine.arguments
    guard a.count >= 4, let server = URL(string: a[2]) else {
      FileHandle.standardError.write("usage: share-e2e <video> <ws://host:port> <sessionId> [leadSec] [tailSec]\n".data(using: .utf8)!)
      exit(2)
    }
    let lead = a.count > 4 ? Double(a[4]) ?? 6.5 : 6.5
    let tail = a.count > 5 ? Double(a[5]) ?? 7 : 7
    let asset = AVURLAsset(url: URL(fileURLWithPath: a[1]))
    let t0 = Date()
    let out = Out(t0: t0)
    let config = WatchUplink.Config(server: server, token: ProcessInfo.processInfo.environment["GENITA_SESSION_TOKEN"], sessionId: a[3])
    let uplink = WatchUplink(config: config) { event in
      switch event {
      case .reaction(let moment): out.line(["ev": "reaction", "moment": moment])
      case .state(let sharing, let blank): out.line(["ev": "state", "sharing": sharing, "blank": blank])
      case .speaker: break
      case .closed: out.line(["ev": "closed"])
      }
    }
    let capture = WatchCapture()
    var sent = 0
    capture.onFrame = { jpeg, blank, motion in
      sent += 1
      uplink.sendFrame(jpeg, blank: blank, motion: motion)
      out.line(["ev": "frame", "bytes": jpeg.count, "motion": Double(motion), "blank": blank])
    }
    capture.onAudio = { uplink.sendAudio($0) }
    uplink.connect(source: "YouTube")

    let duration = (try? await asset.load(.duration).seconds) ?? 0
    let frames = await videoFrames(asset, duration: duration)
    let audio = await audioBuffers(asset)
    guard let first = frames.first, let last = frames.last else { out.line(["ev": "error", "message": "no frames"]); exit(1) }

    // the share's first seconds: the clip's first picture, still (SCStream keeps delivering it at 4 fps)
    let leadEnd = Date().addingTimeInterval(lead)
    while Date() < leadEnd {
      capture.handleScreen(sample(first))
      try? await Task.sleep(nanoseconds: 250_000_000)
    }
    // the clip in real time: frames at 4 fps, audio by its timestamps
    out.line(["ev": "play", "durationSec": duration, "frames": frames.count])
    let start = Date()
    var fi = 0, ai = 0
    while fi < frames.count || ai < audio.count {
      let el = Date().timeIntervalSince(start)
      while fi < frames.count, Double(fi) / 4 <= el { capture.handleScreen(sample(frames[fi])); fi += 1 }
      while ai < audio.count, audio[ai].pts <= el { capture.handleAudio(audio[ai].buffer); ai += 1 }
      try? await Task.sleep(nanoseconds: 20_000_000)
    }
    let tailEnd = Date().addingTimeInterval(tail)
    while Date() < tailEnd {
      capture.handleScreen(sample(last))
      try? await Task.sleep(nanoseconds: 250_000_000)
    }
    uplink.stop()
    try? await Task.sleep(nanoseconds: 500_000_000)
    out.line(["ev": "done", "framesSent": sent, "framesSeen": frames.count])
    exit(0)
  }

  /// 4 fps BGRA frames, long side ≤ 768 px (ScreenSharingController.configuration).
  static func videoFrames(_ asset: AVURLAsset, duration: Double) async -> [CVPixelBuffer] {
    let gen = AVAssetImageGenerator(asset: asset)
    gen.maximumSize = CGSize(width: 768, height: 768)
    gen.appliesPreferredTrackTransform = true
    gen.requestedTimeToleranceBefore = .zero
    gen.requestedTimeToleranceAfter = .zero
    var out: [CVPixelBuffer] = []
    var t = 0.0
    while t < duration {
      if let (cg, _) = try? await gen.image(at: CMTime(seconds: t, preferredTimescale: 600)), let px = pixels(cg) { out.append(px) }
      t += 0.25
    }
    return out
  }

  static func pixels(_ cg: CGImage) -> CVPixelBuffer? {
    var px: CVPixelBuffer?
    guard CVPixelBufferCreate(kCFAllocatorDefault, cg.width, cg.height, kCVPixelFormatType_32BGRA,
      [kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any]] as CFDictionary, &px) == kCVReturnSuccess, let px else { return nil }
    CVPixelBufferLockBaseAddress(px, [])
    defer { CVPixelBufferUnlockBaseAddress(px, []) }
    guard let ctx = CGContext(data: CVPixelBufferGetBaseAddress(px), width: cg.width, height: cg.height, bitsPerComponent: 8,
      bytesPerRow: CVPixelBufferGetBytesPerRow(px), space: CGColorSpace(name: CGColorSpace.sRGB)!,
      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return nil }
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
    return px
  }

  /// What SCStream hands the output: an image sample marked complete.
  static func sample(_ image: CVPixelBuffer) -> CMSampleBuffer {
    var format: CMVideoFormatDescription?
    CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: image, formatDescriptionOut: &format)
    var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: .zero, decodeTimeStamp: .invalid)
    var s: CMSampleBuffer?
    CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: image, formatDescription: format!, sampleTiming: &timing, sampleBufferOut: &s)
    let attachments = CMSampleBufferGetSampleAttachmentsArray(s!, createIfNecessary: true)! as! [NSMutableDictionary]
    attachments[0][SCStreamFrameInfo.status.rawValue] = SCFrameStatus.complete.rawValue
    return s!
  }

  /// System audio the way the stream config asks for it: 24 kHz, 1 channel, Float32.
  static func audioBuffers(_ asset: AVURLAsset) async -> [(pts: Double, buffer: CMSampleBuffer)] {
    guard let track = try? await asset.loadTracks(withMediaType: .audio).first, let reader = try? AVAssetReader(asset: asset) else { return [] }
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
      AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 24_000, AVNumberOfChannelsKey: 1,
      AVLinearPCMIsFloatKey: true, AVLinearPCMBitDepthKey: 32, AVLinearPCMIsNonInterleaved: false, AVLinearPCMIsBigEndianKey: false,
    ])
    guard reader.canAdd(output) else { return [] }
    reader.add(output)
    reader.startReading()
    var out: [(Double, CMSampleBuffer)] = []
    while let b = output.copyNextSampleBuffer() { out.append((b.presentationTimeStamp.seconds, b)) }
    return out
  }
}

final class Out: @unchecked Sendable {
  let t0: Date
  let lock = NSLock()
  init(t0: Date) { self.t0 = t0 }
  func line(_ o: [String: Any]) {
    var o = o
    o["ms"] = Int(Date().timeIntervalSince(t0) * 1000)
    guard let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]), let s = String(data: d, encoding: .utf8) else { return }
    lock.withLock { print(s); fflush(stdout) }
  }
}
