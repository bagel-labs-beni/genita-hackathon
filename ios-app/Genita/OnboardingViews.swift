import SwiftUI
import PhotosUI
import AVFoundation
import UniformTypeIdentifiers

struct RootView: View {
    @Bindable var model: AppState
    var body: some View {
        NavigationStack {
            Group {
                switch model.stage {
                case .welcome: ReferenceWelcomeView { model.go(.signIn) }
                case .signIn: ReferenceSignInView(model: model)
                case .consent: ConsentView(model: model)
                case .name, .prompt, .paste, .preparing, .preferences, .image, .voice, .depth, .help, .relationship, .challenge, .tempo, .initiative, .boundaries, .presence, .summary: ReferenceOnboardingView(model: model)
                case .imageCheck: ImageCheckView(model: model)
                case .companionName: CompanionNameView(model: model)
                case .bringing: BringingView(model: model)
                case .skipTopics, .skipReplies, .skipAvoid: SkipImportView(model: model)
                case .connecting: ConnectingView(model: model)
                case .conversation: ConversationView(model: model)
                }
            }.toolbar(.hidden, for: .navigationBar)
                // F1-L7 / F12: /me picks the first screen (consent, name, onboarding step, or straight to the call)
                .task { await model.routeOnLaunch() }
                .font(TypeStyle.body()).background(Color("Canvas"))
        }.tint(Color("Ink"))
    }
}
/// V04 · device voices (11/2 Meta-only: calls speak with the device's own voices or the Meta voice server).
/// Four en-US voices, best quality first (Premium → Enhanced → default), previewed with AVSpeechSynthesizer.
@MainActor @Observable final class VoicePlayer: NSObject, AVSpeechSynthesizerDelegate {
    var playing: Int?
    private let synthesizer = AVSpeechSynthesizer()
    override init() { super.init(); synthesizer.delegate = self }

    static let choices: [AVSpeechSynthesisVoice] = {
        let all = AVSpeechSynthesisVoice.speechVoices().filter { $0.language == "en-US" }
        let ranked = all.sorted { a, b in
            let q = { (v: AVSpeechSynthesisVoice) in v.quality == .premium ? 0 : v.quality == .enhanced ? 1 : 2 }
            return q(a) != q(b) ? q(a) < q(b) : a.name < b.name
        }
        var seen = Set<String>(), out: [AVSpeechSynthesisVoice] = []
        for v in ranked where !(v.voiceTraits.contains(.isNoveltyVoice)) && seen.insert(v.name).inserted { out.append(v) }
        if out.isEmpty, let v = AVSpeechSynthesisVoice(language: "en-US") { out = [v] }
        return Array(out.prefix(4))
    }()

    static func voice(_ index: Int) -> AVSpeechSynthesisVoice? { choices.isEmpty ? nil : choices[index % choices.count] }
    static func name(_ index: Int) -> String { voice(index)?.name ?? "Voice \(index + 1)" }
    static func detail(_ index: Int) -> String {
        guard let v = voice(index) else { return "On this iPhone" }
        let quality = v.quality == .premium ? "Premium" : v.quality == .enhanced ? "Enhanced" : "Standard"
        let gender = v.gender == .female ? "Female" : v.gender == .male ? "Male" : nil
        return [gender, quality].compactMap { $0 }.joined(separator: ", ")
    }
    /// Where the call's device speech reads the pick (shared/Call device TTS, lane L4).
    static let selectedKey = "genita.voice.device"

    func preview(_ index: Int) {
        if playing == index { stop(); return }
        synthesizer.stopSpeaking(at: .immediate)
        let sample = AVSpeechUtterance(string: "Hi, I’m here. We can take our time, think things through, and find what feels right for you.")
        sample.voice = Self.voice(index) ?? AVSpeechSynthesisVoice(language: "en-US")
        playing = index
        synthesizer.speak(sample)
    }
    func stop() { synthesizer.stopSpeaking(at: .immediate); playing = nil }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { Task { @MainActor in self.playing = nil } }
}
