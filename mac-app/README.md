# Genita · Mac app

Native macOS hackathon app. Sources are in `GenitaMac/`; the shared Xcode project is [`../ios-app/Genita.xcodeproj`](../ios-app/Genita.xcodeproj).

Open that project and choose the **GenitaMac** target. Requires Xcode 26, macOS 15+; native glass is used on macOS 26+.

```sh
cd ios-app
xcodebuild -project Genita.xcodeproj -target GenitaMac -configuration Debug -sdk macosx CODE_SIGNING_ALLOWED=NO
```

Run these commands from the repository root. Output: `ios-app/build/Debug/GenitaMac.app`. Choose a signing team for device distribution.

Fonts, original Figma imagery, `AppState` and settings are shared with `ios-app`. The native window includes the requested Figma 9:41 time, status icons and Dynamic Island, glass controls, menu, settings, screen-sharing permission UI, system content picker and local SCStream capture. Screen frames are neither stored nor sent to AI.

Cross-device account/session synchronization, exclusive camera/microphone handoff, Muse Spark and live lip-sync are still pending. The debug sharing preview renders the active design without recording the screen.

## Native iPhone handoff

The Mac app now opens a pairing/control window. Pair from the iPhone's **Mac으로 이동** using the code. Registration uses a native full-display cyan surface; handoff uses a separate transparent, floating NSWindow over the real desktop. No browser or separately running server is required.

Only the Mac that owns the transferred conversation shows the existing screen-sharing control. Starting a return transition removes that conversation view and stops SCStream. Capture still remains local; there is no video-call backend or remote screen-frame transport. The iPhone never exposes a screen-sharing control.

For return, hold the phone at the recorded edge/height and click **아이폰으로** on the conversation or control window. The window moves to the edge during the shared preparation interval, then the original Duo effect continues on both devices with clock-offset synchronization. Stale tracking, disconnection and a missing preparation acknowledgment prevent transfer. Tracking loss alone does not move an already transferred window.

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

After arrival, drag the black island at the top of the conversation to move the native window. The position timer leaves a settled window alone. Returning to iPhone interpolates from the dragged position back to the recorded screen edge during the shared preparation interval; it does not teleport back first.

The native conversation stays visible until WebGL reports the first rendered frame for the current transition ID. Cancellation/stale IDs cannot hide the current conversation. The framebuffer smoke test also requires this rendered-frame acknowledgment. Handoff no longer changes AVAudioSession category/routing: a future live conversation must own that audio session. Live media continuity itself is not implemented by this prototype.

The current checks cover builds, geometry and native WebGL rendering; they do not establish physical tracking accuracy, end-to-end hardware pairing reliability or live call continuity. Full profile/preferences/session synchronization remains separate from this local visual handoff.
