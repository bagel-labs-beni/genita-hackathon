import AVFoundation
import SwiftUI
import UIKit

// F4-U-S09 · Call screen pieces: the face, the one-line status, the More sheet.
// Values are from the full-flow board r01 §5 (S09) and §7 (MORE-B2).

enum CallInk {
    static let ink = Color(red: 17 / 255, green: 17 / 255, blue: 17 / 255)
    static let onInk = Color(red: 253 / 255, green: 253 / 255, blue: 253 / 255)
    static let pill = Color(red: 17 / 255, green: 17 / 255, blue: 17 / 255).opacity(0.84)
    static let blueOnInk = Color(red: 84 / 255, green: 193 / 255, blue: 1)
    static let mute = Color(red: 115 / 255, green: 115 / 255, blue: 115 / 255)
    static let handle = Color(red: 219 / 255, green: 219 / 255, blue: 219 / 255)
    static let sheet = Color(red: 254 / 255, green: 254 / 255, blue: 254 / 255)
    static let field = Color(red: 241 / 255, green: 241 / 255, blue: 241 / 255)
    static let dim = Color(red: 17 / 255, green: 17 / 255, blue: 17 / 255).opacity(0.46)
}

/// Reduce Motion stops the wave and spinner (board: `animation:none`). Debug UI tests set
/// GENITA_REVIEW_STILL=1 for the same, plus a still face, so XCUITest sees an idle app and can catch
/// short states like S09-X.
enum CallMotion {
    static var reviewStill: Bool {
        #if DEBUG
        ProcessInfo.processInfo.environment["GENITA_REVIEW_STILL"] == "1"
        #else
        false
        #endif
    }
}

// MARK: - Face

/// Where the moving mouth comes from. Only `.none` exists today: the silent loop plays as is.
/// Atlas mouth playback draws in
/// `LipLayer`, above the base video and below the controls.
enum LipSource: Equatable { case none }

struct CompanionFaceView: View {
    let still: Image
    /// Silent loop of this companion (Dyno's clip for the demo face). Plays only with GENITA_CLIP_LOOP_FACE=1.
    let loop: URL?
    /// L4: the animated Meta face from the companion's prep face set, drawn above the still. nil → the still.
    var face: FaceDriver? = nil
    /// The face's one review frame under GENITA_REVIEW_STILL (CallController.faceStill).
    var faceStill: CGImage? = nil
    var lip: LipSource = .none
    var body: some View {
        ZStack {
            still.resizable().scaledToFill()
            if let face {
                FaceFrameView(driver: face, still: faceStill)
            } else if let loop, CompanionFace.clipLoopFace, !CallMotion.reviewStill {
                LoopingVideo(url: loop).allowsHitTesting(false)
            }
            LipLayer(source: lip).allowsHitTesting(false)
        }
    }
}

struct LipLayer: View {
    let source: LipSource
    var body: some View {
        switch source {
        case .none: Color.clear
        }
    }
}

/// Muted, looping, aspect-fill video. It never touches the call's audio.
struct LoopingVideo: UIViewRepresentable {
    let url: URL
    func makeUIView(context: Context) -> LoopingVideoView { LoopingVideoView(url: url) }
    func updateUIView(_ view: LoopingVideoView, context: Context) {}
}

final class LoopingVideoView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    private let player = AVQueuePlayer()
    private var looper: AVPlayerLooper?
    init(url: URL) {
        super.init(frame: .zero)
        let layer = self.layer as! AVPlayerLayer
        layer.videoGravity = .resizeAspectFill
        layer.player = player
        player.isMuted = true
        player.preventsDisplaySleepDuringVideoPlayback = true
        player.audiovisualBackgroundPlaybackPolicy = .pauses
        looper = AVPlayerLooper(player: player, templateItem: AVPlayerItem(url: url))
        player.play()
        backgroundColor = .clear
        isUserInteractionEnabled = false
    }
    required init?(coder: NSCoder) { fatalError() }
}

// MARK: - Status line

