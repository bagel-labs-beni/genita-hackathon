#!/bin/sh
# Renders the Mac call window in its watch-together states (MS-1, sharing, MS-2,
# MS-3, FT-SPK) to PNG with SwiftUI ImageRenderer — no screen-recording
# permission or Xcode needed (Command Line Tools are enough).
#   mac-app/Tools/watch-shots/render.sh <out-dir>     (run from the repo root)
# The yellow box at the island is ImageRenderer's placeholder for the AppKit drag handle.
set -eu
OUT="${1:?out dir}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT" "$WORK/bin"
sed 's/^@main struct GenitaMacApp/struct GenitaMacApp/' mac-app/GenitaMac/GenitaMacApp.swift > "$WORK/GenitaMacAppNoMain.swift"
swiftc -parse-as-library -sdk "$(xcrun --sdk macosx --show-sdk-path)" -target arm64-apple-macos15.0 -D DEBUG \
  $(ls mac-app/GenitaMac/*.swift | grep -v GenitaMacApp.swift) "$WORK/GenitaMacAppNoMain.swift" mac-app/Tools/watch-shots/Harness.swift \
  shared/Handoff/*.swift ios-app/Genita/AppState.swift ios-app/Genita/SharedSettingsView.swift -o "$WORK/bin/harness"
cp ios-app/Genita/Resources/*.png ios-app/Genita/Resources/*.ttf mac-app/GenitaMac/*.png "$WORK/bin/"
(cd "$WORK/bin" && ./harness "$WORK/bin" "$OUT" share-notice sharing reacting black speaker)
