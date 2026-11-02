// FaceRender — a face set + speech → mp4 with sound, through the same GenitaKit lip timeline and
// face renderer the apps use. Audio is fed to the timeline in 200 ms chunks, as the server streams it.
//
//   FaceRender --face <dir> (--audio <wav|aiff|…> | --say "<text>") [--timings words.json]
//              [--text "<reply text>"] --out out.mp4 [--size 540x960] [--emotion happy]
//              [--seed 1] [--frames-dir dir --frames-prefix name]
//
// --say synthesises with AVSpeechSynthesizer and uses its word markers as timings (when the
// voice reports them). Without timings the mouth comes from --text + loudness.
// Exit 3 = speech synthesis unavailable on this machine (--say only).
// Prints: frames, render fps (wall), A/V offset (lag in ms that best lines up the rendered
// mouth with the audio loudness; positive = mouth late).

import AVFoundation
import CoreImage
import Foundation
import GenitaKit
import ImageIO
import UniformTypeIdentifiers

struct Options {
    var face = ""
    var audio: String?
    var say: String?
    var timings: String?
    var text: String?
    var out = ""
    var width = 540, height = 960
    var emotion: String?
    var seed: UInt64 = 1
    var framesDir: String?
    var framesPrefix = "face"
    var bitrate = 1_100_000
}

func fail(_ s: String) -> Never {
    FileHandle.standardError.write(Data((s + "\n").utf8))
    exit(1)
}

func parse() -> Options {
    var o = Options()
    var it = CommandLine.arguments.dropFirst().makeIterator()
    while let a = it.next() {
        func v() -> String { guard let x = it.next() else { fail("missing value for \(a)") }; return x }
        switch a {
        case "--face": o.face = v()
        case "--audio": o.audio = v()
        case "--say": o.say = v()
        case "--timings": o.timings = v()
        case "--text": o.text = v()
        case "--out": o.out = v()
        case "--size":
            let p = v().split(separator: "x").compactMap { Int($0) }
            guard p.count == 2 else { fail("--size WxH") }
            o.width = p[0]; o.height = p[1]
        case "--emotion": o.emotion = v()
        case "--seed": o.seed = UInt64(v()) ?? 1
        case "--frames-dir": o.framesDir = v()
        case "--frames-prefix": o.framesPrefix = v()
        case "--bitrate": o.bitrate = Int(v()) ?? o.bitrate
        default: fail("unknown argument \(a)")
        }
    }
    if o.face.isEmpty || o.out.isEmpty || (o.audio == nil && o.say == nil) {
        fail("usage: FaceRender --face <dir> (--audio <file> | --say <text>) [--timings words.json] [--text <text>] --out <mp4> [--size 540x960]")
    }
    return o
}

// MARK: audio in

let outRate = Double(GenitaProtocol.sampleRate)
let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: outRate, channels: 1, interleaved: true)!

/// Converts any PCM buffers to 24 kHz mono s16.
final class Resampler {
    private var converter: AVAudioConverter?
    private(set) var out = Data()
    private(set) var inputFrames = 0
    private(set) var inputRate = 0.0
    private(set) var inputBytesPerFrame = 2.0

    func add(_ buffer: AVAudioPCMBuffer) {
        guard buffer.frameLength > 0 else { return }
        if converter == nil {
            converter = AVAudioConverter(from: buffer.format, to: outFormat)
            inputRate = buffer.format.sampleRate
            inputBytesPerFrame = Double(buffer.format.streamDescription.pointee.mBytesPerFrame)
        }
        inputFrames += Int(buffer.frameLength)
        let cap = AVAudioFrameCount(Double(buffer.frameLength) * outRate / buffer.format.sampleRate + 1024)
        let dst = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: cap)!
        var fed = false
        var err: NSError?
        converter!.convert(to: dst, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true; status.pointee = .haveData; return buffer
        }
        if let err { fail("convert: \(err)") }
        out.append(Data(bytes: dst.int16ChannelData![0], count: Int(dst.frameLength) * 2))
    }
}

