import AppKit
import CoreGraphics
import Observation

/// F8-L4 · Mac call interpretation (INT-M0 → INT-M1/M2).
///
/// ⋮ → Interpret a call → pick FaceTime or Zoom → Start: the live session switches to
/// interpret with `source: call`; ScreenCaptureKit sends the call app's sound (frame kind 4,
/// always "them"); the mic only counts while "Hold to reply" is down. Their words come back
/// as a quiet whisper on the system output (the user's headphones); the user's reply is spoken
/// in the other language through the Mac's built-in speakers, where the call app's mic hears it.
///
/// Known limit (checked 11/2): the call app keeps its own mic open, so the other person also
/// hears the user's own voice before Genita's translation. See mac-app/README.md.
@MainActor @Observable final class MacInterpretController {
    enum Stage: Equatable { case idle, picking, starting, live, failed(String) }

    var stage: Stage = .idle
    var app: MacInterpretCallSheet.CallApp = .faceTime
    var running: Set<MacInterpretCallSheet.CallApp> = []
    var headphones = InterpretAudioOutput.headphonesLikely

    @ObservationIgnored private let call = CallController.shared
    @ObservationIgnored private let capture = CallSoundCapture()
    @ObservationIgnored private var output: InterpretAudioOutput?
    @ObservationIgnored private var startedCall = false

    var isLive: Bool { stage == .live || stage == .starting }

    /// INT-M0: show the sheet; preselect a call app that is already running.
    func open() {
        stage = .picking
        headphones = InterpretAudioOutput.headphonesLikely
        Task {
            let names = await CallSoundCapture.runningApps()
            running = Set(names.compactMap(MacInterpretCallSheet.CallApp.init(rawValue:)))
            if let first = running.first, !running.contains(app) { app = first }
        }
    }

    func cancel() { if stage == .picking { stage = .idle } }

    func start(_ base: ClientMessage.Start) {
        guard CallSoundCapture.permitted else {
            CGRequestScreenCaptureAccess()
            stage = .failed("Allow Genita under Screen Recording in System Settings, then try again. It’s how I hear the call.")
            return
        }
        stage = .starting
        let options = InterpretOptions(source: .call, app: app.rawValue)
        let out = InterpretAudioOutput()
        output = out
        call.routeInterpretAudio = { pcm, route, _ in out.play(pcm, to: route == .speaker ? .speaker : .whisper) }
        call.flushRoutedAudio = { out.flush() }
        if call.link == .idle {
            var s = base
            s.mode = .interpret
            s.interpret = options
            call.begin(s)
            startedCall = true
        }
        call.setInterpreting(true, options: options)
        let sink = call.callSoundSink
        capture.onPCM = { sink($0) }
        capture.onStop = { [weak self] error in
            Task { @MainActor in
                guard let self, self.isLive else { return }
                self.stop()
                self.stage = .failed(error?.localizedDescription ?? "The call’s sound stopped.")
            }
        }
        let app = app.rawValue
        Task {
            do {
                try await capture.start(app: app)
                if stage == .starting { stage = .live }
            } catch {
                stop()
                stage = .failed(error.localizedDescription)
            }
        }
    }

    func stop() {
        capture.onStop = nil
        capture.stop()
        call.setHold(false)
        call.setInterpreting(false)
        call.routeInterpretAudio = nil
        call.flushRoutedAudio = nil
        output?.stop()
        output = nil
        if startedCall { call.end() }
        startedCall = false
        stage = .idle
    }
}
