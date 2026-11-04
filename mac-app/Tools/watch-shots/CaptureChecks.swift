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
  // AU-65: a window that goes black and stays still sends one complete frame, then only .idle: still MS-3 after ~1 s
  let still = WatchCapture()
  var blanks: [Bool] = []
  var sent: [(Bool, Float)] = []
  still.onBlank = { blanks.append($0) }
  still.onFrame = { _, blank, motion in sent.append((blank, motion)) }
  let t0 = Date(timeIntervalSince1970: 1_000)
  still.handleScreen(screenSample(status: .complete, fill: 0), now: t0)
  precondition(blanks.isEmpty && sent.count == 1 && sent[0].0 == false, "one black frame is not blank yet")
  still.handleScreen(screenSample(status: .idle, fill: 0), now: t0.addingTimeInterval(0.5))
  precondition(blanks.isEmpty, "a short black is a fade, not a protected window")
  still.handleScreen(screenSample(status: .idle, fill: 0), now: t0.addingTimeInterval(1.0))
  precondition(blanks == [true], "idle frames after a black one turn blank on: \(blanks)")
  precondition(sent.count == 2 && sent[1].0 == true && sent[1].1 == 0, "the server gets the black picture again, marked blank")
  still.handleScreen(screenSample(status: .idle, fill: 0), now: t0.addingTimeInterval(1.5))
  precondition(blanks == [true] && sent.count == 2, "said once")
  still.handleScreen(screenSample(status: .complete, fill: 255), now: t0.addingTimeInterval(2.0))
  precondition(blanks == [true, false], "a picture again clears it")
  // Codex r1 P2: a picture right after the idle blank frame (inside the ⅓ s limit) still tells the server
  let quick = WatchCapture()
  var quickSent: [Bool] = []
  quick.onFrame = { _, blank, _ in quickSent.append(blank) }
  quick.handleScreen(screenSample(status: .complete, fill: 0), now: t0)
  quick.handleScreen(screenSample(status: .idle, fill: 0), now: t0.addingTimeInterval(0.8))
  quick.handleScreen(screenSample(status: .complete, fill: 255), now: t0.addingTimeInterval(0.9))
  precondition(quickSent == [false, true, false], "blank off goes out at once: \(quickSent)")
  // a lit window's idle frames never turn blank
  let lit2 = WatchCapture()
  var litBlanks: [Bool] = []
  lit2.onBlank = { litBlanks.append($0) }
  lit2.handleScreen(screenSample(status: .complete), now: t0)
  lit2.handleScreen(screenSample(status: .idle), now: t0.addingTimeInterval(3))
  precondition(litBlanks.isEmpty)
  let e = WatchUplink.decode(#"{"type":"speaker","on":true,"label":"A","name":"the chef"}"#.data(using: .utf8)!)
  precondition(e == .speaker(name: "the chef"))
  precondition(WatchUplink.decode(#"{"type":"speaker","on":false}"#.data(using: .utf8)!) == .speaker(name: nil))
  precondition(WatchUplink.decode(#"{"type":"reaction","utteranceId":3,"moment":"funny"}"#.data(using: .utf8)!) == .reaction(moment: "funny"))
  let c = WatchUplink.Config(server: URL(string: "https://genita.example.com")!, token: "t", sessionId: "abc")
  precondition(c.watchURL!.absoluteString == "wss://genita.example.com/v1/watch?session=abc&token=t", c.watchURL!.absoluteString)
  print("capture/uplink checks ok")
}

static func screenSample(status: SCFrameStatus, fill: Int32 = 255) -> CMSampleBuffer {
  var pixels: CVPixelBuffer?
  precondition(CVPixelBufferCreate(kCFAllocatorDefault, 32, 18, kCVPixelFormatType_32BGRA,
    [kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any]] as CFDictionary, &pixels) == kCVReturnSuccess)
  let image = pixels!
  CVPixelBufferLockBaseAddress(image, [])
  memset(CVPixelBufferGetBaseAddress(image)!, fill, CVPixelBufferGetBytesPerRow(image) * CVPixelBufferGetHeight(image))
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
