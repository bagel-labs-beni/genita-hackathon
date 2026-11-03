// Pure checks for WatchCapture/WatchUplink; run by mac-app/Tools/watch-shots/check.sh (Command Line Tools are enough).
import Foundation
import CoreMedia
import CoreVideo
import ScreenCaptureKit
@main struct T { static func main() {
  var f: [Float32] = [0, 0.5, -1, 2]
  let d = Data(bytes: &f, count: 16)
  let out = WatchCapture.toS16Mono(d, frames: 4, channels: 1, float: true, interleaved: true)
  let v = out.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
  precondition(v == [0, 16383, -32767, 32767], "\(v)")
  var st: [Float32] = [0.25, 9, 0.5, 9]
  let s = WatchCapture.toS16Mono(Data(bytes: &st, count: 16), frames: 2, channels: 2, float: true, interleaved: true)
  precondition(s.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) } == [8191, 16383])
  precondition(WatchCapture.isBlank(.init(luma: Array(repeating: 0.01, count: 576))))
  var lit = Array(repeating: Float(0.01), count: 576); lit[10] = 0.9
  precondition(!WatchCapture.isBlank(.init(luma: lit)))
  precondition(WatchCapture.difference(.init(luma: [0, 0]), .init(luma: [0.1, 0.1])) > WatchCapture.changeThreshold)
  // A static screen emits idle after reconnect: replay must not wait for another complete buffer.
  let capture = WatchCapture()
  var frames: [Data] = []
  var motions: [Float] = []
  capture.onFrame = { jpeg, _, motion in frames.append(jpeg); motions.append(motion) }
  capture.handleScreen(screenSample(status: .complete))
  precondition(frames.count == 1)
  let initialFrame = frames[0]
  capture.handleScreen(screenSample(status: .idle))
  capture.forceNextFrame()
  precondition(frames == [initialFrame, initialFrame], "Reconnect must immediately replay the static JPEG")
  precondition(motions == [1, 0], "Replaying a static JPEG must not report new motion")
  capture.reset() // stop, account change and ownership transfer all reset the capture
  capture.forceNextFrame()
  precondition(frames.count == 2, "A new share must not replay the previous share's JPEG")
  let e = WatchUplink.decode(#"{"type":"speaker","on":true,"label":"A","name":"the chef"}"#.data(using: .utf8)!)
  precondition(e == .speaker(name: "the chef"))
  precondition(WatchUplink.decode(#"{"type":"speaker","on":false}"#.data(using: .utf8)!) == .speaker(name: nil))
  precondition(WatchUplink.decode(#"{"type":"reaction","utteranceId":3,"moment":"funny"}"#.data(using: .utf8)!) == .reaction(moment: "funny"))
  let c = WatchUplink.Config(server: URL(string: "https://genita.example.com")!, token: "t", sessionId: "abc")
  precondition(c.watchURL!.absoluteString == "wss://genita.example.com/v1/watch?session=abc&token=t", c.watchURL!.absoluteString)
  print("capture/uplink checks ok")
}

static func screenSample(status: SCFrameStatus) -> CMSampleBuffer {
  var pixels: CVPixelBuffer?
  precondition(CVPixelBufferCreate(kCFAllocatorDefault, 32, 18, kCVPixelFormatType_32BGRA,
    [kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any]] as CFDictionary, &pixels) == kCVReturnSuccess)
  let image = pixels!
  CVPixelBufferLockBaseAddress(image, [])
  memset(CVPixelBufferGetBaseAddress(image)!, 255, CVPixelBufferGetBytesPerRow(image) * CVPixelBufferGetHeight(image))
  CVPixelBufferUnlockBaseAddress(image, [])
  var format: CMVideoFormatDescription?
  precondition(CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault,
    imageBuffer: image, formatDescriptionOut: &format) == noErr)
  var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: .zero, decodeTimeStamp: .invalid)
  var sample: CMSampleBuffer?
  precondition(CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: image,
    formatDescription: format!, sampleTiming: &timing, sampleBufferOut: &sample) == noErr)
  let attachments = CMSampleBufferGetSampleAttachmentsArray(sample!, createIfNecessary: true)! as! [NSMutableDictionary]
  attachments[0][SCStreamFrameInfo.status.rawValue] = status.rawValue
  return sample!
}}
