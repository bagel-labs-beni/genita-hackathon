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
