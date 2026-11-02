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
swiftc -parse-as-library -sdk "$(xcrun --sdk macosx --show-sdk-path)" -target arm64-apple-macos15.0 -D DEBUG \
  $(ls mac-app/GenitaMac/*.swift | grep -v GenitaMacApp.swift) mac-app/GenitaMac/Interpret/*.swift "$WORK/GenitaMacAppNoMain.swift" mac-app/Tools/watch-shots/Harness.swift \
  shared/Handoff/*.swift shared/Call/*.swift $(find shared/GenitaKit/Sources/GenitaKit -name '*.swift') \
  ios-app/Genita/AppState.swift ios-app/Genita/SharedSettingsView.swift -o "$WORK/bin/harness"
cp ios-app/Genita/Resources/*.png ios-app/Genita/Resources/*.ttf mac-app/GenitaMac/*.png "$WORK/bin/"
(cd "$WORK/bin" && ./harness "$WORK/bin" "$OUT" share-notice sharing reacting black thinking mac-rs-a mac-rs-a-why mac-rs-b mac-rs-half mac-rs-failed mac-link a02 a02-j a02-m a02-m2 a02-m2-error cs01 mac-2 mac-3 mac-4 mac-4-unpaired mac-offline mc-m launch settings c01 mac-3@v2 mac-4-unpaired@v2 c01@v2 thinking@v2 mac-rs-b@v2)