struct CallCueView: View {
    let cue: CallCue
    let name: String
    /// PF-1: a Finds status line ("On it…", "Found two for you.") shown in the same pill instead of the call cue
    var findsText: String? = nil
    var retry: () -> Void = {}
    var openSettings: () -> Void = {}
    var body: some View {
        if let content {
            HStack(spacing: 8) {
                content.icon
                // the push runs inside the line's own box: the old words leave and the new ones rise within the pill,
                // never drawn above or below it (a mid-change capture showed three lines stacked, UI sweep 11/3)
                ZStack {
                    Text(content.text).font(TypeStyle.body(14, .medium)).foregroundStyle(CallInk.onInk).lineLimit(1).fixedSize()
                        .genitaStatusLine(content.text) // catalog: words push up from below, pill width follows
                }.clipped()
                if let action = content.action {
                    Button(action: action.run) {
                        Text(action.title).font(TypeStyle.body(14, .medium)).foregroundStyle(CallInk.blueOnInk).padding(.horizontal, 8).frame(minHeight: 44).contentShape(Rectangle())
                    }.buttonStyle(.plain).padding(.vertical, -4).padding(.trailing, -8).accessibilityIdentifier("cueAction")
                }
            }
            .padding(.leading, 16).padding(.trailing, content.action == nil ? 16 : 8).padding(.vertical, 8)
            .frame(minHeight: 36)
            .background(CallInk.pill, in: RoundedRectangle(cornerRadius: 18))
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.updatesFrequently)
            .accessibilityIdentifier("callCue")
            .animation(CallMotion.reviewStill ? nil : .spring(duration: 0.3, bounce: 0), value: content.text)
            // One line swaps in place: a crossfade overlaps two texts in the pill.
        }
    }

    private struct Content { let icon: AnyView; let text: String; let action: (title: String, run: () -> Void)? }
    private var content: Content? {
        if let findsText, cue != .reconnecting, cue != .answerFailed { return Content(icon: AnyView(CueWave()), text: findsText, action: nil) }
        return switch cue {
        case .none: nil
        case .listening: Content(icon: AnyView(CueDot()), text: "Listening", action: nil)
        case .thinking: Content(icon: AnyView(CueSpinner()), text: "\(name) is thinking", action: nil)
        case .speaking: Content(icon: AnyView(CueWave()), text: "\(name) is talking", action: nil)
        case .interrupted: Content(icon: AnyView(CueDot()), text: "Stopped. Go ahead.", action: nil)
        case .reconnecting: Content(icon: AnyView(CueSpinner()), text: "Reconnecting…", action: nil)
        case .answerFailed: Content(icon: AnyView(CueAlert()), text: "Couldn’t get an answer.", action: ("Try again", retry))
        case .micBlocked: Content(icon: AnyView(CueAlert()), text: "Microphone is off for Genita.", action: ("Settings", openSettings))
        }
    }
}

/// CC-1 "Updated: no cilantro" / "Noted: quiet company" for 2.5 s (`profile.updated`), and the softer GK-1
/// "Getting to know you · {topic}" (`profile.asking`). The status line's pill, smaller, just under it.
struct ProfileChipView: View {
    let text: String
    /// GK-1: lighter pill, a "?" instead of the check
    var soft = false
    @State private var shown = false
    var body: some View {
        HStack(spacing: 6) {
            if soft {
                Image("hisy-question").resizable().renderingMode(.template).foregroundStyle(CallInk.blueOnInk).frame(width: 13, height: 13)
            } else {
                Image(systemName: "checkmark").font(.system(size: 12, weight: .bold)).foregroundStyle(CallInk.blueOnInk)
            }
            Text(text).font(TypeStyle.body(13, .medium)).foregroundStyle(CallInk.onInk.opacity(soft ? 0.92 : 1)).lineLimit(1)
        }
        .padding(.horizontal, 14).frame(height: 30)
        .background(soft ? CallInk.ink.opacity(0.5) : CallInk.pill, in: RoundedRectangle(cornerRadius: 15))
        .opacity(shown ? 1 : 0).offset(y: shown ? 0 : -6)
        .onAppear { withAnimation(.fade) { shown = true } }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(soft ? "askingChip" : "profileChip")
    }
}