func readAudio(_ path: String) -> Data {
    let file: AVAudioFile
    do { file = try AVAudioFile(forReading: URL(fileURLWithPath: path)) } catch { fail("audio: \(error)") }
    let r = Resampler()
    while file.framePosition < file.length {
        let buf = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 8192)!
        do { try file.read(into: buf) } catch { fail("audio read: \(error)") }
        if buf.frameLength == 0 { break }
        r.add(buf)
    }
    return r.out
}

/// While writing to buffers, this macOS reports markers through the delegate, not the marker callback.
final class MarkerCollector: NSObject, AVSpeechSynthesizerDelegate {
    var markers: [AVSpeechSynthesisMarker] = []
    func speechSynthesizer(_ s: AVSpeechSynthesizer, willSpeak marker: AVSpeechSynthesisMarker, utterance: AVSpeechUtterance) {
        markers.append(marker)
    }
}

/// AVSpeechSynthesizer → (24 kHz s16 PCM, word timings from its markers; empty if the voice gives none).
func synthesize(_ text: String) -> (Data, [LipWordTiming]) {
    let synth = AVSpeechSynthesizer()
    let utterance = AVSpeechUtterance(string: text)
    let env = ProcessInfo.processInfo.environment["FACERENDER_VOICE"]
    utterance.voice = env.flatMap { AVSpeechSynthesisVoice(identifier: $0) } ?? AVSpeechSynthesisVoice(language: "en-US")
    print("voice: \(utterance.voice?.identifier ?? "default")")
    let r = Resampler()
    var markers: [AVSpeechSynthesisMarker] = []
    let collector = MarkerCollector()
    synth.delegate = collector
    var done = false
    synth.write(utterance, toBufferCallback: { buffer in
        guard let pcm = buffer as? AVAudioPCMBuffer, pcm.frameLength > 0 else { done = true; return }
        r.add(pcm)
    }, toMarkerCallback: { m in markers += m })
    let deadline = Date().addingTimeInterval(60)
    while !done && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    if markers.isEmpty { markers = collector.markers }
    if r.out.isEmpty {
        FileHandle.standardError.write(Data("speech synthesis produced no audio on this machine\n".utf8))
        exit(3)   // 3 = synthesis unavailable (CI skips); anything else is a real failure
    }
    let words = markers.filter { $0.mark == .word }
    print("synth: \(markers.count) markers (\(words.count) word, \(markers.filter { $0.mark == .phoneme }.count) phoneme), \(r.inputFrames) frames at \(r.inputRate) Hz")
    guard !words.isEmpty, r.inputRate > 0 else { return (r.out, []) }
    // byteSampleOffset is a byte offset into the synthesiser's own output format
    // (Float32 mono here: 4 bytes a frame), so divide by its bytes per frame.
    let perFrame = max(1, r.inputBytesPerFrame)
    let ns = text as NSString
    let audioMs = Int(Double(r.out.count / 2) / outRate * 1000)
    var out: [LipWordTiming] = []
    for (k, m) in words.enumerated() {
        let s = Int(Double(m.byteSampleOffset) / perFrame / r.inputRate * 1000)
        let next = k + 1 < words.count ? Int(Double(words[k + 1].byteSampleOffset) / perFrame / r.inputRate * 1000) : min(audioMs, s + 600)
        guard m.textRange.location != NSNotFound, m.textRange.location + m.textRange.length <= ns.length else { continue }
        out.append(LipWordTiming(text: ns.substring(with: m.textRange), startMs: s, endMs: max(s + 40, next - 10)))
    }
    print("synth: \(words.count) word markers (\(Int(perFrame)) bytes a frame), audio \(audioMs) ms")
    return (r.out, out)
}

struct JSONWord: Decodable { var w: String; var s: Int; var e: Int }

// MARK: main

let o = parse()
let faceSet: FaceSet
do { faceSet = try FaceSet(directory: URL(fileURLWithPath: o.face)) } catch { fail("face set: \(error)") }
print("face set: \(faceSet.patches.count)/10 patches; notes: \(faceSet.notes.joined(separator: "; "))")

