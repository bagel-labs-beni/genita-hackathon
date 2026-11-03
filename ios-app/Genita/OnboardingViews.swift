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
                // D47 HISY v2: I03 / N3 → HISY-0 (S0) → cards → HISY-7 (the six I04 rows are still saved)
                case .preferences: HISYView(model: model)
                case .name, .prompt, .paste, .preparing, .image, .voice, .depth, .help, .relationship, .challenge, .tempo, .initiative, .boundaries, .presence, .summary: ReferenceOnboardingView(model: model)
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
/// V04 · the companion voices the server offers (11/2: SeamlessM4T v2 on our GPU, D3). The list, the preview
/// clips and the pick all go through genita-server; the phone's own voices are only the silent offline fallback
/// for calls (`deviceFallbackKey`) and never show here.
@MainActor @Observable final class VoicePlayer: NSObject, AVAudioPlayerDelegate {
    var voices: [OnboardingClient.CompanionVoice] = []
    /// the voice service answers; false greys the list ("Voice preview is waking up") and Continue takes the default
    var available = false
    var loading = true
    /// the voice whose preview is playing / being fetched
    var playing: String?
    var fetching: String?
    private var audio: AVAudioPlayer?
    private var cache: [String: Data] = [:]
    private var task: Task<Void, Never>?
    private var endTimer: Task<Void, Never>?
    private var generation = 0

    /// Where a call's device speech reads the silent fallback voice (shared/Call device TTS, lane L4).
    static let deviceFallbackKey = "genita.voice.device"

    /// The best installed en-US voice, never shown, only for a call the server can't voice.
    static var deviceFallbackID: String? {
        let ranked = AVSpeechSynthesisVoice.speechVoices().filter { $0.language == "en-US" && !$0.voiceTraits.contains(.isNoveltyVoice) }
            .sorted { ($0.quality.rawValue, $0.name) > ($1.quality.rawValue, $1.name) }
        return (ranked.first ?? AVSpeechSynthesisVoice(language: "en-US"))?.identifier
    }

    /// What V04 shows when the server can't be reached at all: the same curated four per look (greyed).
    static func fallback(kind: String?) -> [OnboardingClient.CompanionVoice] {
        func v(_ id: String, _ name: String, _ blurb: String) -> OnboardingClient.CompanionVoice { .init(id: id, name: name, blurb: blurb) }
        switch kind {
        case "animal": return [v("16", "Pip", "Cheery, light"), v("22", "Mochi", "Soft, gentle"), v("34", "Juno", "Lively, bright"), v("80", "Rue", "Mellow, easy")]
        case "character": return [v("68", "Nova", "Bright, clear"), v("64", "Ivy", "Sparkly, light"), v("44", "Wren", "Dreamy, soft"), v("0", "Coco", "Playful, quick")]
        default: return [v("72", "Tara", "Warm, bright"), v("120", "Leah", "Soft, steady"), v("36", "Leo", "Calm, low"), v("24", "Dan", "Easygoing")]
        }
    }

    func load(client: OnboardingClient, imageId: String?, kind: String?) async {
        loading = true
        defer { loading = false }
        do {
            let r = try await client.voices(imageId: imageId)
            guard !r.voices.isEmpty else { throw GenitaAuthError.badResponse }
            voices = Array(r.voices.prefix(4))
            available = r.available ?? true
        } catch {
            voices = Self.fallback(kind: kind)
            available = false
        }
    }

    /// A quiet re-ask while the voice service wakes: only a good answer changes the list (keeps the pick's row).
    func refresh(client: OnboardingClient, imageId: String?) async {
        guard let r = try? await client.voices(imageId: imageId), r.available ?? true, !r.voices.isEmpty else { return }
        voices = Array(r.voices.prefix(4))
        available = true
    }

    /// Play (or stop) one clip. A 503 / offline turns the list grey instead of showing an error.
    func preview(_ voice: OnboardingClient.CompanionVoice, client: OnboardingClient) {
        if playing == voice.id || fetching == voice.id { stop(); return }
        stop()
        fetching = voice.id
        task = Task {
            do {
                let data: Data
                if let hit = cache[voice.id] { data = hit } else { data = try await client.voicePreview(id: voice.id); cache[voice.id] = data }
                guard !Task.isCancelled, fetching == voice.id else { return }
                try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
                try? AVAudioSession.sharedInstance().setActive(true)
                let p = try AVAudioPlayer(data: data)
                p.delegate = self
                // UI tests run on a simulator with no audio route: play() can say no there, the clip length still drives the state
                guard p.play() || ProcessInfo.processInfo.arguments.contains("--uitesting") else { fetching = nil; available = false; return }
                audio = p
                fetching = nil
                playing = voice.id
                generation += 1
                let mine = generation, seconds = p.duration + 0.3
                // the delegate can miss on a device with no audio route; the clip's own length ends "Playing" too
                endTimer = Task { try? await Task.sleep(for: .seconds(seconds)); if generation == mine { playing = nil } }
            } catch {
                if Task.isCancelled { return }
                fetching = nil
                available = false
            }
        }
    }
    func stop() { generation += 1; endTimer?.cancel(); task?.cancel(); task = nil; audio?.stop(); audio = nil; playing = nil; fetching = nil }
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) { Task { @MainActor in if self.audio === player { self.playing = nil } } }
}
