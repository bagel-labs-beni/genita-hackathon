// L4 face · Live driver for the call screen: feeds the server's reply events into a LipTimeline,
// reads the audio clock, and renders frames off the main thread at the display rate
// (CADisplayLink on iOS, a 30 Hz timer on macOS). The app shows `frame`.
//
// Wiring (CallSession → driver):
//   reply.delta            → handle(replyDelta:)
//   audio + binary kind 1  → handle(audio:pcm:)
//   speaking               → handle(speaking:)
//   expression             → handle(expression:intensity:startMs:endMs:utteranceId:)
//   utterance.cancelled    → cancel(utteranceId:)
//   playbackClock          = { audio.playbackPositionMs(utteranceId: driver.currentUtteranceId ?? -1) }

import CoreGraphics
import Combine
import Foundation
import QuartzCore
import os

@MainActor
public final class FaceDriver: ObservableObject {
    /// The latest rendered frame (outputSize pixels).
    @Published public private(set) var frame: CGImage?
    /// Frames actually shown per second (5 s window), for device QA; also logged as `FACE_FPS live=…`
    /// (subsystem ai.genita, category face) every 5 s while the face animates.
    @Published public private(set) var liveFPS: Double = 0
    private var fpsCount = 0, fpsSince = CACurrentMediaTime()
    private static let log = Logger(subsystem: "ai.genita", category: "face")

    public let timeline = LipTimeline()
    /// Lip lookahead of this face (read once; the renderer itself lives on the render queue).
    private let lookaheadMs: Double
    private let aheadMs: Double
    public private(set) var currentUtteranceId: Int?
    /// Milliseconds of the current utterance heard so far (CallAudio.playbackPositionMs), or nil
    /// when nothing is playing.
    public var playbackClock: () -> Double? = { nil }

    public var reduceMotion: Bool {
        didSet { let r = renderer, v = reduceMotion; queue.async { r.reduceMotion = v } }
    }

    private let renderer: FaceRenderer
    private let queue = DispatchQueue(label: "genita.face.render", qos: .userInteractive)
    private var rendering = false
    private let startedAt = CACurrentMediaTime()
    #if os(iOS)
    private var link: CADisplayLink?
    private var linkTarget: DisplayLinkTarget?
    #else
    private var timer: Timer?
    #endif

    public init(faceSet: FaceSet, outputSize: CGSize, reduceMotion: Bool = false, seed: UInt64 = UInt64.random(in: 1...UInt64.max)) {
        renderer = FaceRenderer(faceSet: faceSet, outputSize: outputSize, seed: seed, reduceMotion: reduceMotion)
        lookaheadMs = renderer.lipLookaheadMs
        aheadMs = renderer.lipAheadMs
        self.reduceMotion = reduceMotion
    }

    /// A renderer built off the main thread (its `FlowMorph` setup is the expensive part; face plan item 5). It must
    /// not be used elsewhere once handed over: from here on it lives on this driver's render queue.
    public init(renderer: FaceRenderer, reduceMotion: Bool) {
        self.renderer = renderer
        lookaheadMs = renderer.lipLookaheadMs
        aheadMs = renderer.lipAheadMs
        self.reduceMotion = reduceMotion
        renderer.reduceMotion = reduceMotion
    }

    // MARK: events

    public func handle(replyDelta d: ServerEvent.ReplyDelta) {
        guard switchUtterance(d.utteranceId) else { return }
        timeline.appendText(d.text)
    }

    public func handle(audio: ServerEvent.Audio, pcm: Data) {
        guard switchUtterance(audio.utteranceId) else { return }
        timeline.append(audio, pcm: pcm)
    }

    /// Server aligner timings for one clause (`audio.timing`: words + ARPAbet phonemes, ms on the
    /// reply's audio clock). They override the spelling pass only where they cover.
    public func handle(timing utteranceId: Int, words: [LipWordTiming], phonemes: [LipPhonemeTiming]) {
        guard switchUtterance(utteranceId) else { return }
        timeline.appendWords(words)
        timeline.appendPhonemes(phonemes)
    }

    public func handle(speaking s: ServerEvent.Speaking) {
        if s.on { guard switchUtterance(s.utteranceId) else { return } }
        // the reply-wide emotion no longer swaps the whole face: the expression stills layer follows the server's
        // per-clause `expression` events instead (deliberate, timed to the words; nothing during plain speech)
        guard !FaceRenderer.expressionStills else { return }
        setEmotion(s.on ? s.emotion : nil)
    }

    /// Barge-in or cancel: the mouth goes to rest at once.
    public func cancel(utteranceId: Int? = nil) {
        guard utteranceId == nil || utteranceId == currentUtteranceId else { return }
        if let id = currentUtteranceId { newestUtteranceId = max(newestUtteranceId ?? id, id + 1) }
        timeline.reset()
        currentUtteranceId = nil
        let r = renderer
        queue.async { r.resetMouth() }
    }