var pcm: Data
var words: [LipWordTiming] = []
if let say = o.say {
    (pcm, words) = synthesize(say)
} else {
    pcm = readAudio(o.audio!)
}
if let tPath = o.timings {
    guard let d = FileManager.default.contents(atPath: tPath), let list = try? JSONDecoder().decode([JSONWord].self, from: d) else { fail("timings: unreadable") }
    words = list.map { LipWordTiming(text: $0.w, startMs: $0.s, endMs: $0.e) }
}
if pcm.count < 4800 { fail("audio too short") }

let timeline = LipTimeline()
if let text = o.text {
    // Stream the text in a few deltas like reply.delta.
    var rest = Substring(text)
    while !rest.isEmpty { timeline.appendText(String(rest.prefix(17))); rest = rest.dropFirst(17) }
}
let chunkBytes = 200 * 48
var off = 0
while off < pcm.count {
    let end = min(pcm.count, off + chunkBytes)
    let offsetMs = off / 48
    timeline.appendPCM(pcm.subdata(in: off..<end), offsetMs: offsetMs)
    timeline.appendWords(words.filter { $0.startMs >= offsetMs && $0.startMs < offsetMs + 200 })
    off = end
}
timeline.finishAudio()
print("mouth timing: \(timeline.hasTimings ? "word timings (\(words.count) words)" : (o.text != nil ? "text + loudness fallback" : "loudness only"))")

let size = CGSize(width: o.width, height: o.height)
let renderer = FaceRenderer(faceSet: faceSet, outputSize: size, seed: o.seed)
if let e = o.emotion { renderer.setEmotion(e, at: 0.3) }

let fps = 25
let audioMs = Double(pcm.count / 2) / outRate * 1000
let frameCount = Int((audioMs + 300) / 1000 * Double(fps))

// Writer
let outURL = URL(fileURLWithPath: o.out)
try? FileManager.default.removeItem(at: outURL)
let writer: AVAssetWriter
do { writer = try AVAssetWriter(outputURL: outURL, fileType: .mp4) } catch { fail("writer: \(error)") }
let vIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: o.width, AVVideoHeightKey: o.height,
    AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: o.bitrate, AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel],
])
vIn.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: vIn, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: o.width, kCVPixelBufferHeightKey as String: o.height,
])
let aIn = AVAssetWriterInput(mediaType: .audio, outputSettings: [
    AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: outRate, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 48_000,
])
aIn.expectsMediaDataInRealTime = false
writer.add(vIn); writer.add(aIn)
guard writer.startWriting() else { fail("writer: \(String(describing: writer.error))") }
writer.startSession(atSourceTime: .zero)

var asbd = AudioStreamBasicDescription(mSampleRate: outRate, mFormatID: kAudioFormatLinearPCM,
    mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
    mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2, mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0)
var audioFormat: CMAudioFormatDescription?
CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &audioFormat)

func audioSample(from: Int, frames: Int) -> CMSampleBuffer {
    let bytes = frames * 2
    var block: CMBlockBuffer?
    CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: bytes, blockAllocator: nil, customBlockSource: nil, offsetToData: 0, dataLength: bytes, flags: 0, blockBufferOut: &block)
    pcm.withUnsafeBytes { raw in
        _ = CMBlockBufferReplaceDataBytes(with: raw.baseAddress! + from * 2, blockBuffer: block!, offsetIntoDestination: 0, dataLength: bytes)
    }
    var sb: CMSampleBuffer?
    CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil, dataBuffer: block!, formatDescription: audioFormat!, sampleCount: frames, presentationTimeStamp: CMTime(value: CMTimeValue(from), timescale: CMTimeScale(outRate)), packetDescriptions: nil, sampleBufferOut: &sb)
    return sb!
}

let totalAudioFrames = pcm.count / 2
var audioPos = 0
var audioDone = false
var videoDone = false
setvbuf(stdout, nil, _IOLBF, 0)
var openness: [Double] = []
var mouthMotion: [Double] = []
var renderSeconds = 0.0
let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
let wall = Date()
var restMouth: [Float]?

