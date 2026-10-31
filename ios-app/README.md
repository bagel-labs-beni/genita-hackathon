# Genita · iOS hackathon app

Native SwiftUI app based on the current Genita hackathon Figma page, `526:15117`. Source Figma: https://www.figma.com/design/gwtsmRVpVmuBzrEQDfa0yX/Genita?node-id=526-15117

Open `Genita.xcodeproj`, select the **Genita** scheme and an iPhone simulator, then Run. Requires Xcode 26; deployment target iOS 18+. No package dependencies, API keys or network server required. For a physical device, select your own signing team in Xcode.

## Implemented

- Local onboarding: name → copy prompt for ChatGPT/Claude → paste and review response → image upload → voice preview/selection → quick, standard or deep personality setup → video conversation view.
- Actual system clipboard, editable response, Photos/Files image selection, local iOS speech preview, preference selection/sliders, back navigation and persisted draft/setup.
- Camera-off default, existing Figma background and controls, working conversation menu and settings. Relaunch after setup returns to the same companion screen.
- Native iOS safe areas and keyboard; the Mac demo deliberately reproduces the Figma time, status icons and Dynamic Island. Original KMU80 and Pretendard fonts are bundled.

## Integration boundary

This is a local, interactive first implementation. Apple/Google buttons explicitly offer local demo entry; they do not claim account authentication. Profile processing retains the submitted text; no remote AI inference or conversation-history access occurs. The image picker loads a real local image but does not yet generate an avatar or perform server analysis. Voice previews use installed iOS speech voices and are not the final Mira voice assets. The conversation view shows the existing design reference image; it is not a live call or working lip-sync engine. Muse Spark, existing team lip-sync, live media and cross-device handoff still need integration.

Camera, microphone and more controls remain visually present and inactive, as explicitly excluded from this hackathon demo. There is no general text chat, end-call button, after-call results or iPhone screen sharing.

## QA

Run the Genita scheme tests in Xcode. Unit tests cover persistence, restart recovery, validation, navigation and setup branches. UI tests exercise onboarding, input state, copy feedback, choices, menu/settings and restart. `--uitesting` clears local state; debug-only `--fixture-image` injects the bundled reference image so UI navigation tests do not depend on a simulator photo library. Normal launches never inject it.

Latest local verification: reply editor outside-tap keyboard dismissal UI regression passed on iPhone 17 Pro; iOS and Mac builds passed. Build outputs, screenshots and local `.xcresult` bundles are excluded from this repository.

## Figma typography and layout correction

Current design measurements are in `DesignReference/`. `Tools/sync-design-metrics.py` generates the bundled `FigmaScreens.json` from those exported nodes. The native onboarding views use those measurements, explicit font faces and source line heights. Original full-frame Figma PNGs are QA references only, not application screen assets.

## Review corrections and native Mac window

The Xcode project includes the **GenitaMac** macOS target (macOS 15+, native glass on 26+). Mac sources live in `../mac-app/GenitaMac`. Build from this directory with `xcodebuild -project Genita.xcodeproj -target GenitaMac -configuration Debug -sdk macosx`; local build output is `build/Debug/GenitaMac.app`. Select a signing team for a distributed app. It shares fonts, imagery, the AppState model type and SettingsView with iOS, and implements the conversation/menu/screen-sharing UI. Its system sharing picker/SCStream controller is local; no screen frames are stored or transmitted to an AI service.

**Cross-device integration is required and still pending.** iPhone and Mac currently have separate local stores. The same user/companion/session, preferences and conversation context must sync, and a device handoff must stop the source camera/microphone before the destination takes over. Running both local apps is not evidence of that integration.
