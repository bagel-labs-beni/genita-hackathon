#!/bin/sh
# Renders the Mac call window in its watch-together states (MS-1, sharing, MS-2,
# MS-3; the speaker chip is cut, D40) plus the call cue, MAC-RS a/b/half and MAC-LINK (#118, #121) to PNG with SwiftUI ImageRenderer — no screen-recording
# permission or Xcode needed (Command Line Tools are enough).
#   mac-app/Tools/watch-shots/render.sh <out-dir>     (run from the repo root)
# The yellow box at the island is ImageRenderer's placeholder for the AppKit drag handle.
set -eu
OUT="${1:?out dir}"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"  # the harness runs from its own folder
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT" "$WORK/bin"
sed 's/^@main struct GenitaMacApp/struct GenitaMacApp/' mac-app/GenitaMac/GenitaMacApp.swift > "$WORK/GenitaMacAppNoMain.swift"
# CallAudio / PCMPlayer catch AVAudioPlayerNode.play()'s ObjC exception through GenitaObjCCatch (TF 331 CRASH-1)
clang -c -fobjc-arc -isysroot "$(xcrun --sdk macosx --show-sdk-path)" -target arm64-apple-macos15.0 shared/Call/GenitaObjCCatch.m -o "$WORK/GenitaObjCCatch.o"
swiftc -parse-as-library -sdk "$(xcrun --sdk macosx --show-sdk-path)" -target arm64-apple-macos15.0 -D DEBUG \
  -import-objc-header shared/Call/Genita-Bridging-Header.h "$WORK/GenitaObjCCatch.o" \
  $(ls mac-app/GenitaMac/*.swift | grep -v GenitaMacApp.swift) mac-app/GenitaMac/Interpret/*.swift "$WORK/GenitaMacAppNoMain.swift" mac-app/Tools/watch-shots/Harness.swift \
  shared/Handoff/*.swift shared/Call/*.swift $(find shared/GenitaKit/Sources/GenitaKit -name '*.swift') \
  ios-app/Genita/AppState.swift ios-app/Genita/SharedSettingsView.swift -o "$WORK/bin/harness"
cp ios-app/Genita/Resources/*.png ios-app/Genita/Resources/*.ttf mac-app/GenitaMac/*.png "$WORK/bin/"
(cd "$WORK/bin" && ./harness "$WORK/bin" "$OUT" share-notice sharing reacting black thinking mac-rs-a mac-rs-a-why mac-rs-b mac-rs-half mac-rs-failed mac-link a02 a02-j a02-m a02-m2 a02-m2-error cs01 mac-2 mac-3 mac-4 mac-4-unpaired mac-offline mc-m launch settings c01 launch@v2 a02@v2 a02-m@v2 a02-m2@v2 cs01@v2 mac-2@v2 mac-3@v2 mac-3-paired@v2 mac-4@v2 mac-4-unpaired@v2 mac-4-resume@v2 mac-offline@v2 settings@v2 settings-call@v2 c01@v2 mc-m@v2 share-notice@v2 black@v2 mac-link@v2 mac-rs-a@v2 mac-rs-b@v2 thinking@v2 splash-out-300@v2 splash-out-1200@v2 splash-out-2500@v2 splash-out-2650@v2 splash-out-2800@v2 splash-out-2950@v2 splash-out-3100@v2 splash-out-3400@v2 splash-in-300@v2 splash-in-900@v2 splash-in-1050@v2 splash-in-1350@v2 splash-in-1800@v2)