/// Mean luma of the mouth/jaw area of a frame (rendered pixels), for the pixel-based A/V check.
func mouthArea(_ pb: CVPixelBuffer) -> [Float] {
    CVPixelBufferLockBaseAddress(pb, .readOnly); defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
    let base = CVPixelBufferGetBaseAddress(pb)!.assumingMemoryBound(to: UInt8.self)
    let row = CVPixelBufferGetBytesPerRow(pb)
    let sx = Double(o.width) / faceSet.pixelSize.width, sy = Double(o.height) / faceSet.pixelSize.height
    let s = max(sx, sy)
    let dx = (Double(o.width) - faceSet.pixelSize.width * s) / 2, dy = (Double(o.height) - faceSet.pixelSize.height * s) / 2
    let m = faceSet.mouthBox.insetBy(dx: -faceSet.mouthBox.width * 0.3, dy: -faceSet.mouthBox.height * 1.0)
    var out: [Float] = []
    let y0 = max(0, Int(m.minY * s + dy)), y1 = min(o.height, Int(m.maxY * s + dy))
    let x0 = max(0, Int(m.minX * s + dx)), x1 = min(o.width, Int(m.maxX * s + dx))
    for y in stride(from: y0, to: y1, by: 2) {
        for x in stride(from: x0, to: x1, by: 2) {
            let p = base + y * row + x * 4
            out.append(0.114 * Float(p[0]) + 0.587 * Float(p[1]) + 0.299 * Float(p[2]))
        }
    }
    return out
}

func renderFrame(_ i: Int) {
    let t = Double(i) / Double(fps)
    let lip = timeline.sample(atMs: t * 1000)
    openness.append(Double(lip.openness))
    let r0 = Date()
    let image = renderer.image(at: t, lip: lip)
    var pbOut: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pbOut)
    guard let pb = pbOut else { fail("no pixel buffer") }
    renderer.ciContext.render(image, to: pb, bounds: CGRect(origin: .zero, size: size), colorSpace: colorSpace)
    renderSeconds += Date().timeIntervalSince(r0)
    if restMouth == nil {
        // Reference: the same frame with the mouth at rest.
        var refOut: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &refOut)
        let ref = FaceRenderer(faceSet: faceSet, outputSize: size, seed: o.seed, reduceMotion: true)
        if let e = o.emotion { ref.setEmotion(e, at: 0) }
        renderer.ciContext.render(ref.image(at: 1, lip: .rest), to: refOut!, bounds: CGRect(origin: .zero, size: size), colorSpace: colorSpace)
        restMouth = mouthArea(refOut!)
    }
    let area = mouthArea(pb)
    var d = 0.0
    for k in 0..<min(area.count, restMouth!.count) { d += Double(abs(area[k] - restMouth![k])) }
    mouthMotion.append(d / Double(max(1, area.count)))
    if !adaptor.append(pb, withPresentationTime: CMTime(value: CMTimeValue(i), timescale: CMTimeScale(fps))) {
        fail("video append: \(String(describing: writer.error))")
    }
}

// Each input pulls its own data when the writer is ready; the writer interleaves them.
let group = DispatchGroup()
group.enter(); group.enter()
var nextFrame = 0
vIn.requestMediaDataWhenReady(on: DispatchQueue(label: "video")) {
    while vIn.isReadyForMoreMediaData && nextFrame < frameCount {
        renderFrame(nextFrame); nextFrame += 1
    }
    if nextFrame >= frameCount, !videoDone { videoDone = true; vIn.markAsFinished(); group.leave() }
}
aIn.requestMediaDataWhenReady(on: DispatchQueue(label: "audio")) {
    while aIn.isReadyForMoreMediaData && audioPos < totalAudioFrames {
        let n = min(4800, totalAudioFrames - audioPos)
        if !aIn.append(audioSample(from: audioPos, frames: n)) { fail("audio append: \(String(describing: writer.error))") }
        audioPos += n
    }
    if audioPos >= totalAudioFrames, !audioDone { audioDone = true; aIn.markAsFinished(); group.leave() }
}
group.wait()
let sem = DispatchSemaphore(value: 0)
writer.finishWriting { sem.signal() }
sem.wait()
if writer.status != .completed { fail("writer: \(String(describing: writer.error))") }
let wallSeconds = Date().timeIntervalSince(wall)