private struct CueDot: View {
    var body: some View { Circle().fill(CallInk.blueOnInk).frame(width: 8, height: 8) }
}

struct CueAlert: View {
    var body: some View { Image(systemName: "exclamationmark.circle").font(.system(size: 17, weight: .semibold)).foregroundStyle(CallInk.onInk).frame(width: 20, height: 20) }
}

struct CueSpinner: View {
    @State private var turn = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        Circle().stroke(CallInk.onInk.opacity(0.32), lineWidth: 2)
            .overlay(Circle().trim(from: 0, to: 0.25).stroke(CallInk.onInk, style: StrokeStyle(lineWidth: 2, lineCap: .round)).rotationEffect(.degrees(turn ? 360 : 0)))
            .frame(width: 16, height: 16)
            .onAppear { if !reduceMotion && !CallMotion.reviewStill { withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) { turn = true } } }
    }
}

/// Four bars, 2 × 12 pt, moving while the companion's voice plays.
private struct CueWave: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        TimelineView(.animation(paused: reduceMotion || CallMotion.reviewStill)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: 2) {
                ForEach(0..<4, id: \.self) { i in
                    let phase = (t * 1000 + [0, 200, 450, 650][i]).truncatingRemainder(dividingBy: 900) / 900
                    RoundedRectangle(cornerRadius: 1).fill(CallInk.blueOnInk).frame(width: 2, height: 12 * (0.35 + 0.65 * abs(sin(phase * .pi))))
                }
            }.frame(height: 20)
        }
    }
}

// MARK: - Rail toggle

/// Camera and mic buttons: glass when off, white with a dark icon when on (board `.glass[aria-pressed=true]`).
struct CallToggleGlass: View {
    let icon: String
    let on: Bool
    var body: some View {
        ZStack {
            CallGlassControl(icon: icon, size: 46)
            if on {
                Circle().fill(CallInk.onInk)
                if let url = Bundle.main.url(forResource: icon, withExtension: "png"), let image = UIImage(contentsOfFile: url.path) {
                    Image(uiImage: image).resizable().colorInvert().frame(width: image.size.width / 4, height: image.size.height / 4)
                }
            }
        }.frame(width: 46, height: 46).contentShape(Circle())
    }
}

struct SelfCameraView: UIViewRepresentable {
    let session: AVCaptureSession
    func makeUIView(context: Context) -> SelfCameraSurface {
        let view = SelfCameraSurface()
        view.preview.session = session
        view.preview.videoGravity = .resizeAspectFill
        return view
    }
    func updateUIView(_ view: SelfCameraSurface, context: Context) {}
}

final class SelfCameraSurface: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
}

// MARK: - More sheet (MORE-B2)

struct CallMoreSheet: View {
    let call: CallController
    var textChatEnabled: Bool
    var moveToMacSubtitle: String
    var moveToMac: () -> Void
    /// S08 and the F10 Finds sheet are separate tickets; their rows stay disabled until wired.
    var openTextChat: (() -> Void)?
    var openFinds: (() -> Void)?
    /// RP-1 (D37): the system report sheet
    var report: (() -> Void)?
    var close: () -> Void
    var body: some View {
        VStack(spacing: 0) {
            Capsule().fill(CallInk.handle).frame(width: 47, height: 5).padding(.bottom, 24)
            row("globe", "Interpret a conversation", call.mode == .interpret ? call.interpretBoard.moreSubtitle : "For talking across languages", id: "moreInterpret", toggle: call.mode == .interpret) {
                // INT-0: switching on closes the sheet and shows INT-1
                let on = call.mode != .interpret
                call.setInterpreting(on)
                if on { close() }
            }
            if textChatEnabled {
                row("text.bubble", "Text chat", "Same conversation, in writing", id: "moreTextChat", enabled: openTextChat != nil) { close(); openTextChat?() }
            }
            let n = max(call.finds.cardCount, call.findsCount)
            row("bookmark", "Finds", n == 0 ? "Nothing looked up yet" : n == 1 ? "1 thing I looked up" : "\(n) things I looked up", id: "moreFinds", enabled: openFinds != nil) { close(); openFinds?() }
            row("camera", "Flip camera", call.cameraOn ? "Switch front and back" : "Turn your camera on first", id: "moreFlip", enabled: call.canFlipCamera) { call.flipCamera() }
            row("laptopcomputer", "Move to Mac", moveToMacSubtitle, id: "moreMoveToMac") { close(); moveToMac() }
            if let report { row("flag", "Report", "A reply or picture that's wrong", id: "moreReport") { close(); report() } }
        }
        .padding(.top, 28).padding(.horizontal, 16).padding(.bottom, 40)
        .frame(maxWidth: .infinity)
        .background(CallInk.sheet, in: UnevenRoundedRectangle(topLeadingRadius: 30, topTrailingRadius: 30))
        .shadow(color: CallInk.ink.opacity(0.18), radius: 12)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("More")
        .accessibilityIdentifier("moreSheet")
    }

