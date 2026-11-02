# Genita · Mac app

Native macOS hackathon app. Sources are in `GenitaMac/`; the shared Xcode project is [`../ios-app/Genita.xcodeproj`](../ios-app/Genita.xcodeproj).

Open that project and choose the **GenitaMac** target. Requires Xcode 26, macOS 15+; native glass is used on macOS 26+.

```sh
cd ios-app
xcodebuild -project Genita.xcodeproj -target GenitaMac -configuration Debug -sdk macosx CODE_SIGNING_ALLOWED=NO
```

Run these commands from the repository root. Output: `ios-app/build/Debug/GenitaMac.app`. Choose a signing team for device distribution.

Fonts, original Figma imagery, `AppState` and settings are shared with `ios-app`. The native window includes the requested Figma 9:41 time, status icons and Dynamic Island, glass controls, menu, settings, screen-sharing permission UI, system content picker and local SCStream capture. Screen frames are neither stored nor sent to AI.

Cross-device account/session synchronization, Muse Spark and live lip-sync are still pending. The debug sharing preview renders the active design without recording the screen.

## Native iPhone handoff

The Mac app opens a pairing/control window showing a six-digit code. It is only for the first pairing; the iPhone reconnects by itself after that. **The actual conversation does not exist yet**: there is no server, voice, video or conversation sync, and handoff moves only which device presents the conversation screen. Ownership is decided in `shared/Handoff/ConversationOwnership.swift`, where the newest claim wins.

The conversation arrives in a separate transparent floating window over the real desktop, either from the iPhone's **Move to Mac** button or, after registering the screen once, by bringing a LiDAR iPhone to a display edge. No browser or separately running server is required.

This window never closes because of the iPhone. If the iPhone goes to the background, locks or disappears while the conversation is on the Mac, nothing changes here. When the conversation goes to the iPhone, the window stays as the R2 waiting sheet. If the iPhone can't be reached in that state it shows R2-E. **Continue here** takes the conversation back in one tap, with no edge condition and with or without the iPhone. Quitting the Mac app shows R1-E on the iPhone.

Only the Mac that has the conversation shows the screen-sharing control. When the conversation leaves, SCStream stops at once and does not resume by itself; R2 says "Screen sharing stopped." only if sharing was on. Capture stays local; there is no remote screen-frame transport. The iPhone never exposes a screen-sharing control.

The camera and microphone buttons work locally, with permission requests, a self preview and the E01 and E02 denied sheets. Both stop when the conversation leaves. Nothing is stored or sent. The ⋮ button has no action yet.

The control window also has **Move to iPhone**, which asks the iPhone to claim the conversation when it is reachable.

A local diagnostic snapshot is stored at `~/Library/Application Support/Genita/Handoff/state.json` (connection/coordinate/state metadata, not images). It includes the current pairing code and should not be published. This is a development integration; multi-display changes require registering the selected display again. Do not move the Mac after registering its plane.

Validation commands:
- `swiftc shared/Handoff/HandoffGeometry.swift tests/native-handoff/main.swift -o /tmp/genita-handoff-geometry-test && /tmp/genita-handoff-geometry-test` (from repository root)
- iOS device build: `xcodebuild -project ios-app/Genita.xcodeproj -scheme Genita -destination 'generic/platform=iOS' -derivedDataPath build/native-handoff DEVELOPMENT_TEAM=<your-team> -allowProvisioningUpdates`
- Mac build remains the command above. The native integration sources and bundled effect are included in this repository.

The native WebKit rendering smoke test exercises actual framebuffer pixels (visible sender, transparent exit, transparent receiver start, visible receiver completion), rather than treating an elapsed animation timer as success:

```sh
swiftc tests/native-handoff/EffectSmoke.swift -o /tmp/genita-effect-smoke
/tmp/genita-effect-smoke "$PWD/shared/Handoff/handoff-effect.html" "$PWD/ios-app/Genita/Resources/companion.png"
```

Run it from repository root. It briefly opens a test-only render window and exits. The first native integration revealed two rendering defects: an implicit HTML body was absent at initialization, and payload texture dimensions were unset. Both are covered by the framebuffer test. The installed iOS and Mac resources are built from the same effect bundle.

### Window dragging and first-frame continuity

After arrival, drag the black island at the top of the conversation to move the native window. The position timer leaves a settled window alone. A move by button rests at the right of the screen.

The native conversation stays visible until WebGL reports the first rendered frame for the current transition ID. Cancellation/stale IDs cannot hide the current conversation. The framebuffer smoke test also requires this rendered-frame acknowledgment. Handoff no longer changes AVAudioSession category/routing: a future live conversation must own that audio session. Live media continuity itself is not implemented by this prototype.

The current checks cover builds, ownership logic, geometry and native WebGL rendering; they do not establish physical tracking accuracy, end-to-end hardware pairing reliability or live call continuity. Full profile/preferences/session synchronization remains separate from this local visual handoff.

## Call interpretation (F8-L4, INT-M0~M2) — cut for the hackathon build (D40)

`MacInterpretController.enabled = false`: the ⋮ control is the disabled "More" again and the sheet never opens. iPhone face-to-face interpretation is not affected. The code below stays for later.

⋮ (More) → **Interpret a call** → pick FaceTime or Zoom → **Start interpreting**. Code: `GenitaMac/Interpret/`.

- **Their words → your headphones.** `CallSoundCapture` takes the call app's sound with ScreenCaptureKit (same Screen Recording permission as screen sharing; `excludesCurrentProcessAudio` so Genita never hears herself) and sends it as client frames of kind 4 (genita-server `PROTOCOL.md`, "Interpretation"). The server translates and `InterpretAudioOutput` plays it quietly on the system output — the user's headphones.
- **Your reply → their language, out loud.** While **Hold to reply** is down the mic counts (kind 3 frames); Genita says the translation through the Mac's built-in speakers, and the call app's mic carries it to the other person.
- Measured 11/2 on this Mac: 3 Korean clips played by another process (`afplay`) were captured by `CallSoundCapture`, translated and whispered back; first translation audio 0.78–1.56 s after each clip ended. Genita's own playback was not re-captured (no extra bubbles). The full server path with the call channel: `npm run smoke:interpret -- --call` (10/10 turns, p50 1.68 s from end of voice).

**Does my own voice leak into the call? Yes — documented, not solved.** FaceTime and Zoom keep the Mac mic open, so the other person hears the user's English directly, then Genita's Korean from the speakers a moment later. macOS gives an app no way to take its sound out of another app's mic input. Ways out, none built yet:
1. A virtual audio device (e.g. BlackHole) set as the call app's microphone, with Genita playing her translation into it: the other side hears only Genita. Needs a driver install; best quality.
2. Mute the call app while holding to reply and unmute for Genita's line: the other side hears only Genita, but she must be routed through the virtual device or the mute cuts her too.
3. Accept it for the demo: speak softly while holding; Genita's line follows in Korean.

Other limits to check with a real call: without headphones the whisper also goes out of the speakers into the call (the sheet warns when the output is the built-in speaker); FaceTime may duck other apps' audio during a call, which would lower Genita's speaker line; Zoom's noise suppression may treat Genita's speaker line as background noise.
