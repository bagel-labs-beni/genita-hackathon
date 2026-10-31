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
                case .name, .prompt, .paste, .preparing, .preferences, .image, .voice, .depth, .help, .relationship, .challenge, .tempo, .initiative, .boundaries, .presence, .summary: ReferenceOnboardingView(model: model)
                case .connecting: ConnectingView(model: model)
                case .conversation: ConversationView(model: model)
                }
            }.toolbar(.hidden, for: .navigationBar)
                .font(TypeStyle.body()).background(Color("Canvas"))
        }.tint(Color("Ink"))
    }
}
@MainActor @Observable final class VoicePlayer: NSObject, AVSpeechSynthesizerDelegate {
    var playing: Int?
    private let synthesizer = AVSpeechSynthesizer()
    override init() { super.init(); synthesizer.delegate = self }
    func preview(_ index: Int) {
        if playing == index { stop(); return }
        synthesizer.stopSpeaking(at: .immediate)
        let sample = AVSpeechUtterance(string: "Hi, I’m here. We can take our time, think things through, and find what feels right for you.")
        let voices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("en-US") }
        sample.voice = voices.isEmpty ? AVSpeechSynthesisVoice(language: "en-US") : voices[index % voices.count]
        sample.rate = [0.46, 0.50, 0.43, 0.48][index]
        playing = index
        synthesizer.speak(sample)
    }
    func stop() { synthesizer.stopSpeaking(at: .immediate); playing = nil }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { Task { @MainActor in self.playing = nil } }
}