    private func row(_ symbol: String, _ title: String, _ subtitle: String, id: String, enabled: Bool = true, toggle: Bool? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 16) {
                Image(systemName: symbol).font(.system(size: 17, weight: .medium)).foregroundStyle(enabled ? CallInk.ink : CallInk.handle).frame(width: 20, height: 20)
                VStack(alignment: .leading, spacing: 0) {
                    Text(title).font(TypeStyle.body(16, .medium)).foregroundStyle(enabled ? CallInk.ink : CallInk.mute)
                    Text(subtitle).font(TypeStyle.body(14)).foregroundStyle(CallInk.mute)
                }.frame(maxWidth: .infinity, alignment: .leading)
                if let toggle { CallSwitch(on: toggle) }
            }
            .padding(.horizontal, 16).padding(.vertical, 8).frame(minHeight: 60).contentShape(Rectangle())
        }
        .buttonStyle(MoreRowStyle())
        .disabled(!enabled)
        .accessibilityIdentifier(id)
        .accessibilityValue(toggle.map { $0 ? "On" : "Off" } ?? "")
        .accessibilityHint(enabled ? "" : subtitle)
    }
}

private struct MoreRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.background(configuration.isPressed ? CallInk.field : .clear, in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct CallSwitch: View {
    let on: Bool
    var body: some View {
        Capsule().fill(on ? CallInk.ink : CallInk.handle).frame(width: 52, height: 32)
            .overlay(alignment: on ? .trailing : .leading) { Circle().fill(.white).frame(width: 28, height: 28).shadow(color: CallInk.ink.opacity(0.18), radius: 2, y: 2).padding(2) }
            .animation(.easeOut(duration: 0.18), value: on)
    }
}

// MARK: - Wiring

extension AppState {
    /// The silent loop only matches the bundled demo face. A user's own photo stays a still (S09-P)
    /// until its own silent video exists (F2-L9).
    var companionLoopURL: URL? {
        guard let loop = Bundle.main.url(forResource: "companion-silent", withExtension: "mp4") else { return nil }
        guard let mine = setup.imageData else { return loop }
        guard let bundled = Bundle.main.url(forResource: "companion", withExtension: "png"), let demo = try? Data(contentsOf: bundled) else { return nil }
        return mine == demo ? loop : nil
    }

    /// The server's persona card (setup answers, F4) when there is one, always with the NM01 name; the imported
    /// style's profile text (never the raw paste once the import ran); 2 s wait on the first call (D21).
    var callStart: ClientMessage.Start {
        var start = ClientMessage.Start.companion(name: companionDisplayName, userName: setup.name, profile: setup.styleProfile ?? setup.response,
                                                  traits: setup.presence.sorted(), voiceId: nil)
        if var persona = setup.serverPersona { persona.name = companionDisplayName; start.persona = persona }
        if let kind = setup.imageType.flatMap(ClientMessage.Persona.Kind.init(rawValue:)) { start.persona.kind = kind }
        start.greetAfterMs = setup.firstCallPending == true ? 2000 : nil
        return start
    }
}
