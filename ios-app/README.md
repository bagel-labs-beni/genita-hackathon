# Genita · iOS hackathon app

Native SwiftUI app based on the current Genita hackathon Figma page, `526:15117`. Source Figma: https://www.figma.com/design/gwtsmRVpVmuBzrEQDfa0yX/Genita?node-id=526-15117

Open `Genita.xcodeproj`, select the **Genita** scheme and an iPhone simulator, then Run. Requires Xcode 26; deployment target iOS 18+. No package dependencies, API keys or network server required. For a physical device, select your own signing team in Xcode.

## Implemented

- Local onboarding: name → copy prompt for ChatGPT/Claude → paste and review response → image upload → voice preview/selection → quick, standard or deep personality setup → video conversation view.
- Actual system clipboard, editable response, Photos/Files image selection, local iOS speech preview, preference selection/sliders, back navigation and persisted draft/setup.
- Camera-off default, existing Figma background and controls, working conversation menu and settings. Relaunch after setup returns to the same companion screen.
- Native iOS safe areas and keyboard; the Mac demo deliberately reproduces the Figma time, status icons and Dynamic Island. Original KMU80 and Pretendard fonts are bundled.

## Integration boundary

This is a local, interactive first implementation. Apple/Google buttons explicitly offer local demo entry; they do not claim account authentication. Profile processing retains the submitted text; no remote AI inference or conversation-history access occurs. The image picker loads a real local image but does not yet generate an avatar or perform server analysis. Voice previews use installed iOS speech voices and are not the final Mira voice assets. The conversation view shows the existing design reference image; it is not a live call or working lip-sync engine. Muse Spark, the existing lip-sync engine and live media still need integration. A local native handoff prototype is included below.

The camera and microphone buttons work locally: each asks for permission, the camera shows your self preview with a flip button, and a denied permission shows the Figma E01 or E02 sheet. Nothing is stored or sent, because the conversation itself does not exist yet. The camera is off by default. While the self preview is on, position tracking stops, because the two cannot use the camera at once; Move to Mac still works. The ⋮ button has no action yet. There is no general text chat, end-call button, after-call results or iPhone screen sharing.

## QA

Run the Genita scheme tests in Xcode. Unit tests cover persistence, restart recovery, validation, navigation, setup branches and conversation ownership. UI tests exercise onboarding, input state, copy feedback, choices, menu/settings, restart, and the handoff and permission sheets. `.github/workflows/apple-build.yml` builds both apps, runs the unit tests and the handoff UI tests on every pull request that touches them, and uploads screenshots as the `handoff-screens` artifact. Debug-only `--handoff-state r1|r1e` and `--media-state camera-denied|mic-denied` open those screens without a Mac. `--uitesting` clears local state; debug-only `--fixture-image` injects the bundled reference image so UI navigation tests do not depend on a simulator photo library. Normal launches never inject it.

Build outputs, screenshots and local `.xcresult` bundles are excluded from this repository.

## Figma typography and layout correction

Current design measurements are in `DesignReference/`. `Tools/sync-design-metrics.py` generates the bundled `FigmaScreens.json` from those exported nodes. The native onboarding views use those measurements, explicit font faces and source line heights. Original full-frame Figma PNGs are QA references only, not application screen assets.

## Review corrections and native Mac window

The Xcode project includes the **GenitaMac** macOS target (macOS 15+, native glass on 26+). Mac sources live in `../mac-app/GenitaMac`. Build from this directory with `xcodebuild -project Genita.xcodeproj -target GenitaMac -configuration Debug -sdk macosx`; local build output is `build/Debug/GenitaMac.app`. Select a signing team for a distributed app. It shares fonts, imagery, the AppState model type and SettingsView with iOS, and implements the conversation/menu/screen-sharing UI. Its system sharing picker/SCStream controller is local; no screen frames are stored or transmitted to an AI service.

**The actual conversation does not exist yet.** Handoff moves which device presents the conversation screen, with a rendered snapshot and the companion image. There is no server, account, voice, video or conversation sync. iPhone and Mac keep separate local preference stores.

## Native device handoff

### Who has the conversation

`shared/Handoff/ConversationOwnership.swift` is the one place that decides. Each device stores an owner and an increasing epoch. A claim with a newer epoch wins, so a device that comes back with an old epoch adopts the newer owner and moves to its waiting screen. Losing the link, or the app going to the background or being locked, never changes the owner. Today claims travel over the local link; a server replaces that by implementing `OwnershipTransport`.

### Moving

- **First pairing:** Menu → **Move to Mac** asks for the six-digit code shown in Genita on the Mac, once. The Mac then gives this iPhone a token and it reconnects by itself. MultipeerConnectivity uses an encrypted local session, but it does not authenticate the peer, so this is a local prototype, not a security boundary. The token is kept in UserDefaults. Settings → **Mac pairing** can register the screen or forget the Mac.
- **Any iPhone:** Menu → **Move to Mac** moves the conversation with a simple transition and needs no LiDAR. iPhone models without LiDAR or with an unknown display size use only this button. If the Mac doesn't answer within 5 seconds the conversation stays here and an alert says so.
- **LiDAR iPhones, optional:** after registering the screen once (the Mac shows a teal surface; point the rear camera at the whole display), bringing the phone next to a display edge starts the same move with the 3.2-second Duo effect. Leave the edge before starting another one.

### After the move

The iPhone shows the R1 sheet and stops ARKit, the rear camera, the microphone and the self preview. **Continue here** brings the conversation back in one tap, with no edge or distance condition. If the Mac can't be reached the sheet becomes R1-E, and the same tap works without the Mac; the Mac moves to its waiting screen when it reconnects. Opening the app alone never moves anything.

Because tracking is off in R1, the Duo effect does not play on the way back to the iPhone in practice. It remains available when the Mac taps **Continue here** with the phone tracking at the recorded edge.

The accepted LiDAR plane, perspective-corner intersection, tilt correction and saved AR world-map algorithm are ported from `handoff-effects-lab`. Camera-centre calibration persists in UserDefaults; it is device-specific. For the current test phone, launch with `--lidar-center-down 28 --lidar-center-right -6` to migrate the accepted values. Other devices retain adjustable defaults, not that phone's calibration.

`--handoff-demo` opens the existing conversation without changing onboarding/profile state. `--handoff-code <Mac code>` pairs the test installation automatically. Normal launches preserve the onboarding flow. The actual companion image is transferred only to the paired local Mac.

The screen dimensions are derived from native pixel resolution and the known model's display density. No silent iPhone-size guess is used: an unknown model simply has no position effect. The Mac uses its current display's physical dimensions and logical point bounds.

Build the bundled effect after changing its TypeScript sources: `node scripts-build-handoff.mjs`. The bundled WebGL effect is rendered inside transparent native views, not a remote website. The two Genita handoff sounds are original; see ASSET-SOURCES.md. Haptics are the custom approximation from the prototype, not Apple's private haptic pattern.

## Imported AI profile prompt

The final ChatGPT/Claude prompt is embedded in `Genita/AppState.swift` and mirrored in [`../docs/profile-import/prompt-final.txt`](../docs/profile-import/prompt-final.txt). It requests an evidence-labeled, context-scoped profile of up to 800 words in one copyable text code block. The native prompt reader scrolls internally and copies the complete prompt. On compact screens the card fits above the fixed CTA. The app preserves the editable imported text; it does not perform remote profile inference.

Screen-position and height tracking are experimental prototype behavior. Build, unit and simulator tests are not proof of physical tracking accuracy, pairing on real devices or live media continuity.