    /// A new realtime session numbers its utterances from 1 again: forget the old ids and rest the
    /// mouth (callers that remap ids across sessions, like the app's CallSession, don't need this).
    public func resetForNewSession() {
        newestUtteranceId = nil
        cancel()
        newestUtteranceId = nil
    }

    /// Server `expression` (per clause, reply audio clock): the expression stills layer (`FaceRenderer.expressionStills`)
    /// and, when on, the warp layer (`FaceRenderer.expressionLayer`).
    public func handle(expression tag: String, intensity: Double, startMs: Int, endMs: Int, utteranceId: Int) {
        guard switchUtterance(utteranceId) else { return }
        let r = renderer, e = FaceExpressionEvent(tag: tag, intensity: intensity, startMs: startMs, endMs: endMs)
        queue.async { r.addExpression(e, utteranceId: utteranceId) }
    }

    public func setEmotion(_ emotion: String?) {
        let r = renderer, t = now()
        queue.async { r.setEmotion(emotion, at: t) }
    }

    /// Utterance ids only grow; events of an older or cancelled reply that arrive late are dropped.
    private var newestUtteranceId: Int?

    /// False when the event belongs to an older or cancelled utterance.
    private func switchUtterance(_ id: Int) -> Bool {
        if id == currentUtteranceId { return true }
        if let newest = newestUtteranceId, id < newest { return false }
        timeline.reset()
        currentUtteranceId = id
        newestUtteranceId = id
        let r = renderer
        queue.async { r.beginUtterance(id) }
        return true
    }

    // MARK: frames

    /// Renders one frame synchronously (tests, snapshots).
    public func renderFrame(at t: Double, playbackMs: Double?) -> CGImage? {
        let lip = playbackMs.map { timeline.sample(atMs: $0) } ?? .rest
        return queue.sync { renderer.render(at: t, lip: lip) }
    }

    private var running: Bool {
        #if os(iOS)
        link != nil
        #else
        timer != nil
        #endif
    }

    public func start() {
        // face plan item 1: the first live frame is the rest frame (the poster / framed scene), then the motion eases in
        if !running { let r = renderer; queue.async { r.restartMotion() } }
        #if os(iOS)
        guard link == nil else { return }
        let target = DisplayLinkTarget { [weak self] in self?.tick() }
        let l = CADisplayLink(target: target, selector: #selector(DisplayLinkTarget.fire))
        l.preferredFrameRateRange = CAFrameRateRange(minimum: 24, maximum: 30, preferred: 30)
        l.add(to: .main, forMode: .common)
        link = l; linkTarget = target
        #else
        guard timer == nil else { return }
        // 24 fps on the Mac (QA 171: the call took 80–90 % CPU at 30). The motion is time-based, so only the
        // number of frames changes; the iPhone keeps its display link at 24–30.
        let t = Timer(timeInterval: 1.0 / 24, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
        #endif
    }

    public func stop() {
        #if os(iOS)
        link?.invalidate(); link = nil; linkTarget = nil
        #else
        timer?.invalidate(); timer = nil
        #endif
    }

    private func now() -> Double { CACurrentMediaTime() - startedAt }

    private func countFrame() {
        fpsCount += 1
        let now = CACurrentMediaTime(), span = now - fpsSince
        guard span >= 5 else { return }
        liveFPS = Double(fpsCount) / span
        Self.log.notice("FACE_FPS live=\(self.liveFPS, format: .fixed(precision: 1), privacy: .public)")
        fpsCount = 0; fpsSince = now
    }

    private func tick() {
        guard !rendering else { return }   // drop a frame rather than queue them up
        rendering = true
        let ms = currentUtteranceId == nil ? nil : playbackClock()
        let lip = ms.map { timeline.sample(atMs: $0 + lookaheadMs) } ?? .rest
        let ahead = aheadMs > 0 ? ms.map { timeline.sample(atMs: $0 + lookaheadMs + aheadMs) } : nil
        let ctx = ms.map { LipContext(audioMs: $0 + lookaheadMs, timeline: timeline) }
        let r = renderer, t = now()
        queue.async { [weak self] in
            let image = r.render(at: t, lip: lip, ahead: ahead, lipContext: ctx)
            DispatchQueue.main.async {
                guard let self else { return }
                self.rendering = false
                if let image { self.frame = image; self.countFrame() }
            }
        }
    }
}

#if os(iOS)
private final class DisplayLinkTarget: NSObject {
    let action: () -> Void
    init(_ action: @escaping () -> Void) { self.action = action }
    @MainActor @objc func fire() { action() }
}
#endif
