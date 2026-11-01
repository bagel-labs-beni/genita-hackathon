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
