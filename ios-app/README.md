# Genita · iOS hackathon app

Native SwiftUI app based on the current Genita hackathon Figma page, `526:15117`. Source Figma: https://www.figma.com/design/gwtsmRVpVmuBzrEQDfa0yX/Genita?node-id=526-15117

Open `Genita.xcodeproj`, select the **Genita** scheme and an iPhone simulator, then Run. Requires Xcode 26; deployment target iOS 18+. No package dependencies, API keys or network server required. For a physical device, select your own signing team in Xcode.

## Implemented

- Local onboarding: name → copy prompt for ChatGPT/Claude → paste and review response → image upload → voice preview/selection → quick, standard or deep personality setup → video conversation view.
- Actual system clipboard, editable response, Photos/Files image selection, local iOS speech preview, preference selection/sliders, back navigation and persisted draft/setup.
- Camera-off default, existing Figma background and controls, working conversation menu and settings. Relaunch after setup returns to the same companion screen.
- Native iOS safe areas and keyboard; the Mac demo deliberately reproduces the Figma time, status icons and Dynamic Island. Original KMU80 and Pretendard fonts are bundled.

## Integration boundary

This is a local, interactive first implementation. Apple/Google buttons explicitly offer local demo entry; they do not claim account authentication. Profile processing retains the submitted text; no remote AI inference or conversation-history access occurs. The image picker loads a real local image but does not yet generate an avatar or perform server analysis. Voice previews use installed iOS speech voices and are not the final Mira voice assets. The conversation view shows the existing design reference image; it is not a live call or working lip-sync engine. Muse Spark, existing team lip-sync and live media still need integration. A local native handoff prototype is included below.

Camera, microphone and more controls remain visually present and inactive, as explicitly excluded from this hackathon demo. There is no general text chat, end-call button, after-call results or iPhone screen sharing.

## QA

Run the Genita scheme tests in Xcode. Unit tests cover persistence, restart recovery, validation, navigation and setup branches. UI tests exercise onboarding, input state, copy feedback, choices, menu/settings and restart. `--uitesting` clears local state; debug-only `--fixture-image` injects the bundled reference image so UI navigation tests do not depend on a simulator photo library. Normal launches never inject it.

Latest local verification: reply editor outside-tap keyboard dismissal UI regression passed on iPhone 17 Pro; iOS and Mac builds passed. Build outputs, screenshots and local `.xcresult` bundles are excluded from this repository.

## Figma typography and layout correction

Current design measurements are in `DesignReference/`. `Tools/sync-design-metrics.py` generates the bundled `FigmaScreens.json` from those exported nodes. The native onboarding views use those measurements, explicit font faces and source line heights. Original full-frame Figma PNGs are QA references only, not application screen assets.

## Review corrections and native Mac window

The Xcode project includes the **GenitaMac** macOS target (macOS 15+, native glass on 26+). Mac sources live in `../mac-app/GenitaMac`. Build from this directory with `xcodebuild -project Genita.xcodeproj -target GenitaMac -configuration Debug -sdk macosx`; local build output is `build/Debug/GenitaMac.app`. Select a signing team for a distributed app. It shares fonts, imagery, the AppState model type and SettingsView with iOS, and implements the conversation/menu/screen-sharing UI. Its system sharing picker/SCStream controller is local; no screen frames are stored or transmitted to an AI service.

**Local handoff is implemented as a prototype; full conversation/session synchronization remains pending.** The paired devices exchange the rendered conversation snapshot and companion image and coordinate which device presents the conversation. iPhone and Mac still have separate local preference stores. Account, conversation context and preference synchronization, plus exclusive live camera/microphone ownership, require the live-media integration.

## Native device handoff

Conversation → **Mac으로 이동** opens pairing. Enter the six-digit code shown in Genita Mac. MultipeerConnectivity uses an encrypted local peer session; no Python/Node server or browser is required. Camera and local-network permissions are requested by the iPhone app. LiDAR-supported Pro iPhones are required for the current coordinate tracker.

The Mac briefly displays a cyan registration surface. Point the rear camera at the complete display once; after automatic registration the surface closes. Move the phone next to either display edge. Its gravity-aligned centre determines where the native Mac window appears. A stable edge contact starts the existing 3.2-second Duo effect. The Mac's **아이폰으로** action is enabled only with fresh tracking at the same side and within 4 cm of the recorded height. Leave the edge before initiating another phone→Mac transfer.

The accepted LiDAR plane, perspective-corner intersection, tilt correction and saved AR world-map algorithm are ported from `handoff-effects-lab`. Camera-centre calibration persists in UserDefaults; it is device-specific. For the current test phone, launch with `--lidar-center-down 28 --lidar-center-right -6` to migrate the accepted values. Other devices retain adjustable defaults, not that phone's calibration.

`--handoff-demo` opens the existing conversation without changing onboarding/profile state. `--handoff-code <Mac code>` pairs the test installation automatically. Normal launches preserve the onboarding flow. The actual companion image is transferred only to the explicitly paired local Mac. Camera/video calling is not implemented; ARKit uses the rear camera for spatial tracking.

The screen dimensions are derived from native pixel resolution and the known model's display density. Unknown models are explicitly rejected until their density is added; no silent iPhone-size guess is used. The Mac uses its current display's physical dimensions and logical point bounds.

Build the bundled effect after changing its TypeScript sources: `node scripts-build-handoff.mjs`. The bundled WebGL effect is rendered inside transparent native views, not a remote website. The two NameDrop audio assets remain prototype assets; their original source is recorded in ASSET-SOURCES.md. Haptics are the custom approximation from the prototype, not Apple's private haptic pattern.

## Imported AI profile prompt

The final ChatGPT/Claude prompt is embedded in `Genita/AppState.swift` and mirrored in [`../docs/profile-import/prompt-final.txt`](../docs/profile-import/prompt-final.txt). It requests an evidence-labeled, context-scoped profile of up to 800 words in one copyable text code block. The native prompt reader scrolls internally and copies the complete prompt. On compact screens the card fits above the fixed CTA. The app preserves the editable imported text; it does not perform remote profile inference.

Screen-position and height tracking are experimental prototype behavior. Build and geometry/render tests are not proof of physical tracking accuracy or live media continuity.
