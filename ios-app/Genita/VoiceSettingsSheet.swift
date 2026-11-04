import SwiftUI

/// One V04 voice card (Figma F2 "voice model"): white card, black ring when picked or playing, a black round play
/// button that turns into pause while the clip plays. Shared by onboarding V04 and Settings → Voice (11/4).
struct VoiceCardView: View {
    let voice: OnboardingClient.CompanionVoice
    let index: Int
    let picked: Bool
    let playing: Bool
    let fetching: Bool
    let waking: Bool
    let onSelect: () -> Void
    let onPlay: () -> Void

    var body: some View {
        let detail = playing ? "Playing · \(voice.blurb)" : picked ? "Selected · \(voice.blurb)" : voice.blurb
        let detailColor = playing ? Color(red: 0, green: 99.0 / 255, blue: 159.0 / 255) : Palette.secondary // D1: picked and idle both #737373
        return ZStack {
            RoundedRectangle(cornerRadius: 12).fill(.white)
                // Figma voice.json: 1 pt #E3E3E3 edge (white card on #FDFDFD had no visible edge on device, design review 11/4)
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(picked || playing ? Color("Ink") : Color(red: 0xE3 / 255, green: 0xE3 / 255, blue: 0xE3 / 255), lineWidth: picked || playing ? 1.5 : 1))
            Button(action: onSelect) { Color.clear.contentShape(Rectangle()) }.disabled(waking)
                .accessibilityLabel("\(voice.name), \(detail)").accessibilityAddTraits(picked ? .isSelected : []).accessibilityIdentifier("voice\(index)")
            VStack(alignment: .leading, spacing: 4) {
                Text(voice.name).font(.custom("PretendardVariable-SemiBold", fixedSize: 18)).foregroundStyle(Color("Ink"))
                Text(detail).font(.custom("PretendardVariable-Medium", fixedSize: 12)).foregroundStyle(detailColor)
            }.padding(.leading, 21).padding(.top, 13).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).allowsHitTesting(false)
            Button(action: onPlay) {
                ZStack {
                    Circle().fill(Color("Ink")).frame(width: 32, height: 32)
                    if playing { HStack(spacing: 4) { RoundedRectangle(cornerRadius: 1).frame(width: 3, height: 11); RoundedRectangle(cornerRadius: 1).frame(width: 3, height: 11) }.foregroundStyle(.white) }
                    else if fetching { ProgressView().controlSize(.small).tint(.white) }
                    else { Image(systemName: "play.fill").font(.system(size: 11)).foregroundStyle(.white).offset(x: 1) }
                }.frame(width: 44, height: 44)
            }.disabled(waking).opacity(waking ? 0.3 : 1)   // SY-06: waking dims only the play button; names and #737373 lines stay readable
                .accessibilityLabel(playing ? "Stop \(voice.name)" : "Play \(voice.name)").accessibilityIdentifier("play\(index)")
                .frame(maxWidth: .infinity, alignment: .trailing).padding(.trailing, 14)
        }.buttonStyle(.plain)
    }
}

/// Settings → Your companion → Voice (11/4, build 10): the V04 list as a sheet, so a companion made with the wrong
/// voice (every one before 11/4 got Tara) can change it. Same cards, previews and face order as V04; Save goes
/// through PUT /v1/companion/voice, and the server's saved voice is what the next call uses on iPhone and Mac.
struct VoiceSettingsSheet: View {
    @Bindable var model: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var player = VoicePlayer()
    @State private var pick: String?
    @State private var saving = false
    @State private var failed = false

    /// the cards V04 shows (greyed curated four until the server answers)
    private var list: [OnboardingClient.CompanionVoice] { player.voices.isEmpty ? VoicePlayer.fallback(kind: model.setup.imageType) : player.voices }
    private var waking: Bool { !player.loading && !player.available }
    /// a call is on under this sheet: the clip plays on the call's audio session and the mic rests while it plays
    private var inCall: Bool { CallController.shared.link != .idle }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 8) {
                        Text(waking ? "Voice preview is waking up" : "Tap play to hear each one.")
                            .font(.custom("PretendardVariable-Regular", fixedSize: 14)).foregroundStyle(Color(white: 0.45))
                            .accessibilityIdentifier(waking ? "voiceWaking" : "voiceHint")
                        if waking { ProgressView().controlSize(.small).tint(Color(white: 0.45)) }
                    }.padding(.bottom, 4)
                    ForEach(Array(list.enumerated()), id: \.element.id) { i, v in
                        VoiceCardView(voice: v, index: i, picked: pick == v.id, playing: player.playing == v.id, fetching: player.fetching == v.id,
                                      waking: waking || player.loading || saving,
                                      onSelect: { player.stop(); pick = v.id },
                                      onPlay: { pick = v.id; player.preview(v, client: model.onboarding, keepSession: inCall) })
                            .frame(height: 68)
                    }
                    if failed {
                        Text("Couldn't save the voice. Try again.").font(.custom("PretendardVariable-Regular", fixedSize: 14))
                            .foregroundStyle(Color(red: 0.8, green: 0.2, blue: 0.2)).accessibilityIdentifier("voiceSaveFailed")
                    }
                }.padding(.horizontal, 24).padding(.top, 12)
            }
            .background(Color("Canvas"))
            .navigationTitle("Voice")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { player.stop(); dismiss() }.disabled(saving).accessibilityIdentifier("voiceCancel") }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save") { Task { await save() } }
                        .disabled(saving || pick == nil || player.voices.isEmpty).accessibilityIdentifier("voiceSave")
                }
            }
        }
        .interactiveDismissDisabled(saving)
        .task {
            await player.load(client: model.onboarding, imageId: model.setup.imageId, kind: model.setup.imageType)
            pick = model.setup.voiceId.flatMap { id in player.voices.first { $0.id == id }?.id } ?? player.voices.first?.id
        }
        // the clip is not in the call's echo-canceller reference: the call mic rests while it plays (the user's toggle is kept)
        .onChange(of: player.playing != nil || player.fetching != nil) { _, previewing in
            if inCall { CallController.shared.holdMicForPreview(previewing) }
        }
        .onDisappear { player.stop(); CallController.shared.holdMicForPreview(false) }
    }

    func save() async {
        guard let id = pick else { return }
        player.stop()
        if id == model.setup.voiceId { dismiss(); return }
        saving = true; failed = false
        defer { saving = false }
        let account = model.setup.accountId
        do {
            _ = try await model.onboarding.saveVoice(id)
            // the answer belongs to the account that asked (a sign-out in between must not touch the next one, Codex P2)
            guard model.setup.accountId == account else { return }
            model.setup.voiceId = id
            model.setup.voiceName = player.voices.first { $0.id == id }?.name ?? CuratedVoices.name(id)
            model.setup.voice = player.voices.firstIndex { $0.id == id }
            dismiss()
        } catch {
            failed = true
        }
    }
}