// MARK: A/V offset

/// Audio RMS per frame period (40 ms at 25 fps), centred on each frame time.
func audioEnvelope(count: Int) -> [Double] {
    pcm.withUnsafeBytes { raw -> [Double] in
        let s = raw.bindMemory(to: Int16.self)
        let half = Int(outRate) / fps / 2
        return (0..<count).map { i in
            let c = Int(Double(i) / Double(fps) * outRate)
            var acc = 0.0, n = 0.0
            let lo = max(0, c - half), hi = min(s.count, c + half)
            guard lo < hi else { return 0 }
            for k in lo..<hi { let v = Double(Int16(littleEndian: s[k])) / 32768; acc += v * v; n += 1 }
            return n > 0 ? (acc / n).squareRoot() : 0
        }
    }
}

/// Lag (ms) of `b` behind `a` that maximises normalised cross-correlation, searched ±200 ms on a
/// 5 ms grid (both series linearly resampled from the 40 ms frame grid).
func bestLag(_ a: [Double], _ b: [Double]) -> (Int, Double) {
    let step = 5.0, frameMs = 1000.0 / Double(fps)
    func resample(_ x: [Double]) -> [Double] {
        let n = Int(Double(x.count - 1) * frameMs / step)
        return (0...n).map { k in
            let p = Double(k) * step / frameMs, i = Int(p), f = p - Double(i)
            return i + 1 < x.count ? x[i] * (1 - f) + x[i + 1] * f : x[i]
        }
    }
    func norm(_ x: [Double]) -> [Double] {
        let m = x.reduce(0, +) / Double(x.count)
        let sd = (x.map { ($0 - m) * ($0 - m) }.reduce(0, +) / Double(x.count)).squareRoot()
        return x.map { sd > 0 ? ($0 - m) / sd : 0 }
    }
    let ra = norm(resample(a)), rb = norm(resample(b))
    var best = (0, -Double.infinity)
    for lagSteps in -40...40 {
        var acc = 0.0, n = 0.0
        for i in 0..<ra.count {
            let j = i + lagSteps
            guard j >= 0, j < rb.count else { continue }
            acc += ra[i] * rb[j]; n += 1
        }
        let c = n > 0 ? acc / n : 0
        if c > best.1 { best = (lagSteps * Int(step), c) }
    }
    return best
}

let env = audioEnvelope(count: frameCount)
let (lagOpen, corrOpen) = bestLag(env, openness)
let (lagPix, corrPix) = bestLag(env, mouthMotion)
let size_ = (try? FileManager.default.attributesOfItem(atPath: o.out)[.size] as? Int) ?? 0
print(String(format: "frames: %d (%.2f s at %d fps), size %dx%d", frameCount, Double(frameCount) / Double(fps), fps, o.width, o.height))
print(String(format: "render fps (wall, Core Image only): %.1f · total incl. encode: %.1f", Double(frameCount) / renderSeconds, Double(frameCount) / wallSeconds))
print(String(format: "A/V offset (openness vs audio RMS): %+d ms (r=%.2f)", lagOpen, corrOpen))
print(String(format: "A/V offset (rendered mouth pixels vs audio RMS): %+d ms (r=%.2f)", lagPix, corrPix))
print("mp4: \(o.out) (\(size_ / 1024) KB)")

// MARK: stills

if let dir = o.framesDir {
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let still = FaceRenderer(faceSet: faceSet, outputSize: size, seed: o.seed, reduceMotion: true)
    for v in [LipViseme.MBP, .A, .O, .EI] {
        let lip = LipFrame(weights: [v: 1], openness: v.naturalOpenness)
        guard let cg = still.render(at: 1, lip: lip) else { continue }
        let url = URL(fileURLWithPath: dir).appendingPathComponent("\(o.framesPrefix)-\(v.rawValue).jpg")
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { continue }
        CGImageDestinationAddImage(dest, cg, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        CGImageDestinationFinalize(dest)
        print("still: \(url.path)")
    }
}
